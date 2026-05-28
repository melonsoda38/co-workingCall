import type { BaseMessageOptions, MessageCreateOptions } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig, TimerPhase, TimerSnapshot } from '@co-working-call/shared';
import { buildStartEmbedMessage } from './start-embed.js';
import { buildTimerEmbedContent, buildTimerEmbedMessage } from './timer-embed.js';
import { RepostDebouncer } from './repost-debouncer.js';
import { TimerEmbedUpdater } from './timer-embed-updater.js';
import { buildFarewellMessage, FAREWELL_CONTENT } from './farewell-message.js';
import { buildWelcomeMessage, WELCOME_CONTENT } from './welcome-message.js';
import {
  playPhaseTransitionSound,
  phaseTransitionSound,
  type PhaseSoundNotifier,
} from './sound-notifier.js';

/**
 * ending-spec の余韻待機時間 (お疲れさま投稿から VC 全員強制退出までの間隔)。
 * finish.mp3 は 4 秒の音源だが、待機 3 秒に短縮しているため再生途中で disconnect する。
 */
export const ENDING_DELAY_MS = 3_000;

/** お疲れさま投稿を削除するまでの遅延 (投稿から 30 秒)。 */
export const FAREWELL_DELETE_DELAY_MS = 30_000;

/**
 * 終了演出 (US-19) で EmbedManager が呼ぶ外部操作 (VC 系の責務)。
 * 注入により EmbedManager を Discord 非依存に保つ。未注入なら no-op。
 */
export interface EndingActions {
  /** VC 内の人間メンバー全員を切断する (順次 await、失敗は best-effort)。 */
  kickAllHumans(): Promise<void>;
  /** bot 自身を即時退出させる (VoiceManager.forceDisconnect 相当)。 */
  disconnectBot(): void;
}

/** 余韻待機などの遅延関数 (本番は ENDING_DELAY_MS=3秒)。テストで vi.useFakeTimers と差し替えるための注入点。 */
export type EndingDelay = (ms: number) => Promise<void>;

const defaultEndingDelay: EndingDelay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 投稿済みメッセージ (id のみ必要)。 */
export interface PostedMessage {
  id: string;
}

/** Embed 投稿/編集/削除の抽象 (実 Discord VoiceChannel は discord/ でラップ)。 */
export interface EmbedChannel {
  post(options: MessageCreateOptions): Promise<PostedMessage>;
  edit(messageId: string, options: BaseMessageOptions): Promise<void>;
  delete(messageId: string): Promise<void>;
  /**
   * VCテキスト欄から bot 自身が投稿した過去の Embed 付きメッセージを掃除する。
   * 新規 Embed 投稿の直前に呼び、追跡漏れ (異常終了・/pomo init 連打・旧VC残骸) も
   * 含めて「テキスト欄に Embed は常に 1 つ」を保証する。best-effort。
   */
  purgeOwnEmbeds(): Promise<void>;
  /**
   * bot 自身が投稿した「指定本文のプレーンテキスト」(歓迎/お疲れさま) を掃除する。
   * id 追跡を失った孤児 (異常終了・再起動) を本文一致で回収する。best-effort。
   */
  purgeOwnTexts(contents: string[]): Promise<void>;
}

/** EmbedManager が必要とするタイマーの最小インターフェース (PomodoroTimer 互換)。 */
export interface TimerLike {
  getSnapshot(): TimerSnapshot;
  on(
    event: 'phaseChange' | 'countdown' | 'ended',
    listener: (snapshot: TimerSnapshot) => void,
  ): unknown;
  /**
   * タイマー内部状態を idle に戻す。終了演出の SessionState リセット工程で呼ぶ。
   * 自然 ended では PomodoroTimer は phase='ended' と #startedAt を保持する設計のため、
   * これを呼ばないと次の ▶開始ボタンで getSnapshot().phase !== 'idle' に弾かれる。
   */
  reset(): void;
}

