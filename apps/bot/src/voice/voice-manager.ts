import type { Logger } from 'pino';
import type { TimerSnapshot } from '@co-working-call/shared';
import type { AudioPlayerLike } from '../audio/sound-player.js';

/** 空 VC からの自動退出までの猶予 (voice-spec: 1 分)。 */
export const EMPTY_VC_TIMEOUT_MS = 60_000;

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

export interface VoiceManagerDeps {
  logger: Logger;
  soundPlayer: VoiceSoundPlayer;
  timer: VoiceTimerControl;
  /** 対象 VC へ接続する。失敗時は null (リトライしない: voice-spec)。 */
  connect: () => Promise<VoiceConnectionHandle | null>;
  /** 入室メッセージ送信。内容と実送信は US-17。US-16 はフックのみ。 */
  sendEntryMessage: () => void;
  /** 退出時に idle へ戻す (embedManager.onIdle 相当、暗定復帰)。 */
  resetToIdle: () => Promise<void>;
  /** 空 VC 退出までの猶予 (既定 60 秒、テスト差し替え用)。 */
  emptyVcTimeoutMs?: number;
}

/**
 * 人間ユーザーの VC 入退室に連動して bot を自動入退室させる (voice-spec)。
 * タイマー状態とは独立に動き、入室で SoundPlayer を VC に接続、全員退出から
 * 1 分後に退出する。discord.js 依存は注入で排除し単体テスト可能にしている。
 */
export class VoiceManager {
  readonly #logger: Logger;
  readonly #soundPlayer: VoiceSoundPlayer;
  readonly #timer: VoiceTimerControl;
  readonly #connect: () => Promise<VoiceConnectionHandle | null>;
  readonly #sendEntryMessage: () => void;
  readonly #resetToIdle: () => Promise<void>;
  readonly #emptyVcTimeoutMs: number;

  #humanCount = 0;
  #connection: VoiceConnectionHandle | null = null;
  #emptyVcTimeout: NodeJS.Timeout | null = null;

  constructor(deps: VoiceManagerDeps) {
    this.#logger = deps.logger;
    this.#soundPlayer = deps.soundPlayer;
    this.#timer = deps.timer;
    this.#connect = deps.connect;
    this.#sendEntryMessage = deps.sendEntryMessage;
    this.#resetToIdle = deps.resetToIdle;
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

  /** ended 処理等からの即時退出 (1 分カウントダウンを待たない)。US-19 で使用。 */
  forceDisconnect(): void {
    this.#cancelEmptyTimeout();
    this.#disconnect();
  }

  async #onEnter(): Promise<void> {
    this.#cancelEmptyTimeout();
    if (this.#connection !== null) {
      // 退出待機中の再入室など、既に接続済みなら接続は維持する。
      return;
    }
    let connection: VoiceConnectionHandle | null;
    try {
      connection = await this.#connect();
    } catch (err) {
      this.#logger.error({ err }, 'VC 接続に失敗しました');
      return;
    }
    if (connection === null) {
      this.#logger.warn('VC 接続に失敗しました (connection なし)');
      return;
    }
    this.#connection = connection;
    this.#soundPlayer.init(connection);
    this.#sendEntryMessage();
    this.#logger.info('bot が VC に入室しました');
  }

  #onLeave(): void {
    this.#cancelEmptyTimeout();
    this.#emptyVcTimeout = setTimeout(() => {
      void this.#onEmptyTimeout();
    }, this.#emptyVcTimeoutMs);
  }

  async #onEmptyTimeout(): Promise<void> {
    this.#emptyVcTimeout = null;
    // タイマー実行中なら停止 (完全な終了演出は US-19 で差し替え)。
    if (this.#timer.getSnapshot().phase !== 'idle') {
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
  }

  #cancelEmptyTimeout(): void {
    if (this.#emptyVcTimeout !== null) {
      clearTimeout(this.#emptyVcTimeout);
      this.#emptyVcTimeout = null;
    }
  }
}
