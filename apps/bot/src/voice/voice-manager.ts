import type { Logger } from 'pino';
import type { TimerPhase, TimerSnapshot } from '@co-working-call/shared';
import type { AudioPlayerLike } from '../audio/sound-player.js';

/** 空 VC からの自動退出までの猶予 (voice-spec: 30 秒)。 */
export const EMPTY_VC_TIMEOUT_MS = 30_000;

/** 人間メンバー数の状態遷移 (voice-spec トリガー)。 */
export type HumanCountTransition = 'enter' | 'leave' | 'none';

/**
 * 人間数の変化からトリガー種別を求める純関数。
 * 0→1+ で入室、1+→0 で退出、それ以外 (0→0 / 1+→1+) は何もしない。
 */
export function classifyHumanCountTransition(prev: number, next: number): HumanCountTransition {
  if (prev === 0 && next > 0) {
    return 'enter';
  }
  if (prev > 0 && next === 0) {
    return 'leave';
  }
  return 'none';
}

/**
 * voiceStateUpdate が対象 VC に関係するイベントかを判定する純関数。
 * 入室・退出・移動のいずれでも、旧 or 新チャンネルが対象 VC なら関係あり。
 */
export function isTargetVcEvent(params: {
  oldChannelId: string | null;
  newChannelId: string | null;
  targetVcId: string;
}): boolean {
  return params.oldChannelId === params.targetVcId || params.newChannelId === params.targetVcId;
}

/**
 * 対象 VC への「新規入室」かを判定する純関数。
 * 未接続 (null) や別 VC から対象 VC へ移ってきた場合に true。
 * 対象 VC 内でのミュート等の状態変化 (old も new も対象 VC) は false。
 */
export function isJoinToTargetVc(params: {
  oldChannelId: string | null;
  newChannelId: string | null;
  targetVcId: string;
}): boolean {
  return params.oldChannelId !== params.targetVcId && params.newChannelId === params.targetVcId;
}

/** VC 接続の最小抽象 (本番は @discordjs/voice の VoiceConnection)。 */
export interface VoiceConnectionHandle {
  subscribe(player: AudioPlayerLike): unknown;
  destroy(): void;
}

/** VoiceManager が使う SoundPlayer の最小インターフェース。 */
export interface VoiceSoundPlayer {
  init(connection: VoiceConnectionHandle): void;
  stop(): void;
}

/** VoiceManager が使うタイマーの最小インターフェース。 */
export interface VoiceTimerControl {
  getSnapshot(): TimerSnapshot;
  stop(): void;
}

/** タイマーが「実行中」(終了演出を発動すべき状態) かを判定する純関数 (US-20)。 */
export function isTimerRunning(phase: TimerPhase): boolean {
  return phase === 'work' || phase === 'break' || phase === 'finalBreak' || phase === 'countdown';
}

export interface VoiceManagerDeps {
  logger: Logger;
  soundPlayer: VoiceSoundPlayer;
  timer: VoiceTimerControl;
  /** 対象 VC へ接続する。失敗時は null (リトライしない: voice-spec)。 */
  connect: () => Promise<VoiceConnectionHandle | null>;
  /** 退出時に idle へ戻す (embedManager.onIdle 相当、暗定復帰)。 */
  resetToIdle: () => Promise<void>;
  /**
   * タイマー実行中の空 VC 30 秒タイムアウトで発動する終了演出フロー (US-20)。
   * 本番では timer.stop() + embedManager.onEnded() のラッパ。未注入なら従来の
   * 暗定復帰 (resetToIdle) にフォールバック。
   */
  triggerEndingFlow?: () => Promise<void>;
  /** 空 VC 退出までの猶予 (既定 30 秒、テスト差し替え用)。 */
  emptyVcTimeoutMs?: number;
}