export interface EmbedManagerDeps {
  channel: EmbedChannel;
  timer: TimerLike;
  config: BotConfig;
  logger: Logger;
  /** フェーズ切替・終了予告・終了音の通知音 (US-15 で実 SoundPlayer を注入。未指定なら無音)。 */
  soundNotifier?: PhaseSoundNotifier;
  /** 終了演出 (US-19) で呼ぶ VC 系外部操作。未指定なら kick/退出はスキップ (テスト用)。 */
  endingActions?: EndingActions;
  /** 余韻待機関数 (テスト差し替え用、既定は setTimeout)。 */
  endingDelay?: EndingDelay;
}

/**
 * messageCreate を EmbedManager に流すかの判定 (Discord 非依存・純粋)。
 * bot 自身は除外、対象 VC 内蔵テキストチャンネルのみ (embed-spec §トリガー)。
 */
export function shouldHandleHumanMessage(params: {
  authorIsBot: boolean;
  channelId: string;
  targetChannelId: string;
}): boolean {
  return !params.authorIsBot && params.channelId === params.targetChannelId;
}

/**
 * 3種の Embed ライフサイクルを統合する (embed-spec EmbedManager 設計指針)。
 * US-11 でフェーズ切替の強制リセット (通知音 → 削除&再投稿 → デバウンスclear →
 * 5秒更新リセット) を完成。終了演出の VC 退出等 (US-19) は後続。
 */
export class EmbedManager {
  readonly #channel: EmbedChannel;
  readonly #timer: TimerLike;
  #config: BotConfig;
  readonly #logger: Logger;
  readonly #debouncer: RepostDebouncer;
  readonly #soundNotifier: PhaseSoundNotifier | undefined;
  readonly #endingActions: EndingActions | undefined;
  readonly #endingDelay: EndingDelay;
  /**
   * EmbedManager 自身が追跡するフェーズ。PomodoroTimer も内部に現在フェーズを持つが、
   * EmbedManager はフェーズ切替音 (from→to) と countdown 二重発火ガードのために
   * 「直前フェーズ」の記憶が必要なため独立に保持する (timer のイベントは現在値のみ渡す)。
   * 整合の前提: PomodoroTimer は 1 tick 内で必ず phaseChange を先に emit してから
   * countdown/ended を emit する (pomodoro-timer.ts #tick)。この順序により
   * #onPhaseChange → onCountdownEnter/onEnded の順で #currentPhase が更新される。
   */
  #currentPhase: TimerPhase = 'idle';
  #startEmbedId: string | null = null;
  #timerEmbedId: string | null = null;
  /**
   * タイマー開始時の「ご参加ありがとう」投稿 ID。Embed なしプレーンテキストで
   * purgeOwnEmbeds の対象外のため、終了演出 (onEnded) / 強制停止 (onIdle) で
   * 明示的に delete する。
   */
  #welcomeMessageId: string | null = null;
  /** お疲れさま投稿の遅延削除 (投稿30秒後) 用タイマー。 */
  #farewellDeleteTimer: NodeJS.Timeout | null = null;
  #updater: TimerEmbedUpdater | null = null;
  /** 終了演出の二重発火防止 (ended イベントと空 VC 退出など複数経路から起動し得る)。 */
  #isEnding = false;

