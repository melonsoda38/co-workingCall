import { describe, expect, it, vi } from 'vitest';
import type { BaseMessageOptions, VoiceChannel } from 'discord.js';
import type { Logger } from 'pino';
import { createDiscordEmbedChannel } from './discord-embed-channel.js';

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('createDiscordEmbedChannel.edit', () => {
  it('既存添付を attachments: [] でクリアしてから編集する (画像固定を防ぐ)', async () => {
    // attachments: [] を省くと discord.js は同名 attachment を積み増すだけで
    // Embed の attachment://timer.png が初回投稿の画像に固定され更新されない。
    const edit = vi.fn<
      (options: BaseMessageOptions & { attachments?: unknown[] }) => Promise<void>
    >(() => Promise.resolve());
    const message = { edit };
    const fetch = vi.fn<(id: string) => Promise<typeof message>>(() => Promise.resolve(message));
    const channel = { messages: { fetch } } as unknown as VoiceChannel;

    const embedChannel = createDiscordEmbedChannel(channel, logger);
    await embedChannel.edit('m1', { content: 'hi' });

    expect(fetch).toHaveBeenCalledWith('m1');
    expect(edit).toHaveBeenCalledWith({ content: 'hi', attachments: [] });
  });
});
