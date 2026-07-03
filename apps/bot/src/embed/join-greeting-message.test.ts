import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildJoinGreetingMessage } from './join-greeting-message.js';

describe('buildJoinGreetingMessage', () => {
  it('表示名入りの挨拶 content と SuppressNotifications (通知音OFF) を返す', () => {
    const msg = buildJoinGreetingMessage('たろう');
    expect(msg).toEqual({
      content: 'たろうさんよろしくおねがいします！',
      flags: MessageFlags.SuppressNotifications,
    });
  });
});