  constructor(deps: EmbedManagerDeps) {
    this.#channel = deps.channel;
    this.#timer = deps.timer;
    this.#config = deps.config;
    this.#logger = deps.logger;
    this.#soundNotifier = deps.soundNotifier;
    this.#endingActions = deps.endingActions;
    this.#endingDelay = deps.endingDelay ?? defaultEndingDelay;
    this.#debouncer = new RepostDebouncer({
      callback: () => this.#repostTimerEmbed(),
      onError: (err) => {
        this.#logger.error({ err }, 'Embed 再投稿に失敗しました');
      },
    });

    this.#timer.on('phaseChange', (snapshot) => {
      void this.#onPhaseChange(snapshot);
    });
    this.#timer.on('countdown', () => {
      void this.onCountdownEnter();
    });
    this.#timer.on('ended', () => {
      void this.onEnded();
    });
  }

  get startEmbedId(): string | null {
    return this.#startEmbedId;
  }
  get timerEmbedId(): string | null {
    return this.#timerEmbedId;
  }
  get welcomeMessageId(): string | null {
    return this.#welcomeMessageId;
  }
  /** 終了演出フロー進行中か (▶開始の二重起動防止に commands 側から参照)。 */
  get isEnding(): boolean {
    return this.#isEnding;
  }

  /** idle: スタート用 Embed を投稿 (タイマー用・既存スタート用が残っていれば削除)。 */
  async onIdle(): Promise<void> {
    this.#updater?.stop();
    this.#updater = null;
    this.#debouncer.cancel();
    this.#cancelFarewellDeletion();
    this.#currentPhase = 'idle';
    await this.#deleteTimerEmbed();
    // /pomo stop など onEnded を経由しない経路でも welcome を残さない。
    await this.#deleteWelcomeMessage();
    // 歓迎/お疲れさまの孤児プレーンテキスト (id 追跡漏れ・前回 ended の残り) を本文一致で掃除。
    await this.#channel.purgeOwnTexts([WELCOME_CONTENT, FAREWELL_CONTENT]);
    // 既存スタート Embed を消してから出し直す (/pomo stop の重複投稿防止・冪等化)。
    await this.#deleteStartEmbed();
    const posted = await this.#postFresh(buildStartEmbedMessage(this.#config));
    this.#startEmbedId = posted.id;
  }

  /**
   * タイマー開始: スタート削除 → タイマー用投稿 → 5秒更新開始 → 歓迎投稿。
   * 歓迎投稿はタイマー Embed の後にチャンネル最下部へ置き、終了演出 / onIdle で削除する。
   */
  async onTimerStart(): Promise<void> {
    this.#currentPhase = 'work';
    // 前回 ended のお疲れさま (30秒削除待ち) や、再起動で id 追跡を失った孤児の
    // 歓迎/お疲れさまテキストを、新セッションの歓迎投稿前に掃除する。
    this.#cancelFarewellDeletion();
    await this.#channel.purgeOwnTexts([WELCOME_CONTENT, FAREWELL_CONTENT]);
    await this.#deleteStartEmbed();
    const snapshot = this.#timer.getSnapshot();
    const posted = await this.#postFresh(buildTimerEmbedMessage(snapshot, this.#config));
    this.#timerEmbedId = posted.id;
    this.#startUpdater();
    await this.#postWelcome();
  }

  /** 人間メッセージ検知: work/break/finalBreak のみデバウンス開始。 */
  onHumanMessage(): void {
    const { phase } = this.#timer.getSnapshot();
    if (phase === 'work' || phase === 'break' || phase === 'finalBreak') {
      this.#debouncer.trigger();
    }
  }

  /**
   * countdown 突入: 終了予告音 (US-18) → 再投稿 OFF・5秒更新停止 → countdown 表示に edit。
   * countdown フェーズは仕様上 1 回のみ突入 (ending-spec §第一段階)。timer 側の
   * 二重発火に備えて currentPhase ガードで countdown_warning.mp3 の二重再生を防ぐ。
   */
  async onCountdownEnter(): Promise<void> {
    if (this.#currentPhase === 'countdown') {
      // 二重発火: 既に countdown 突入処理を実施済みなので no-op。
      return;
    }
    this.#currentPhase = 'countdown';
    this.#logger.info('countdown 突入: 終了予告音を再生し 5秒更新を停止');
    this.#soundNotifier?.playCountdownWarning();
    // 「ご参加ありがとう」投稿は countdown 突入時 (終了予告音の直後) に削除する。
    // onEnded / onIdle の削除はこれより手前で抜ける経路 (空 VC 早期退出・/pomo stop) 用の保険。
    await this.#deleteWelcomeMessage();
    this.#debouncer.cancel();
    this.#updater?.stop();
    if (this.#timerEmbedId !== null) {
      const snapshot = this.#timer.getSnapshot();
      await this.#channel.edit(this.#timerEmbedId, buildTimerEmbedContent(snapshot, this.#config));
    }
  }

  /**
   * ended: 終了演出フロー (ending-spec §第二段階・US-19)。
   * finish.mp3 → タイマー Embed 削除 → お疲れさま投稿 → 3秒余韻 →
   * VC 全員強制退出 → bot 退出 → 新スタート Embed 投稿 → idle 復帰。
   *
   * 二重発火防止 (#isEnding): ended イベント + 空 VC 30 秒退出など複数経路から
   * 同時起動し得るため、最初の 1 回のみ通す。
   * エラー時も必ず #isEnding を解除し、可能なら idle 復帰 (スタート Embed 再投稿) を試みる。
   */
  async onEnded(): Promise<void> {
    if (this.#isEnding) {
      this.#logger.debug('ended 二重発火を握りつぶし (#isEnding ガード)');
      return;
    }
    this.#isEnding = true;
    this.#logger.info('終了演出フロー開始 (ending-spec §第二段階)');
    this.#updater?.stop();
    this.#updater = null;
    this.#debouncer.cancel();
    try {
      // 1. 終了音 (4 秒、非同期で開始)。
      this.#logger.info('finish.mp3 再生開始');
      this.#soundNotifier?.playFinish();
      // 2. タイマー Embed 削除。
      await this.#deleteTimerEmbed();
      // 3. お疲れさま投稿 (通常通知・SuppressNotifications なし)。
      //    Embed なしの単発テキストで、投稿から 30 秒後に削除する (新スタート Embed と
      //    しばらく併存させる)。削除は終了演出フローをブロックしないよう setTimeout で予約。
      const farewell = await this.#channel.post(buildFarewellMessage());
      this.#logger.info({ messageId: farewell.id }, 'お疲れさま投稿 完了');
      this.#scheduleFarewellDeletion(farewell.id);
      // 4. finish.mp3 を最後まで聞かせる余韻待機。
      this.#logger.info({ ms: ENDING_DELAY_MS }, '余韻待機');
      await this.#endingDelay(ENDING_DELAY_MS);
      // 5. VC 内の人間メンバー全員を強制退出 (未注入ならスキップ)。
      if (this.#endingActions) {
        try {
          await this.#endingActions.kickAllHumans();
          this.#logger.info('VC 全員強制退出 完了');
        } catch (err) {
          this.#logger.warn({ err }, 'VC 全員強制退出に失敗 (best-effort)');
        }
        // 6. bot 自身を即時退出 (カウントダウン経由しない)。
        try {
          this.#endingActions.disconnectBot();
          this.#logger.info('bot VC 退出 完了');
        } catch (err) {
          this.#logger.warn({ err }, 'bot の VC 退出に失敗 (best-effort)');
        }
      }
      // 7. お疲れさま投稿の削除は step 3 で予約済み (投稿30秒後)。ここでは行わない。
      // ご参加ありがとう投稿は通常 countdown 突入時に削除済み。countdown を経ず
      // ここへ来る経路 (空 VC 早期退出) の保険として再度削除を試みる (済みなら no-op)。
      await this.#deleteWelcomeMessage();
      // 8. SessionState 相当のリセット。
      //    PomodoroTimer は ended 到達で interval は停止するが #startedAt/#currentPhase='ended' を
      //    保持する設計のため、明示的に reset() を呼ばないと次の ▶開始で
      //    getSnapshot().phase !== 'idle' に弾かれて「すでに動作中」と誤判定される。
      //    updater/debouncer は既にクリア済み。
      this.#timer.reset();
      this.#currentPhase = 'idle';
      // 9. 新スタート Embed 投稿 → idle に戻る。
      const posted = await this.#postFresh(buildStartEmbedMessage(this.#config));
      this.#startEmbedId = posted.id;
      this.#logger.info('終了演出フロー完了 idle 復帰');
    } finally {
      this.#isEnding = false;
    }
  }

  /**
   * 設定モーダル保存後に Start Embed を最新 config で投稿し直す (US-12 結線)。
   * 既存 Start Embed があれば削除してから #postFresh (purge → post) で再投稿し、
   * 「変更を保存しました」ephemeral の直後にチャンネル最下部へ最新版 Embed を露出させる。
   *
   * Start Embed が存在しない (タイマー稼働中で削除済み・初期化未済) 場合は config 反映
   * のみで no-op。次回 idle 復帰時 (onIdle / 終了演出末尾) に最新 config で投稿される。
   * 終了演出進行中 (#isEnding) も冪等のため再投稿は行わない (終了演出末尾で投稿される)。
   */
  async repostStartEmbed(config: BotConfig): Promise<void> {
    this.#config = config;
    if (this.#startEmbedId === null || this.#isEnding) {
      return;
    }
    await this.#deleteStartEmbed();
    const posted = await this.#postFresh(buildStartEmbedMessage(this.#config));
    this.#startEmbedId = posted.id;
  }

  /**
   * 外部 (/pomo init) が投稿済みのスタート Embed を採用し、以後の削除対象にする。
   * EmbedManager がライフサイクルを所有していない単発スタート Embed を ▶開始時に
   * 確実に削除するためのフック (Discord 通信は伴わない)。
   */
  adoptStartEmbed(messageId: string): void {
    this.#startEmbedId = messageId;
  }

  /**
   * config を差し替える (Discord 通信なし)。▶開始時に config.json の最新値を
   * 反映してからタイマー Embed を投稿するために使う。Embed の再描画は伴わない。
   */
  applyConfig(config: BotConfig): void {
    this.#config = config;
  }

  /**
   * 起動時などに、id 追跡を持たない孤児の歓迎/お疲れさまプレーンテキストを掃除する。
   * bot 異常終了・再起動で id を失った残骸 (例: 終了30秒前の再起動で残るお疲れさま投稿) を
   * 本文一致で回収する。アクティブセッションが無い前提で呼ぶ (起動直後・idle)。best-effort。
   */
  async purgeOrphanTexts(): Promise<void> {
    await this.#channel.purgeOwnTexts([WELCOME_CONTENT, FAREWELL_CONTENT]);
  }

  async #onPhaseChange(snapshot: TimerSnapshot): Promise<void> {
    const to = snapshot.phase;
    if (to !== 'work' && to !== 'break' && to !== 'finalBreak') {
      // countdown/ended/idle は専用ハンドラで処理する。
      return;
    }
    const from = this.#currentPhase;
    this.#currentPhase = to;

    if (this.#timerEmbedId === null) {
      // 初回 (idle→work): スタート削除 → タイマー投稿 (通知音なし)。
      this.#logger.info({ to, currentSet: snapshot.currentSet }, 'タイマー初回フェーズ突入');
      await this.onTimerStart();
      return;
    }

    // 中間切替 (work↔break, work→finalBreak) の強制リセット (embed-spec §フェーズ切替):
    // 1. 通知音 → 2-3. 旧Embed削除&新Embed投稿 → 4. デバウンスclear → 5. 5秒更新リセット。
    this.#logger.info({ from, to, currentSet: snapshot.currentSet }, 'フェーズ切替');
    if (this.#soundNotifier) {
      playPhaseTransitionSound(this.#soundNotifier, phaseTransitionSound(from, to));
    }
    this.#debouncer.cancel();
    await this.#repostTimerEmbed();
    this.#startUpdater();
  }

  async #repostTimerEmbed(): Promise<void> {
    // 表示フェーズ (work/break/finalBreak) 以外では貼り直さない。
    // デバウンス flush は cancel() で止められない (in-flight)。countdown/ended/idle へ
    // 遷移した後にデバウンス再投稿が走ると、ended の「-」表示 Embed を孤児として
    // post したり、purgeOwnEmbeds がスタート Embed を巻き込む等の不整合を生む。
    // 実フェーズを確認し、表示フェーズ外なら no-op にして遷移ハンドラ側の Embed を尊重する。
    const { phase } = this.#timer.getSnapshot();
    if (phase !== 'work' && phase !== 'break' && phase !== 'finalBreak') {
      return;
    }
    await this.#deleteTimerEmbed();
    const snapshot = this.#timer.getSnapshot();
    const posted = await this.#postFresh(buildTimerEmbedMessage(snapshot, this.#config));
    this.#timerEmbedId = posted.id;
  }

  /**
   * 新規 Embed 投稿の共通入口。直前に purgeOwnEmbeds で過去 Embed を掃除してから post。
   * これで「テキスト欄に bot 自身の Embed は常に 1 つ」を保証する。
   * id 追跡 (#startEmbedId / #timerEmbedId) と purge による掃除の二重防御。
   */
  async #postFresh(options: MessageCreateOptions): Promise<PostedMessage> {
    await this.#channel.purgeOwnEmbeds();
    return this.#channel.post(options);
  }

  #startUpdater(): void {
    this.#updater?.stop();
    const message = {
      edit: (options: BaseMessageOptions): Promise<unknown> => {
        if (this.#timerEmbedId === null) {
          return Promise.resolve();
        }
        return this.#channel.edit(this.#timerEmbedId, options);
      },
    };
    this.#updater = new TimerEmbedUpdater(message, this.#timer, this.#config, (err) => {
      this.#logger.error({ err }, 'タイマー Embed 更新に失敗しました');
    });
    this.#updater.start();
  }

  async #deleteStartEmbed(): Promise<void> {
    if (this.#startEmbedId !== null) {
      const id = this.#startEmbedId;
      this.#startEmbedId = null;
      await this.#tryDelete(id);
    }
  }

  async #deleteTimerEmbed(): Promise<void> {
    if (this.#timerEmbedId !== null) {
      const id = this.#timerEmbedId;
      this.#timerEmbedId = null;
      await this.#tryDelete(id);
    }
  }

  async #tryDelete(messageId: string): Promise<void> {
    try {
      await this.#channel.delete(messageId);
    } catch (err) {
      this.#logger.warn({ err, messageId }, 'Embed 削除に失敗 (best-effort)');
    }
  }

  /**
   * お疲れさま投稿を投稿から FAREWELL_DELETE_DELAY_MS (30秒) 後に削除する (best-effort)。
   * 終了演出フローはブロックせず setTimeout で予約する。削除失敗は warn のみ。
   * 二重 ended は #isEnding で防いでいるため通常は同時に 1 つだけだが、念のため
   * 直前の予約が残っていれば破棄して上書きする。
   */
  /** 予約済みのお疲れさま遅延削除タイマーを解除する (新セッション開始・idle 復帰時)。 */
  #cancelFarewellDeletion(): void {
    if (this.#farewellDeleteTimer !== null) {
      clearTimeout(this.#farewellDeleteTimer);
      this.#farewellDeleteTimer = null;
    }
  }

  #scheduleFarewellDeletion(messageId: string): void {
    if (this.#farewellDeleteTimer !== null) {
      clearTimeout(this.#farewellDeleteTimer);
    }
    this.#farewellDeleteTimer = setTimeout(() => {
      this.#farewellDeleteTimer = null;
      void this.#channel
        .delete(messageId)
        .then(() => {
          this.#logger.info({ messageId }, 'お疲れさま投稿を削除 (投稿30秒後)');
        })
        .catch((err: unknown) => {
          this.#logger.warn({ err, messageId }, 'お疲れさま投稿の削除に失敗 (best-effort)');
        });
    }, FAREWELL_DELETE_DELAY_MS);
  }

  /**
   * 歓迎投稿を post し ID を保持する。
   * 投稿失敗は best-effort (warn のみ): タイマー自体の進行を妨げないようにする。
   */
  async #postWelcome(): Promise<void> {
    try {
      const welcome = await this.#channel.post(buildWelcomeMessage());
      this.#welcomeMessageId = welcome.id;
      this.#logger.info({ messageId: welcome.id }, 'ご参加ありがとう投稿 完了');
    } catch (err) {
      this.#logger.warn({ err }, 'ご参加ありがとう投稿に失敗 (best-effort)');
    }
  }

  /** 歓迎投稿を削除し ID をクリア。未投稿なら no-op。削除失敗は best-effort。 */
  async #deleteWelcomeMessage(): Promise<void> {
    if (this.#welcomeMessageId === null) {
      return;
    }
    const id = this.#welcomeMessageId;
    this.#welcomeMessageId = null;
    try {
      await this.#channel.delete(id);
      this.#logger.info({ messageId: id }, 'ご参加ありがとう投稿を削除');
    } catch (err) {
      this.#logger.warn({ err, messageId: id }, 'ご参加ありがとう投稿の削除に失敗 (best-effort)');
    }
  }
}
