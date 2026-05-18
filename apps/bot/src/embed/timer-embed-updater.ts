import type { BaseMessageOptions } from 'discord.js';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import { buildTimerEmbedContent } from './timer-embed.js';

export const TIMER_EMBED_UPDATE_INTERVAL_MS = 5_000;

/** edit 可能なメッセージの最小インターフェース (実 Discord Message を US-10 で注入)。 */
export interface EditableMessage {
  edit(options: BaseMessageOptions): Promise<unknown>;
}

/** スナップショット供給元 (PomodoroTimer を US-10 で注入)。 */
export interface SnapshotSource {
  getSnapshot(): TimerSnapshot;
}

/**
 * タイマー用 Embed を 5秒ごとに edit 更新するドライバ (embed-spec §各フェーズ)。
 * work/break/finalBreak のみ更新し、countdown/ended/idle はスキップする
 * (countdown 突入後の 5秒更新停止 = ending-spec)。
 * 実 Discord Message / PomodoroTimer との配線は US-10 EmbedManager で行う。
 */
export class TimerEmbedUpdater {
  readonly #message: EditableMessage;
  readonly #source: SnapshotSource;
  readonly #config: BotConfig;
  readonly #onError: ((err: unknown) => void) | undefined;
  #interval: NodeJS.Timeout | null = null;

  constructor(
    message: EditableMessage,
    source: SnapshotSource,
    config: BotConfig,
    onError?: (err: unknown) => void,
  ) {
    this.#message = message;
    this.#source = source;
    this.#config = config;
    this.#onError = onError;
  }

  start(): void {
    this.stop();
    this.#interval = setInterval(() => {
      this.#update();
    }, TIMER_EMBED_UPDATE_INTERVAL_MS);
  }

  stop(): void {
    if (this.#interval !== null) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
  }

  #update(): void {
    const snapshot = this.#source.getSnapshot();
    if (
      snapshot.phase !== 'work' &&
      snapshot.phase !== 'break' &&
      snapshot.phase !== 'finalBreak'
    ) {
      return;
    }
    void this.#message
      .edit(buildTimerEmbedContent(snapshot, this.#config))
      .catch((err: unknown) => {
        if (this.#onError) {
          this.#onError(err);
        }
      });
  }
}
