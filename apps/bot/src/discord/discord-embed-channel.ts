import type { BaseMessageOptions, MessageCreateOptions, VoiceChannel } from 'discord.js';
import type { Logger } from 'pino';
import type { EmbedChannel, PostedMessage } from '../embed/index.js';
import { purgeOwnEmbeds, purgeOwnTexts } from './purge-embeds.js';

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
      // attachments: [] で既存添付を全て破棄してから options.files を貼り直す。
      // これを省くと discord.js は同名 attachment を積み増すだけで Embed の
      // attachment://timer.png が初回投稿の画像に固定され、画像が更新されない。
      await message.edit({ ...options, attachments: [] });
    },
    async delete(messageId: string): Promise<void> {
      await channel.messages.delete(messageId);
    },
    async purgeOwnEmbeds(): Promise<void> {
      await purgeOwnEmbeds(channel, channel.client.user.id, logger);
    },
    async purgeOwnTexts(contents: string[]): Promise<void> {
      await purgeOwnTexts(channel, channel.client.user.id, contents, logger);
    },
  };
}
