import type { BaseMessageOptions, MessageCreateOptions } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig, TimerPhase, TimerSnapshot } from '@co-working-call/shared';
import { buildStartEmbedMessage } from './start-embed.js';
import { buildTimerEmbedContent, buildTimerEmbedMessage } from './timer-embed.js';
import { RepostDebouncer } from './repost-debouncer.js';
import { TimerEmbedUpdater } from './timer-embed-updater.js';
import {
  playPhaseTransitionSound,
  phaseTransitionSound,
  type PhaseSoundNotifier,
} from './sound-notifier.js';

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
}

/** EmbedManager が必要とするタイマーの最小インターフェース (PomodoroTimer 互換)。 */
export interface TimerLike {
  getSnapshot(): TimerSnapshot;
  on(
    event: 'phaseChange' | 'countdown' | 'ended',
    listener: (snapshot: TimerSnapshot) => void,
  ): unknown;
}

export interface EmbedManagerDeps {
  channel: EmbedChannel;
  timer: TimerLike;
  config: BotConfig;
  logger: Logger;
  /** フェーズ切替の通知音 (US-15 で実 SoundPlayer を注入。未指定なら無音)。 */
  soundNotifier?: PhaseSoundNotifier;
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
  #currentPhase: TimerPhase = 'idle';
  #startEmbedId: string | null = null;
  #timerEmbedId: string | null = null;
  #updater: TimerEmbedUpdater | null = null;

  constructor(deps: EmbedManagerDeps) {
    this.#channel = deps.channel;
    this.#timer = deps.timer;
    this.#config = deps.config;
    this.#logger = deps.logger;
    this.#soundNotifier = deps.soundNotifier;
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

  /** idle: スタート用 Embed を投稿 (タイマー用・既存スタート用が残っていれば削除)。 */
  async onIdle(): Promise<void> {
    this.#updater?.stop();
    this.#updater = null;
    this.#debouncer.cancel();
    this.#currentPhase = 'idle';
    await this.#deleteTimerEmbed();
    // 既存スタート Embed を消してから出し直す (/pomo stop の重複投稿防止・冪等化)。
    await this.#deleteStartEmbed();
    const posted = await this.#postFresh(buildStartEmbedMessage(this.#config));
    this.#startEmbedId = posted.id;
  }

  /** タイマー開始: スタート削除 → タイマー用投稿 → 5秒更新開始。 */
  async onTimerStart(): Promise<void> {
    this.#currentPhase = 'work';
    await this.#deleteStartEmbed();
    const snapshot = this.#timer.getSnapshot();
    const posted = await this.#postFresh(buildTimerEmbedMessage(snapshot, this.#config));
    this.#timerEmbedId = posted.id;
    this.#startUpdater();
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
    this.#soundNotifier?.playCountdownWarning();
    this.#debouncer.cancel();
    this.#updater?.stop();
    if (this.#timerEmbedId !== null) {
      const snapshot = this.#timer.getSnapshot();
      await this.#channel.edit(this.#timerEmbedId, buildTimerEmbedContent(snapshot, this.#config));
    }
  }

  /** ended: タイマー用削除 → スタート用投稿 → 状態クリア (音/VC 退出は US-19)。 */
  async onEnded(): Promise<void> {
    this.#updater?.stop();
    this.#updater = null;
    this.#debouncer.cancel();
    this.#currentPhase = 'idle';
    await this.#deleteTimerEmbed();
    const posted = await this.#postFresh(buildStartEmbedMessage(this.#config));
    this.#startEmbedId = posted.id;
  }

  /** 設定変更時にスタート用 Embed の内容を更新する (US-12)。 */
  async updateStartEmbed(config: BotConfig): Promise<void> {
    this.#config = config;
    if (this.#startEmbedId !== null) {
      await this.#channel.edit(this.#startEmbedId, buildStartEmbedMessage(this.#config));
    }
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
      await this.onTimerStart();
      return;
    }

    // 中間切替 (work↔break, work→finalBreak) の強制リセット (embed-spec §フェーズ切替):
    // 1. 通知音 → 2-3. 旧Embed削除&新Embed投稿 → 4. デバウンスclear → 5. 5秒更新リセット。
    if (this.#soundNotifier) {
      playPhaseTransitionSound(this.#soundNotifier, phaseTransitionSound(from, to));
    }
    this.#debouncer.cancel();
    await this.#repostTimerEmbed();
    this.#startUpdater();
  }

  async #repostTimerEmbed(): Promise<void> {
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
}
