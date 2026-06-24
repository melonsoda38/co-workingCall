import type { BaseMessageOptions, MessageCreateOptions } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig, TimerPhase, TimerSnapshot } from '@co-working-call/shared';
import { buildStartEmbedMessage } from './start-embed.js';
import { buildTimerEmbedContent, buildTimerEmbedMessage } from './timer-embed.js';
import { RepostDebouncer } from './repost-debouncer.js';
import { TimerEmbedUpdater } from './timer-embed-updater.js';
import { buildFarewellMessage, FAREWELL_CONTENT } from './farewell-message.js';
import { buildTimeoutMessage, TIMEOUT_CONTENT } from './timeout-message.js';
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

/** お疲れさま投稿を削除するまでの遅延 (投稿から 15 秒)。 */
export const FAREWELL_DELETE_DELAY_MS = 15_000;

/**
 * 「続行」継続セッションの上限 (セッション開始から 23 時間)。US-続行。
 * 続行でタイマーが翌日まで続き新セッションを開始できなくなるのを防ぐ強制終了キャップ。
 */
export const CONTINUE_MAX_SESSION_MS = 23 * 60 * 60 * 1000;

/**
 * 「続行」継続移行時、未押下ユーザの強制退出 (kick) 直前に挟むグレース待機 (US-続行)。
 * 最終休憩終了 (ended) のギリギリに押された続行ボタンは、Discord の配信遅延や
 * interaction ハンドラの処理遅延で登録 (registerContinueUser) が ended に間に合わない
 * ことがある。kick 直前まで受付を開いたままこの猶予を挟むことで、遅延した押下も
 * #continueUserIds に取り込んでから退出判定を確定させ、「押したのに退出させられる」を防ぐ。
 */
