import type { BaseMessageOptions, MessageCreateOptions } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import { buildTimerEmbedContent, buildTimerEmbedMessage } from './timer-embed.js';
import { TimerEmbedUpdater, type SnapshotSource } from './timer-embed-updater.js';
import type { EmbedChannel, PostedMessage } from './embed-manager.js';

export interface TimerEmbedControllerDeps {
  channel: EmbedChannel;
  timer: SnapshotSource;
  config: BotConfig;
  logger: Logger;
}

/**
 * タイマー Embed 1 枚のライフサイクル (投稿 / 貼り直し / 5秒更新 / countdown edit / 削除) を
 * EmbedManager から切り出したコントローラ。Embed の id と TimerEmbedUpdater を内部で保持し、
 * 「テキスト欄に bot Embed は常に 1 つ」の purge → post 不変条件も内包する。
 * 挙動は EmbedManager 内蔵時と同一 (状態機械のオーケストレーションは EmbedManager が引き続き担う)。
 */
export class TimerEmbedController {
  readonly #channel: EmbedChannel;
  readonly #timer: SnapshotSource;
  #config: BotConfig;
  readonly #logger: Logger;

  #embedId: string | null = null;
  #updater: TimerEmbedUpdater | null = null;

  constructor(deps: TimerEmbedControllerDeps) {
    this.#channel = deps.channel;
    this.#timer = deps.timer;
    this.#config = deps.config;
    this.#logger = deps.logger;
  }

  /** 現在のタイマー Embed メッセージ id (未投稿は null)。 */
  get id(): string | null {
    return this.#embedId;
  }

  /** config を差し替える (次の投稿・更新で反映)。EmbedManager 側 config と同期させて呼ぶ。 */
  applyConfig(config: BotConfig): void {
    this.#config = config;
  }

  /** 現在スナップショットでタイマー Embed を新規投稿し id を保持する (onTimerStart 用)。 */
  async post(): Promise<void> {
    const snapshot = this.#timer.getSnapshot();
    const posted = await this.#postFresh(buildTimerEmbedMessage(snapshot, this.#config));
    this.#embedId = posted.id;
  }

  /**
   * 表示フェーズ (work/break/finalBreak) のとき旧 Embed を削除して貼り直す (フェーズ切替用)。
   * countdown/ended/idle へ遷移済みなら no-op にして遷移ハンドラ側の Embed を尊重する
   * (in-flight デバウンス flush 由来の孤児投稿・スタート Embed 巻き込みを防ぐ)。
   */
  async repost(): Promise<void> {
    const { phase } = this.#timer.getSnapshot();
    if (phase !== 'work' && phase !== 'break' && phase !== 'finalBreak') {
      return;
    }
    await this.deleteEmbed();
    const snapshot = this.#timer.getSnapshot();
    const posted = await this.#postFresh(buildTimerEmbedMessage(snapshot, this.#config));
    this.#embedId = posted.id;
  }

  /** 5秒ごとのタイマー Embed 更新を開始する (既存 updater は止めて張り替える)。 */
  startUpdater(): void {
    this.#updater?.stop();
    const message = {
      edit: (options: BaseMessageOptions): Promise<unknown> => {
        if (this.#embedId === null) {
          return Promise.resolve();
        }
        return this.#channel.edit(this.#embedId, options);
      },
    };
    this.#updater = new TimerEmbedUpdater(message, this.#timer, this.#config, (err) => {
      this.#logger.error({ err }, 'タイマー Embed 更新に失敗しました');
    });
    this.#updater.start();
  }

  /** 5秒更新を止める (updater 参照は保持。countdown 突入用)。 */
  stopUpdater(): void {
    this.#updater?.stop();
  }

  /** 5秒更新を止めて updater を破棄する (idle 復帰・終了演出用)。 */
  discardUpdater(): void {
    this.#updater?.stop();
    this.#updater = null;
  }

  /** countdown 表示へ edit する (updater 停止は呼び出し側で先に行う)。id 未保持なら no-op。 */
  async editForCountdown(): Promise<void> {
    if (this.#embedId === null) {
      return;
    }
    const snapshot = this.#timer.getSnapshot();
    await this.#channel.edit(this.#embedId, buildTimerEmbedContent(snapshot, this.#config));
  }

  /** タイマー Embed を削除して id を手放す (best-effort)。 */
  async deleteEmbed(): Promise<void> {
    if (this.#embedId !== null) {
      const id = this.#embedId;
      this.#embedId = null;
      await this.#tryDelete(id);
    }
  }

  /**
   * purge (既存 bot Embed 掃除) → post。「テキスト欄に Embed は常に 1 つ」不変条件の共通入口。
   * EmbedManager 側のスタート Embed 投稿と対称 (同じ purgeOwnEmbeds を共有し互いを掃除し合う)。
   */
  async #postFresh(options: MessageCreateOptions): Promise<PostedMessage> {
    await this.#channel.purgeOwnEmbeds();
    return this.#channel.post(options);
  }

  async #tryDelete(messageId: string): Promise<void> {
    try {
      await this.#channel.delete(messageId);
    } catch (err) {
      this.#logger.warn({ err, messageId }, 'Embed 削除に失敗 (best-effort)');
    }
  }
}
