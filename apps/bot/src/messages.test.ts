import { describe, expect, it } from 'vitest';
import { MessageFlags } from 'discord.js';
import { ENTRY_MESSAGE, buildEntryMessageOptions } from './messages.js';

describe('入室メッセージ (US-17)', () => {
  it('ENTRY_MESSAGE は空でない', () => {
    expect(ENTRY_MESSAGE.length).toBeGreaterThan(0);
  });

  it('送信オプションは内容と SuppressNotifications フラグを持つ', () => {
    const options = buildEntryMessageOptions();
    expect(options.content).toBe(ENTRY_MESSAGE);
    expect(options.flags).toBe(MessageFlags.SuppressNotifications);
  });
});