export const CONTINUE_GRACE_MS = 2_000;

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
  #timerEmbedId: string | null = null;
  /**
   * タイマー開始時の「ご参加ありがとう」投稿 ID。Embed なしプレーンテキストで
   * purgeOwnEmbeds の対象外のため、終了演出 (onEnded) / 強制停止 (onIdle) で
   * 明示的に delete する。
   */
  #welcomeMessageId: string | null = null;
  /** お疲れさま投稿の遅延削除 (投稿15秒後) 用タイマー。 */
  #farewellDeleteTimer: NodeJS.Timeout | null = null;
  #updater: TimerEmbedUpdater | null = null;
  /** 終了演出の二重発火防止 (ended イベントと空 VC 退出など複数経路から起動し得る)。 */
  #isEnding = false;
  /**
   * 「続行」が押されたか (最終休憩中に 1 人でも押せば true)。US-続行。
   * 最終休憩終了 (ended) 時にこれが true なら終了演出をせず継続ループへ移行する。
   */
  #continuing = false;
  /** 継続ループへ移行済みか。移行後の ended (VC 0 人 / 23時間) は実終了させる。 */
  #continuousActive = false;
  /** 「続行」を押したユーザ ID 集合。移行時にこの集合以外を強制退出する。 */
  readonly #continueUserIds = new Set<string>();
  /**
   * 「続行」受付を締め切ったか (US-続行)。終了演出の二重発火ガード #isEnding とは責務を分け、
   * 受付の締切は #enterContinue が未押下ユーザを退出させる kick の直前まで開けておく。
   * これにより ended ギリギリ・グレース中の遅延押下も #continueUserIds に取り込める。
   */
  #continueRegistrationClosed = false;
  /** 継続ループで使う作業/休憩秒。セッション開始時 (onTimerStart) に確保する。 */
  #continueWorkSec = 0;
  #continueBreakSec = 0;
  /** 元セッションの実施セット数。継続中の「累計の実施セット数」表示の起点に使う。 */
  #continueBaseSets = 0;
  /** セッション開始からの 23時間キャップ用タイマー。 */
  #cap23hTimer: NodeJS.Timeout | null = null;

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
  /** 「続行」継続ループ中か (診断・テスト用)。 */
  get continuousActive(): boolean {
    return this.#continuousActive;
  }

  /** idle: スタート用 Embed を投稿 (タイマー用・既存スタート用が残っていれば削除)。 */
  async onIdle(): Promise<void> {
    this.#updater?.stop();
    this.#updater = null;
    this.#debouncer.cancel();
    this.#cancelFarewellDeletion();
    // /pomo stop など onEnded を経由しない経路でも継続状態・23時間キャップを残さない。
    this.#resetContinueState();
    this.#currentPhase = 'idle';
    await this.#deleteTimerEmbed();
    // /pomo stop など onEnded を経由しない経路でも welcome を残さない。
    await this.#deleteWelcomeMessage();
    // 歓迎/お疲れさま/23時間終了の孤児プレーンテキストを本文一致で掃除。
    await this.#channel.purgeOwnTexts([WELCOME_CONTENT, FAREWELL_CONTENT, TIMEOUT_CONTENT]);
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
    // 「続行」継続用に開始時の作業/休憩秒を確保し、23時間キャップを arm する (US-続行)。
    // config は設定モーダル保存で途中変更され得るため、開始時点の値を別途固定する。
    this.#resetContinueState();
    this.#continueWorkSec = this.#config.default.workSec;
    this.#continueBreakSec = this.#config.default.breakSec;
    this.#continueBaseSets = this.#config.default.sets;
    this.#arm23hCap();
    // 前回 ended のお疲れさま (15秒削除待ち) や、再起動で id 追跡を失った孤児の
    // 歓迎/お疲れさまテキストを、新セッションの歓迎投稿前に掃除する。
    this.#cancelFarewellDeletion();
    await this.#channel.purgeOwnTexts([WELCOME_CONTENT, FAREWELL_CONTENT, TIMEOUT_CONTENT]);
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
   * 「続行」ボタン押下を受け付ける (US-続行)。最終休憩表示中 (countdown 抑制中も含む) で
   * 継続未移行・終了演出中でないときのみ受理し、ユーザを残留対象に登録する。
   * 受理時は #continuing を立て、最終休憩終了 (ended) で継続ループへ移行する。
   * @returns 'ok' (受理) / 'closed' (受付終了: 最終休憩以外・移行済み・終了処理中)
   */
  registerContinueUser(userId: string): 'ok' | 'closed' {
    // 締切は #continueRegistrationClosed のみで判定する。#isEnding (終了演出の二重発火ガード)
    // や #continuousActive には依存しない: #enterContinue は移行直後にグレースを挟み kick 直前で
    // 締め切るため、その間 (#continuousActive=true だが phase は finalBreak のまま) も受付を続け、
    // ended ギリギリ・グレース中の遅延押下を取り込む。移行完了後は #continueRegistrationClosed
    // が真、継続ループ中は phase が finalBreak でなくなるため、いずれも 'closed' になる。
    if (this.#currentPhase !== 'finalBreak' || this.#continueRegistrationClosed) {
      return 'closed';
    }
    this.#continuing = true;
    this.#continueUserIds.add(userId);
    this.#logger.info({ userId, total: this.#continueUserIds.size }, '続行を受け付け');
    return 'ok';
  }

  /**
   * countdown 突入: 終了予告音 (US-18) → 再投稿 OFF・5秒更新停止 → countdown 表示に edit。
   * countdown フェーズは仕様上 1 回のみ突入 (ending-spec §第一段階)。timer 側の
   * 二重発火に備えて currentPhase ガードで countdown_warning.mp3 の二重再生を防ぐ。
   */
  async onCountdownEnter(): Promise<void> {
    if (this.#continuing) {
      // 「続行」が押されている: 終了予告音・「まもなく終了」表示を抑制し、最終休憩 Embed と
      // 続行ボタンを最後の 10 秒も維持する。#currentPhase は 'finalBreak' のまま据え置き、
      // ended で継続ループへ移行する (#enterContinue)。
      this.#logger.info('続行受付中のため countdown 演出を抑制');
      return;
    }
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
   * VC 全員強制退出 → bot 退出 → idle 復帰。
   * 新スタート Embed は「お疲れさま投稿の削除 (投稿15秒後)」の直後に投稿する
   * (#scheduleEndingFollowup)。お疲れさまを15秒見せてから次のスタート Embed に切り替える。
   *
   * 二重発火防止 (#isEnding): ended イベント + 空 VC 30 秒退出など複数経路から
   * 同時起動し得るため、最初の 1 回のみ通す。エラー時も必ず #isEnding を解除する。
   *
   * US-続行: reason='normal' かつ「続行」が押されていて未移行 (#continuing &&
   * !#continuousActive) なら、終了演出をせず継続ループへ移行する (#enterContinue)。
   * 継続移行後の ended (VC 0 人 / 23時間キャップ) は実終了させる。reason='timeout23h' は
   * 投稿文言を 23時間メッセージに切り替え、常に実終了する。
   */
  async onEnded(reason: EndingReason = 'normal'): Promise<void> {
    if (this.#isEnding) {
      this.#logger.debug('ended 二重発火を握りつぶし (#isEnding ガード)');
      return;
    }
    this.#isEnding = true;
    try {
      // 「続行」が押されていて未移行なら継続ループへ移行 (終了演出はしない)。
      if (reason === 'normal' && this.#continuing && !this.#continuousActive) {
        await this.#enterContinue();
        return;
      }
      this.#logger.info({ reason }, '終了演出フロー開始 (ending-spec §第二段階)');
      this.#updater?.stop();
      this.#updater = null;
      this.#debouncer.cancel();
      // 1. 終了音 (4 秒、非同期で開始)。
      this.#logger.info('finish.mp3 再生開始');
      this.#soundNotifier?.playFinish();
      // 2. タイマー Embed 削除。
      await this.#deleteTimerEmbed();
      // 3. 終了テキスト投稿 (通常通知・SuppressNotifications なし)。23時間キャップ起因なら
      //    その旨の文言、それ以外はお疲れさま。Embed なしの単発テキストで、投稿から 15 秒後に
      //    「削除 → 新スタート Embed 投稿」フォローアップを予約する (終了演出は止めない)。
      const endingMessage =
        reason === 'timeout23h' ? buildTimeoutMessage() : buildFarewellMessage();
      const farewell = await this.#channel.post(endingMessage);
      this.#logger.info({ messageId: farewell.id, reason }, '終了テキスト投稿 完了');
      this.#scheduleEndingFollowup(farewell.id);
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
      // 7. お疲れさま投稿の削除は step 3 で予約済み (投稿15秒後)。ここでは行わない。
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
      // 「続行」継続状態・23時間キャップもここでクリアする (新セッションは onTimerStart で再 arm)。
      this.#resetContinueState();
      // 9. 新スタート Embed はここでは出さない。お疲れさま削除 (投稿15秒後) の直後に
      //    #scheduleEndingFollowup から投稿する。idle 自体へはここで復帰する。
      this.#logger.info('終了演出フロー完了 idle 復帰 (スタート Embed はお疲れさま削除後)');
    } finally {
      this.#isEnding = false;
    }
  }

  /**
   * 「続行」継続ループへの移行 (US-続行)。最終休憩終了 (ended) 時に #continuing が真の経路。
   * 終了演出 (finish/お疲れさま/bot退出/新スタート Embed) は行わず、続行を押していない
   * 人間だけを退出させてから継続タイマーを開始する。継続タイマーの初回 phaseChange(work) は
   * 既存の #onPhaseChange 中間切替で処理され、phaseTransitionSound('finalBreak','work')===null の
   * ため移行音は鳴らない。以降の work↔break は通常どおり work_end / break_end が鳴る。
   */
  async #enterContinue(): Promise<void> {
    this.#continuousActive = true;
    this.#logger.info(
      { continueUsers: this.#continueUserIds.size },
      '続行: 継続ループへ移行 (終了演出はスキップ)',
    );
    this.#updater?.stop();
    this.#updater = null;
    this.#debouncer.cancel();
    // kick 直前まで受付を開けておき、グレースを挟む。ended ギリギリやグレース中に届いた
    // 遅延押下も #continueUserIds に取り込んでから締め切ることで「押したのに退出させられる」
    // を防ぐ。#continueUserIds は kickHumansExcept に live 参照で渡るため、締切前の add が
    // そのまま退出除外に反映される (コピーして渡してはならない)。
    await this.#endingDelay(CONTINUE_GRACE_MS);
    // ここで受付を締め切り、退出対象集合を確定する (kick ループ中の同時変更を止める)。
    this.#continueRegistrationClosed = true;
    // 続行を押していない人間のみ強制退出 (押した人は残す)。bot は残留しループを続ける。
    if (this.#endingActions) {
      try {
        await this.#endingActions.kickHumansExcept(this.#continueUserIds);
        this.#logger.info('続行未押下ユーザの退出 完了');
      } catch (err) {
        this.#logger.warn({ err }, '続行未押下ユーザの退出に失敗 (best-effort)');
      }
    }
    // 「ご参加ありがとう」投稿は countdown 抑制で未削除のためここで掃除する。
    await this.#deleteWelcomeMessage();
    // 継続タイマー開始 → phaseChange(work) で #onPhaseChange が finalBreak Embed を
    // 継続 work Embed に貼り替え、updater を再開する。
    this.#timer.startContinuous(
      this.#continueWorkSec,
      this.#continueBreakSec,
      this.#continueBaseSets,
    );
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
   * bot 異常終了・再起動で id を失った残骸 (例: 終了15秒前の再起動で残るお疲れさま投稿) を
   * 本文一致で回収する。アクティブセッションが無い前提で呼ぶ (起動直後・idle)。best-effort。
   */
  async purgeOrphanTexts(): Promise<void> {
    await this.#channel.purgeOwnTexts([WELCOME_CONTENT, FAREWELL_CONTENT, TIMEOUT_CONTENT]);
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
   * セッション開始から 23時間後の強制終了キャップを arm する (US-続行)。
   * 既存タイマーがあれば張り替える。発火時は継続/通常を問わず実終了し 23時間メッセージを出す。
   */
  #arm23hCap(): void {
    this.#clear23hCap();
    this.#cap23hTimer = setTimeout(() => {
      this.#cap23hTimer = null;
      void this.#force23hEnd();
    }, CONTINUE_MAX_SESSION_MS);
  }

  #clear23hCap(): void {
    if (this.#cap23hTimer !== null) {
      clearTimeout(this.#cap23hTimer);
      this.#cap23hTimer = null;
    }
  }

  /** 23時間キャップ発火: タイマーを止めてから 23時間メッセージ付きで実終了する。 */
  async #force23hEnd(): Promise<void> {
    this.#logger.info('セッション開始から23時間経過: 強制終了します');
    // 継続タイマーは自走するため、終了演出に入る前に必ず止める (tick による再投稿を防ぐ)。
    this.#timer.reset();
    await this.onEnded('timeout23h');
  }

  /** 「続行」継続状態と 23時間キャップを初期化する (セッション開始・終了・idle で呼ぶ)。 */
  #resetContinueState(): void {
    this.#continuing = false;
    this.#continuousActive = false;
    this.#continueUserIds.clear();
    this.#continueRegistrationClosed = false;
    this.#clear23hCap();
  }

  /** 予約済みの終了フォローアップ (お疲れさま削除→スタート Embed 投稿) を解除する。 */
  #cancelFarewellDeletion(): void {
    if (this.#farewellDeleteTimer !== null) {
      clearTimeout(this.#farewellDeleteTimer);
      this.#farewellDeleteTimer = null;
    }
  }

  /**
   * 終了フォローアップを投稿から FAREWELL_DELETE_DELAY_MS (15秒) 後に予約する:
   * お疲れさま投稿を削除し、その直後に新スタート Embed を投稿する。
   * 終了演出フローはブロックせず setTimeout で予約。新セッション開始 / idle 復帰時は解除する。
   * 二重 ended は #isEnding で防止済みだが、念のため直前の予約は破棄して上書きする。
   */
  #scheduleEndingFollowup(farewellMessageId: string): void {
    if (this.#farewellDeleteTimer !== null) {
      clearTimeout(this.#farewellDeleteTimer);
    }
    this.#farewellDeleteTimer = setTimeout(() => {
      this.#farewellDeleteTimer = null;
      void this.#runEndingFollowup(farewellMessageId);
    }, FAREWELL_DELETE_DELAY_MS);
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
