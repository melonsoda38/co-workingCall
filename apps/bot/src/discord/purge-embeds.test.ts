import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { purgeOwnEmbeds, type PurgeMessage } from './purge-embeds.js';

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** discord.js Collection の filter/values を模した軽量フェイク。 */
function collection(messages: PurgeMessage[]) {
  return {
    filter(fn: (m: PurgeMessage) => boolean) {
      const filtered = messages.filter(fn);
      return {
        values(): IterableIterator<PurgeMessage> {
          return filtered[Symbol.iterator]();
        },
      };
    },
  };
}

function makeMessage(opts: {
  id: string;
  authorId: string;
  embeds: number;
  deleteImpl?: () => Promise<void>;
}): PurgeMessage & { delete: ReturnType<typeof vi.fn> } {
  const del = vi.fn(opts.deleteImpl ?? (() => Promise.resolve()));
  return {
    id: opts.id,
    author: { id: opts.authorId },
    embeds: new Array<unknown>(opts.embeds),
    delete: del,
  };
}

describe('purgeOwnEmbeds', () => {
  it('bot 自身が投稿した Embed 付きメッセージのみ削除する', async () => {
    const own1 = makeMessage({ id: 'a', authorId: 'BOT', embeds: 1 });
    const own2 = makeMessage({ id: 'b', authorId: 'BOT', embeds: 2 });
    const human = makeMessage({ id: 'c', authorId: 'USER', embeds: 1 });
    const ownNoEmbed = makeMessage({ id: 'd', authorId: 'BOT', embeds: 0 });
    const fetch = vi.fn(() => Promise.resolve(collection([own1, own2, human, ownNoEmbed])));
    const channel = { messages: { fetch } };

    await purgeOwnEmbeds(channel, 'BOT', logger);

    expect(fetch).toHaveBeenCalledWith({ limit: 100 });
    expect(own1.delete).toHaveBeenCalledTimes(1);
    expect(own2.delete).toHaveBeenCalledTimes(1);
    expect(human.delete).not.toHaveBeenCalled();
    expect(ownNoEmbed.delete).not.toHaveBeenCalled();
  });

  it('fetch 失敗時は warn ログのみで例外を投げない', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('rate limited')));
    const channel = { messages: { fetch } };
    await expect(purgeOwnEmbeds(channel, 'BOT', logger)).resolves.toBeUndefined();
  });

  it('個別 delete の失敗は他の delete を止めない (best-effort)', async () => {
    const ok = makeMessage({ id: 'ok', authorId: 'BOT', embeds: 1 });
    const ng = makeMessage({
      id: 'ng',
      authorId: 'BOT',
      embeds: 1,
      deleteImpl: () => Promise.reject(new Error('already deleted')),
    });
    const ok2 = makeMessage({ id: 'ok2', authorId: 'BOT', embeds: 1 });
    const fetch = vi.fn(() => Promise.resolve(collection([ok, ng, ok2])));
    const channel = { messages: { fetch } };

    await purgeOwnEmbeds(channel, 'BOT', logger);

    expect(ok.delete).toHaveBeenCalledTimes(1);
    expect(ng.delete).toHaveBeenCalledTimes(1);
    expect(ok2.delete).toHaveBeenCalledTimes(1);
  });
});
