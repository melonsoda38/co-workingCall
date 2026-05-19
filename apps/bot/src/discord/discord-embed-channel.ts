import type { BaseMessageOptions, MessageCreateOptions, VoiceChannel } from 'discord.js';
import type { EmbedChannel, PostedMessage } from '../embed/index.js';

/**
 * 実 Discord VoiceChannel を EmbedManager の EmbedChannel として扱うアダプタ。
 * EmbedManager を Discord 非依存に保つための境界。
 */
export function createDiscordEmbedChannel(channel: VoiceChannel): EmbedChannel {
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
  };
}