/**
 * 人間ユーザーの VC 入退室に連動して bot を自動入退室させる (voice-spec)。
 * タイマー状態とは独立に動き、入室で SoundPlayer を VC に接続、全員退出から
 * 30 秒後に退出する。discord.js 依存は注入で排除し単体テスト可能にしている。
 */
export class VoiceManager {
  readonly #logger: Logger;
  readonly #soundPlayer: VoiceSoundPlayer;
  readonly #timer: VoiceTimerControl;
  readonly #connect: () => Promise<VoiceConnectionHandle | null>;
  readonly #resetToIdle: () => Promise<void>;
  readonly #triggerEndingFlow: (() => Promise<void>) | undefined;
  readonly #emptyVcTimeoutMs: number;

  #humanCount = 0;
  #connection: VoiceConnectionHandle | null = null;
  #emptyVcTimeout: NodeJS.Timeout | null = null;
  /**
   * 現在の稼働セッションが自動スタート由来かどうか。true の間は「VC 人間ゼロ」による
   * 30 秒退出を抑止し、設定サイクルが終了する (timer 'ended' で解除) まで bot を残す。
   */
  #autoStarted = false;

  constructor(deps: VoiceManagerDeps) {
    this.#logger = deps.logger;
    this.#soundPlayer = deps.soundPlayer;
    this.#timer = deps.timer;
    this.#connect = deps.connect;
    this.#resetToIdle = deps.resetToIdle;
    this.#triggerEndingFlow = deps.triggerEndingFlow;
    this.#emptyVcTimeoutMs = deps.emptyVcTimeoutMs ?? EMPTY_VC_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.#connection !== null;
  }

  /** voiceStateUpdate 後に再計算した人間数を渡し、入退室を駆動する。 */
  async handleHumanCountChange(newCount: number): Promise<void> {
    const transition = classifyHumanCountTransition(this.#humanCount, newCount);
    this.#humanCount = newCount;
    if (transition === 'enter') {
      await this.#onEnter();
    } else if (transition === 'leave') {
      this.#onLeave();
    }
  }

  /** ended 処理等からの即時退出 (30 秒カウントダウンを待たない)。US-19 で使用。 */
  forceDisconnect(): void {
    this.#cancelEmptyTimeout();
    this.#disconnect();
  }

  /**
   * 接続を保証する (▶開始ボタン等から呼ぶ)。未接続なら connect + SoundPlayer.init し、
   * 入室メッセージは送らない。接続済みかどうかを boolean で返す。
   */
  async ensureConnected(): Promise<boolean> {
    return this.#connectAndInit();
  }

  /**
   * 自動スタート由来のセッション開始を通知する (runAutoStart から呼ぶ)。以降このセッションが
   * 終了 (設定サイクル完了で clearAutoStartedSession、または実退出で #disconnect) するまで、
   * VC 人間ゼロによる 30 秒退出を抑止する。直前まで手動セッションで arm 済みだった退出
   * カウントダウンが割り込みで残り新セッションを誤って終わらせないよう、ここで併せて解除する。
   */
  markAutoStartedSession(): void {
    this.#autoStarted = true;
    this.#cancelEmptyTimeout();
  }

  /**
   * 自動スタート由来の抑止を解除する (設定サイクル終了 = timer 'ended' 時に呼ぶ)。
   * 以降 (「続行」による継続ループ等) は手動セッションと同じ空 VC 退出挙動に戻る。
   */
  clearAutoStartedSession(): void {
    this.#autoStarted = false;
  }

  async #onEnter(): Promise<void> {
    this.#cancelEmptyTimeout();
    if (this.#connection !== null) {
      // 退出待機中の再入室など、既に接続済みなら接続は維持する。
      return;
    }
    if (!(await this.#connectAndInit())) {
      return;
    }
    this.#logger.info('bot が VC に入室しました');
  }

  /**
   * 未接続なら VC へ接続して SoundPlayer を init する共通処理。
   * 成功 (または既に接続済み) で true、失敗で false。入室メッセージは送らない。
   */
  async #connectAndInit(): Promise<boolean> {
    if (this.#connection !== null) {
      return true;
    }
    let connection: VoiceConnectionHandle | null;
    try {
      connection = await this.#connect();
    } catch (err) {
      // リトライしない (voice-spec) が致命的でもないため warn に統一 (US-21)。
      this.#logger.warn({ err }, 'VC 接続に失敗しました (例外)');
      return false;
    }
    if (connection === null) {
      this.#logger.warn('VC 接続に失敗しました (connection なし)');
      return false;
    }
    this.#connection = connection;
    this.#soundPlayer.init(connection);
    return true;
  }

