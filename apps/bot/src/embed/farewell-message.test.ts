import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { FAREWELL_CONTENT, buildFarewellMessage } from './farewell-message.js';

describe('buildFarewellMessage', () => {
  it('content と SuppressNotifications (通知音OFF) を返す', () => {
    const msg = buildFarewellMessage();
    expect(msg).toEqual({
      content: FAREWELL_CONTENT,
      flags: MessageFlags.SuppressNotifications,
    });
  });

  it('文言が仕様どおり', () => {
    expect(FAREWELL_CONTENT).toBe('お疲れさまでした 👋');
  });
});
