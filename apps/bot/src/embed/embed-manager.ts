import type { BaseMessageOptions, MessageCreateOptions } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig, TimerPhase, TimerSnapshot } from '@co-working-call/shared';
import { buildStartEmbedMessage } from './start-embed.js';
import { RepostDebouncer } from './repost-debouncer.js';
import { TimerEmbedController } from './timer-embed-controller.js';
import { buildFarewellMessage, FAREWELL_CONTENT } from './farewell-message.js';
import { buildAutoStartResetMessage } from './auto-start-message.js';
import { buildTimeoutMessage, TIMEOUT_CONTENT } from './timeout-message.js';
import { buildJoinGreetingMessage } from './join-greeting-message.js';
import { ContinueSessionState } from './continue-session-state.js';
import { EndingFollowupScheduler } from './ending-followup-scheduler.js';
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

/** お疲れさま投稿を削除するまでの遅延 (投稿から 15 秒)。 */
export const FAREWELL_DELETE_DELAY_MS = 15_000;

/**
 * 「続行」継続セッションの上限 (セッション開始から 23 時間)。US-続行。
 * 続行でタイマーが翌日まで続き新セッションを開始できなくなるのを防ぐ強制終了キャップ。
 */
export const CONTINUE_MAX_SESSION_MS = 23 * 60 * 60 * 1000;

/** onEnded を呼ぶ理由。timeout23h は 23時間キャップ起因 (投稿文言が変わる)。 */
export type EndingReason = 'normal' | 'timeout23h';

/**
 * 終了演出 (US-19) で EmbedManager が呼ぶ外部操作 (VC 系の責務)。
 * 注入により EmbedManager を Discord 非依存に保つ。未注入なら no-op。
 */
export interface EndingActions {
  /** VC 内の人間メンバー全員を切断する (順次 await、失敗は best-effort)。 */
  kickAllHumans(): Promise<void>;
  /**
   * VC 内の人間メンバーのうち except に含まれない ID だけを切断する (US-続行)。
   * 「続行」を押したユーザは残し、押していないユーザのみ退出させるために使う。
   */
  kickHumansExcept(except: ReadonlySet<string>): Promise<void>;
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
   * bot 自身が投稿した「指定本文のプレーンテキスト」(お疲れさま/23時間終了) を掃除する。
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
  /**
   * 「続行」継続モードで開始する (US-続行)。開始時の作業/休憩時間で work/break を
   * 無限ループし countdown/ended を発火しない。最終休憩終了時の継続移行で呼ぶ。
   * baseSets は継続開始までに実施済みの作業セット数 (元セッションの sets)。
   */
  startContinuous(workSec: number, breakSec: number, baseSets: number): void;
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
  /** タイマー Embed のライフサイクル (投稿/貼り直し/5秒更新/countdown edit/削除) を委譲するコントローラ。 */
  readonly #timerEmbed: TimerEmbedController;
  /** 終了演出の二重発火防止 (ended イベントと空 VC 退出など複数経路から起動し得る)。 */
  #isEnding = false;
  /** 「続行」継続セッションの状態と 23時間キャップ (US-続行)。 */
  readonly #continueState: ContinueSessionState;
  /** 終了演出のフォローアップ (お疲れさま削除 → 新スタート Embed 投稿) の遅延予約。 */
  readonly #followup = new EndingFollowupScheduler(FAREWELL_DELETE_DELAY_MS);

