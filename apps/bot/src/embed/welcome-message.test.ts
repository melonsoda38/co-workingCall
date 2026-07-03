import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { WELCOME_CONTENT, buildWelcomeMessage } from './welcome-message.js';

describe('buildWelcomeMessage', () => {
  it('プレーンテキストの content と SuppressNotifications (通知音OFF) を返す', () => {
    const msg = buildWelcomeMessage();
    expect(msg).toEqual({
      content: WELCOME_CONTENT,
      flags: MessageFlags.SuppressNotifications,
    });
  });

  it('文言が仕様どおりの 2 行 (改行含む)', () => {
    expect(WELCOME_CONTENT).toBe(
      'ご参加ありがとうございます〜\n一緒に作業・勉強よろしくおねがいします。',
    );
  });
});
