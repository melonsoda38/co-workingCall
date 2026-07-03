import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { TIMEOUT_CONTENT, buildTimeoutMessage } from './timeout-message.js';

describe('buildTimeoutMessage', () => {
  it('content と SuppressNotifications (通知音OFF) を返す', () => {
    const msg = buildTimeoutMessage();
    expect(msg).toEqual({
      content: TIMEOUT_CONTENT,
      flags: MessageFlags.SuppressNotifications,
    });
  });
});
