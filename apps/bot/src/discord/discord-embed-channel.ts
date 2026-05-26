import type { BaseMessageOptions, MessageCreateOptions, VoiceChannel } from 'discord.js';
import type { Logger } from 'pino';
import type { EmbedChannel, PostedMessage } from '../embed/index.js';
import { purgeOwnEmbeds } from './purge-embeds.js';

/**
 * 実 Discord VoiceChannel を EmbedManager の EmbedChannel として扱うアダプタ。
 * EmbedManager を Discord 非依存に保つための境界。
 *
 * purgeOwnEmbeds は新規 Embed 投稿の直前に EmbedManager から呼ばれ、
 * VC テキスト欄に bot 自身の Embed が複数残らないよう掃除する (best-effort)。
 */
export function createDiscordEmbedChannel(channel: VoiceChannel, logger: Logger): EmbedChannel {
  return {
    async post(options: MessageCreateOptions): Promise<PostedMessage> {
      const message = await channel.send(options);
      return { id: message.id };
    },
    async edit(messageId: string, options: BaseMessageOptions): Promise<void> {
      const message = await channel.messages.fetch(messageId);
      await message.edit(options);
    },
    async delete(messageId: string): Promise<void> {
      await channel.messages.delete(messageId);
    },
    async purgeOwnEmbeds(): Promise<void> {
      await purgeOwnEmbeds(channel, channel.client.user.id, logger);
    },
  };
}
