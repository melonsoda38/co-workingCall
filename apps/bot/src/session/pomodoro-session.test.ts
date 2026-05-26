import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import {
  SoundPlayer,
  type AudioPlayerLike,
  type AudioResourceLike,
} from '../audio/sound-player.js';
import type { EmbedChannel, PostedMessage } from '../embed/embed-manager.js';
import { createPomodoroSession } from './pomodoro-session.js';

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// 結合テスト用に短い秒数でフェーズを素早く進める (型のみ満たせば schema 検証は不要)。
const config: BotConfig = {
  default: { workSec: 1, breakSec: 1, sets: 2, finalBreakSec: 15 },
  guildId: 'g',
  voiceChannelId: 'vc',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
};

function fakeChannel(): EmbedChannel {
  let n = 0;
  return {
    post: vi.fn<() => Promise<PostedMessage>>(() => {
      n += 1;
      return Promise.resolve({ id: `m${String(n)}` });
    }),
    edit: vi.fn<(messageId: string, options: unknown) => Promise<void>>(() => Promise.resolve()),
    delete: vi.fn<(messageId: string) => Promise<void>>(() => Promise.resolve()),
    purgeOwnEmbeds: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  };
}

// 実 SoundPlayer を @discordjs/voice 非依存のモックで構築する。
function fakeSoundPlayer() {
  const play = vi.fn<(resource: AudioResourceLike) => void>();
  const stop = vi.fn<(force?: boolean) => boolean>(() => true);
  const player: AudioPlayerLike = { play, stop };
  const createResource = vi.fn<(filePath: string) => AudioResourceLike>(() => ({}));
  const soundPlayer = new SoundPlayer({
    logger,
    soundsDir: '/sounds',
    createPlayer: () => player,
    createResource,
    fileExists: () => true,
  });
  return { soundPlayer, createResource };
}

describe('createPomodoroSession (US-15 フェーズ切替音の統合)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('実 timer のフェーズ切替で対応する通知音が順に再生される', async () => {
    const { soundPlayer, createResource } = fakeSoundPlayer();
    const session = createPomodoroSession({ channel: fakeChannel(), config, logger, soundPlayer });

    await session.embedManager.onIdle(); // スタート Embed 投稿
    session.timer.start(config.default); // idle→work(1): 初回は無音
    await vi.advanceTimersByTimeAsync(0);
    expect(createResource).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000); // work(1)→break(1)
    expect(createResource).toHaveBeenLastCalledWith('/sounds/work_end.mp3');

    await vi.advanceTimersByTimeAsync(1000); // break(1)→work(2)
    expect(createResource).toHaveBeenLastCalledWith('/sounds/break_end.mp3');

    await vi.advanceTimersByTimeAsync(1000); // work(2)→finalBreak
    expect(createResource).toHaveBeenLastCalledWith('/sounds/final_start.mp3');
  });

  it('timer / soundPlayer / embedManager を束ねて返す', () => {
    const { soundPlayer } = fakeSoundPlayer();
    const session = createPomodoroSession({ channel: fakeChannel(), config, logger, soundPlayer });
    expect(session.soundPlayer).toBe(soundPlayer);
    expect(session.timer).toBeDefined();
    expect(session.embedManager).toBeDefined();
  });
});