  #onLeave(): void {
    this.#cancelEmptyTimeout();
    if (this.#connection === null) {
      // bot が VC 未接続 (終了演出で退出済み等) なら退出カウントダウンは不要。
      // 終了演出の kickAllHumans が誘発する遅延 voiceStateUpdate (人間ゼロ) で、
      // forceDisconnect 済みなのに 30 秒タイマーが起動し、後から onIdle / 終了演出を
      // 再発火させる取りこぼしを防ぐ。
      return;
    }
    if (this.#autoStarted) {
      // 自動スタート由来のセッションは、人間ゼロでも設定サイクルが終わるまで継続する。
      // 退出カウントダウンを arm せず、bot を VC に残す (終了・退出は自然終了時の
      // onEnded 経路に委ねる。人間ゼロでの終了処理は 1 人以上いた場合と同一)。
      this.#logger.info('自動スタートセッションのため空 VC 自動退出を抑止 (サイクル終了まで継続)');
      return;
    }
    this.#logger.info(
      { timeoutMs: this.#emptyVcTimeoutMs },
      '人間ゼロを検知。退出カウントダウンを開始 (この間に再入室があればキャンセル)',
    );
    this.#emptyVcTimeout = setTimeout(() => {
      void this.#onEmptyTimeout();
    }, this.#emptyVcTimeoutMs);
  }

  async #onEmptyTimeout(): Promise<void> {
    this.#emptyVcTimeout = null;
    const phase = this.#timer.getSnapshot().phase;

    // US-20: タイマー実行中なら US-19 の終了演出フローを発動する (ending-spec §VC人間ゼロ起因)。
    // triggerEndingFlow 内で timer.stop + finish.mp3 + お疲れさま投稿 + 3秒待機 +
    // VC全員強制退出 + bot退出 + 新スタートEmbed + idle 復帰 まで一括で実行する。
    if (isTimerRunning(phase) && this.#triggerEndingFlow) {
      try {
        await this.#triggerEndingFlow();
      } catch (err) {
        this.#logger.error({ err }, '空 VC 経由の終了演出に失敗しました');
      }
      this.#logger.info('人間ゼロが継続したため終了演出を発動しました');
      return;
    }

    // idle (またはフロー未注入) は従来通り暗定復帰: timer 停止 → 切断 → idle 復帰。
    if (phase !== 'idle') {
      this.#timer.stop();
    }
    this.#disconnect();
    try {
      await this.#resetToIdle();
    } catch (err) {
      this.#logger.error({ err }, '退出後の idle 復帰に失敗しました');
    }
    this.#logger.info('人間ゼロが継続したため bot が VC を退出しました');
  }

  #disconnect(): void {
    this.#soundPlayer.stop();
    if (this.#connection !== null) {
      this.#connection.destroy();
      this.#connection = null;
    }
    // bot が実際に退出したら自動スタート由来の抑止も必ず解く。/pomo stop (forceDisconnect)・
    // 空 VC idle 退出など timer 'ended' を経由しない退出でもフラグが持ち越さないようにする。
    this.#autoStarted = false;
  }

  #cancelEmptyTimeout(): void {
    if (this.#emptyVcTimeout !== null) {
      clearTimeout(this.#emptyVcTimeout);
      this.#emptyVcTimeout = null;
    }
  }
}