  constructor(deps: EmbedManagerDeps) {
    this.#channel = deps.channel;
    this.#timer = deps.timer;
    this.#config = deps.config;
    this.#logger = deps.logger;
    this.#soundNotifier = deps.soundNotifier;
    this.#endingActions = deps.endingActions;
    this.#endingDelay = deps.endingDelay ?? defaultEndingDelay;
    this.#timerEmbed = new TimerEmbedController({
      channel: deps.channel,
      timer: deps.timer,
      config: deps.config,
      logger: deps.logger,
    });
    // 23時間キャップ発火時は継続/通常を問わず 23時間メッセージ付きで実終了する。
    this.#continueState = new ContinueSessionState({
      capMs: CONTINUE_MAX_SESSION_MS,
      onCap: () => void this.#force23hEnd(),
    });
    this.#debouncer = new RepostDebouncer({
      callback: () => this.#timerEmbed.repost(),
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
    return this.#timerEmbed.id;
  }
  /** 終了演出フロー進行中か (▶開始の二重起動防止に commands 側から参照)。 */
  get isEnding(): boolean {
    return this.#isEnding;
  }
  /** 「続行」継続ループ中か (診断・テスト用)。 */
  get continuousActive(): boolean {
    return this.#continueState.continuousActive;
  }

  /** idle: スタート用 Embed を投稿 (タイマー用・既存スタート用が残っていれば削除)。 */
  async onIdle(): Promise<void> {
    // updater/debouncer/フォローアップ予約/継続状態を止め、タイマー Embed を消して idle に戻す。
    // /pomo stop など onEnded を経由しない経路でも継続状態・23時間キャップを残さない。
    await this.#teardownToIdle();
    // お疲れさま/23時間終了の孤児プレーンテキストを本文一致で掃除。
    await this.#channel.purgeOwnTexts([FAREWELL_CONTENT, TIMEOUT_CONTENT]);
    // 既存スタート Embed を消してから出し直す (/pomo stop の重複投稿防止・冪等化)。
    await this.#deleteStartEmbed();
    const posted = await this.#postFresh(buildStartEmbedMessage(this.#config));
    this.#startEmbedId = posted.id;
  }

  /** 自動スタートでリセットを伴う場合のお知らせを投稿する (auto-start、resetForRestart の直前)。 */
  async postAutoStartResetNotice(label: string): Promise<void> {
    await this.#channel.post(buildAutoStartResetMessage(label));
  }

  /**
   * 自動スタートによる再開のための軽量リセット (auto-start)。
   * onEnded から finish 音・お疲れさま投稿・kick・bot 切断を除いたもので、
   * 直後に timer.start() を呼ぶ前提。updater/debouncer/23時間キャップを止め、
   * タイマー Embed を消し、継続状態と timer を idle に戻す。
   * 新スタート Embed は出さない (timer.start → onTimerStart の #postFresh で旧 Embed も掃除される)。
   */
  async resetForRestart(): Promise<void> {
    // 継続状態・23時間キャップをクリア (新セッションは onTimerStart で再 arm)。
    await this.#teardownToIdle();
    // ended と同様、明示的に reset() して phase='idle' に戻す (次の start が弾かれないように)。
    this.#timer.reset();
  }

  /**
   * タイマー開始: スタート削除 → タイマー用投稿 → 5秒更新開始。
   */
  async onTimerStart(): Promise<void> {
    this.#currentPhase = 'work';
    // 「続行」継続用に開始時の作業/休憩秒を確保し、23時間キャップを arm する (US-続行)。
    // config は設定モーダル保存で途中変更され得るため、開始時点の値を別途固定する。
    this.#continueState.begin({
      workSec: this.#config.default.workSec,
      breakSec: this.#config.default.breakSec,
      baseSets: this.#config.default.sets,
    });
    // 前回 ended のお疲れさま (15秒削除待ち) や、再起動で id 追跡を失った孤児の
    // お疲れさま等テキストを、新セッション開始前に掃除する。
    this.#followup.cancel();
    await this.#channel.purgeOwnTexts([FAREWELL_CONTENT, TIMEOUT_CONTENT]);
    await this.#deleteStartEmbed();
    await this.#timerEmbed.post();
    this.#timerEmbed.startUpdater();
  }

  /** 人間メッセージ検知: work/break/finalBreak のみデバウンス開始。 */
  onHumanMessage(): void {
    const { phase } = this.#timer.getSnapshot();
    if (phase === 'work' || phase === 'break' || phase === 'finalBreak') {
      this.#debouncer.trigger();
    }
  }

  /**
   * 「続行」ボタン押下を受け付ける (US-続行)。最終休憩表示中のみ受理し、ユーザを残留対象に登録する。
   * 受理時は #continueState に登録し、最終休憩終了 (ended) で終了演出後に継続ループへ移行する。
   * countdown 突入 (まもなく終了) で #currentPhase='countdown' になった時点で受付は締め切る
   * (通常終了と同じく、最後の10秒は続行ボタンを消す)。
   * @returns 'ok' (受理) / 'closed' (受付終了: 最終休憩以外)
   */
  registerContinueUser(userId: string): 'ok' | 'closed' {
    if (this.#currentPhase !== 'finalBreak') {
      return 'closed';
    }
    const total = this.#continueState.register(userId);
    this.#logger.info({ userId, total }, '続行を受け付け');
    return 'ok';
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
    this.#debouncer.cancel();
    this.#timerEmbed.stopUpdater();
    await this.#timerEmbed.editForCountdown();
  }

  /**
   * ended: 終了演出フロー (ending-spec §第二段階・US-19)。
   * 続行の有無に関わらず共通で finish.mp3 → 余韻を流し、その後に分岐する:
   * - 通常終了: タイマー Embed 削除 → お疲れさま投稿 → 余韻 → VC 全員退出 → bot 退出 → idle 復帰。
   *   新スタート Embed は「お疲れさま投稿の削除 (投稿15秒後)」の直後に投稿する (#scheduleEndingFollowup)。
   * - 続行あり (継続移行): finish.mp3 → 余韻 → 続行を押していない人間だけ退出 → 継続ループ開始。
   *   お疲れさま/bot退出/新スタートは行わず bot は残留する。継続の初回 phaseChange(work) は
   *   #onPhaseChange 中間切替で Embed を貼り替える (phaseTransitionSound(...,'work')===null で無音)。
   *
   * 二重発火防止 (#isEnding): ended イベント + 空 VC 30 秒退出など複数経路から
   * 同時起動し得るため、最初の 1 回のみ通す。エラー時も必ず #isEnding を解除する。
   *
   * US-続行: reason='normal' かつ「続行」が押されていて未移行 (#continueState.shouldContinue())
   * なら継続移行。継続移行後の ended (VC 0 人 / 23時間キャップ) は実終了。
   * reason='timeout23h' は投稿文言を 23時間メッセージに切り替え、常に実終了する。
   */
  async onEnded(reason: EndingReason = 'normal'): Promise<void> {
    if (this.#isEnding) {
      this.#logger.debug('ended 二重発火を握りつぶし (#isEnding ガード)');
      return;
    }
    this.#isEnding = true;
    try {
      // 「続行」が押されていて未移行なら、終了演出後に継続ループへ移行する。
      const continuing = reason === 'normal' && this.#continueState.shouldContinue();
      this.#logger.info({ reason, continuing }, '終了演出フロー開始 (ending-spec §第二段階)');
      this.#timerEmbed.discardUpdater();
      this.#debouncer.cancel();
      // 1. 終了音 (4 秒、非同期で開始)。続行あり/なし共通。
      this.#logger.info('finish.mp3 再生開始');
      this.#soundNotifier?.playFinish();
      // 2. 通常終了のみ: タイマー Embed 削除 → 終了テキスト投稿 → フォローアップ予約。
      //    継続時は Embed を消さない (継続の phaseChange(work) が中間切替で貼り替えるため)。
      if (!continuing) {
        await this.#timerEmbed.deleteEmbed();
        // 終了テキスト投稿 (23時間キャップ起因ならその旨、それ以外はお疲れさま)。Embed なしの
        // 単発テキストで、投稿から 15 秒後に「削除 → 新スタート Embed 投稿」を予約する。
        const endingMessage =
          reason === 'timeout23h' ? buildTimeoutMessage() : buildFarewellMessage();
        const farewell = await this.#channel.post(endingMessage);
        this.#logger.info({ messageId: farewell.id, reason }, '終了テキスト投稿 完了');
        this.#scheduleEndingFollowup(farewell.id);
      }
      // 3. finish.mp3 を最後まで聞かせる余韻待機。続行あり/なし共通。
      this.#logger.info({ ms: ENDING_DELAY_MS }, '余韻待機');
      await this.#endingDelay(ENDING_DELAY_MS);

      if (continuing) {
        // 4a. 続行を押していない人間のみ強制退出 (押した人は残す)。bot は残留しループを続ける。
        if (this.#endingActions) {
          try {
            await this.#endingActions.kickHumansExcept(this.#continueState.userIds);
            this.#logger.info('続行未押下ユーザの退出 完了');
          } catch (err) {
            this.#logger.warn({ err }, '続行未押下ユーザの退出に失敗 (best-effort)');
          }
        }
        // 5a. 継続タイマー開始 → phaseChange(work) で #onPhaseChange が Embed を貼り替え updater 再開。
        this.#continueState.markContinuousActive();
        this.#timer.startContinuous(
          this.#continueState.workSec,
          this.#continueState.breakSec,
          this.#continueState.baseSets,
        );
        this.#logger.info(
          { continueUsers: this.#continueState.userIds.size },
          '続行: 終了演出後に継続ループへ移行',
        );
        return;
      }

      // 4b. VC 内の人間メンバー全員を強制退出 (未注入ならスキップ)。
      if (this.#endingActions) {
        try {
          await this.#endingActions.kickAllHumans();
          this.#logger.info('VC 全員強制退出 完了');
        } catch (err) {
          this.#logger.warn({ err }, 'VC 全員強制退出に失敗 (best-effort)');
        }
        // 5b. bot 自身を即時退出 (カウントダウン経由しない)。
        try {
          this.#endingActions.disconnectBot();
          this.#logger.info('bot VC 退出 完了');
        } catch (err) {
          this.#logger.warn({ err }, 'bot の VC 退出に失敗 (best-effort)');
        }
      }
      // 6. お疲れさま投稿の削除は step 2 で予約済み (投稿15秒後)。ここでは行わない。
      // 7. SessionState 相当のリセット。
      //    PomodoroTimer は ended 到達で interval は停止するが #startedAt/#currentPhase='ended' を
      //    保持する設計のため、明示的に reset() を呼ばないと次の ▶開始で
      //    getSnapshot().phase !== 'idle' に弾かれて「すでに動作中」と誤判定される。
      this.#timer.reset();
      this.#currentPhase = 'idle';
      // 「続行」継続状態・23時間キャップもここでクリアする (新セッションは onTimerStart で再 arm)。
      this.#continueState.reset();
      // 8. 新スタート Embed はここでは出さない。お疲れさま削除 (投稿15秒後) の直後に
      //    #scheduleEndingFollowup から投稿する。idle 自体へはここで復帰する。
      this.#logger.info('終了演出フロー完了 idle 復帰 (スタート Embed はお疲れさま削除後)');
    } finally {
      this.#isEnding = false;
    }
  }

  /**
   * 設定モーダル保存後に Start Embed を最新 config で投稿し直す (US-12 結線)。
   * 既存 Start Embed があれば削除してから #postFresh (purge → post) で再投稿し、
   * 「変更を保存しました」ephemeral の直後にチャンネル最下部へ最新版 Embed を露出させる。
   *
   * Start Embed が存在しない (タイマー稼働中で削除済み・初期化未済・終了直後でまだ
   * お疲れさま削除前) 場合は config 反映のみで no-op。次回 idle 復帰時 (onIdle /
   * 終了フォローアップのスタート Embed 投稿) に最新 config で投稿される。
   * 終了演出進行中 (#isEnding) も冪等のため再投稿は行わない。
   */
  async repostStartEmbed(config: BotConfig): Promise<void> {
    this.#config = config;
    this.#timerEmbed.applyConfig(config);
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
    this.#timerEmbed.applyConfig(config);
  }

  /**
   * 起動時などに、id 追跡を持たない孤児のお疲れさま/23時間終了プレーンテキストを掃除する。
   * bot 異常終了・再起動で id を失った残骸 (例: 終了15秒前の再起動で残るお疲れさま投稿) を
   * 本文一致で回収する。アクティブセッションが無い前提で呼ぶ (起動直後・idle)。best-effort。
   */
  async purgeOrphanTexts(): Promise<void> {
    await this.#channel.purgeOwnTexts([FAREWELL_CONTENT, TIMEOUT_CONTENT]);
  }

  async #onPhaseChange(snapshot: TimerSnapshot): Promise<void> {
    const to = snapshot.phase;
    if (to !== 'work' && to !== 'break' && to !== 'finalBreak') {
      // countdown/ended/idle は専用ハンドラで処理する。
      return;
    }
    const from = this.#currentPhase;
    this.#currentPhase = to;

    if (this.#timerEmbed.id === null) {
      // 初回 (idle→work): セッション開始の合図として break_end.mp3 を鳴らし、
      // スタート削除 → タイマー投稿。onTimerStart は await を挟むため、音は
      // await の前に fire-and-forget で鳴らして即時性を確保する。
      this.#logger.info({ to, currentSet: snapshot.currentSet }, 'タイマー初回フェーズ突入');
      this.#soundNotifier?.playBreakEnd();
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
    await this.#timerEmbed.repost();
    this.#timerEmbed.startUpdater();
  }

  /**
   * 新規スタート Embed 投稿の共通入口。直前に purgeOwnEmbeds で過去 Embed を掃除してから post。
   * これで「テキスト欄に bot 自身の Embed は常に 1 つ」を保証する。
   * タイマー Embed 側の同等処理は TimerEmbedController が持ち、同じ purgeOwnEmbeds を共有する。
   */
  async #postFresh(options: MessageCreateOptions): Promise<PostedMessage> {
    await this.#channel.purgeOwnEmbeds();
    return this.#channel.post(options);
  }

  async #deleteStartEmbed(): Promise<void> {
    if (this.#startEmbedId !== null) {
      const id = this.#startEmbedId;
      this.#startEmbedId = null;
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

  /** 23時間キャップ発火: タイマーを止めてから 23時間メッセージ付きで実終了する。 */
  async #force23hEnd(): Promise<void> {
    this.#logger.info('セッション開始から23時間経過: 強制終了します');
    // 継続タイマーは自走するため、終了演出に入る前に必ず止める (tick による再投稿を防ぐ)。
    this.#timer.reset();
    await this.onEnded('timeout23h');
  }

  /**
   * updater/debouncer/フォローアップ予約/継続状態を止め、タイマー Embed を消して idle に戻す
   * 共通リセット (onIdle / resetForRestart 共有)。onEnded はフォローアップ予約を保持し
   * Embed 削除順序も異なるため本ヘルパーは使わない (意図的)。
   */
  async #teardownToIdle(): Promise<void> {
    this.#timerEmbed.discardUpdater();
    this.#debouncer.cancel();
    this.#followup.cancel();
    this.#continueState.reset();
    this.#currentPhase = 'idle';
    await this.#timerEmbed.deleteEmbed();
  }

  /**
   * 終了フォローアップを投稿から FAREWELL_DELETE_DELAY_MS (15秒) 後に予約する:
   * お疲れさま投稿を削除し、その直後に新スタート Embed を投稿する。
   * 終了演出フローはブロックせず setTimeout で予約。新セッション開始 / idle 復帰時は解除する。
   * 二重 ended は #isEnding で防止済みだが、念のため直前の予約は破棄して上書きする。
   */
  #scheduleEndingFollowup(farewellMessageId: string): void {
    this.#followup.schedule(() => void this.#runEndingFollowup(farewellMessageId));
  }

  /**
   * お疲れさま投稿を削除し、その後に新スタート Embed を投稿する (お疲れさま削除後に出す)。
   * 削除・投稿はいずれも best-effort。15秒の間に新セッションが始まった場合 (in-flight race)
   * は #currentPhase !== 'idle' でスタート Embed 投稿をスキップし、進行中セッションを尊重する。
   */
  async #runEndingFollowup(farewellMessageId: string): Promise<void> {
    try {
      await this.#channel.delete(farewellMessageId);
      this.#logger.info({ messageId: farewellMessageId }, 'お疲れさま投稿を削除 (投稿15秒後)');
    } catch (err) {
      this.#logger.warn(
        { err, messageId: farewellMessageId },
        'お疲れさま投稿の削除に失敗 (best-effort)',
      );
    }
    // 15秒の間に新セッションが開始していたら (cancel が間に合わなかった in-flight)、
    // スタート Embed は出さない。
    if (this.#currentPhase !== 'idle') {
      return;
    }
    try {
      const posted = await this.#postFresh(buildStartEmbedMessage(this.#config));
      this.#startEmbedId = posted.id;
      this.#logger.info('お疲れさま削除後に新スタート Embed を投稿');
    } catch (err) {
      this.#logger.warn({ err }, 'お疲れさま削除後のスタート Embed 投稿に失敗 (best-effort)');
    }
  }

  /**
   * VC 入室時の挨拶を post する (「{表示名}さんよろしくおねがいします！」)。
   * 入室のたびに投稿する一過性メッセージで、ID 追跡・削除はしない。
   * 投稿失敗は best-effort (warn のみ): VC 入退室処理を妨げないようにする。
   */
  async postJoinGreeting(displayName: string): Promise<void> {
    try {
      await this.#channel.post(buildJoinGreetingMessage(displayName));
      this.#logger.info({ displayName }, '入室挨拶を投稿');
    } catch (err) {
      this.#logger.warn({ err, displayName }, '入室挨拶の投稿に失敗 (best-effort)');
    }
  }
}
