import { describe, expect, it } from 'vitest';
import { WELCOME_CONTENT, buildWelcomeMessage } from './welcome-message.js';

describe('buildWelcomeMessage', () => {
  it('プレーンテキストの content のみを返す (Embed・flags なし)', () => {
    const msg = buildWelcomeMessage();
    expect(msg).toEqual({ content: WELCOME_CONTENT });
  });

  it('文言が仕様どおりの 2 行 (改行含む)', () => {
    expect(WELCOME_CONTENT).toBe(
      'ご参加ありがとうございます〜\n一緒に作業・勉強よろしくおねがいします。',
    );
  });
});
