import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import {
  SOUND_FILES,
  SoundPlayer,
  type AudioPlayerLike,
  type AudioResourceLike,
  type SoundKey,
  type VoiceConnectionLike,
} from './sound-player.js';

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const SOUNDS_DIR = '/sounds';

function setup(opts?: { exists?: boolean; throwOnCreate?: boolean }) {
  const resource: AudioResourceLike = {};
  const play = vi.fn<(r: AudioResourceLike) => void>();
  const stop = vi.fn<(force?: boolean) => boolean>(() => true);
  const player: AudioPlayerLike = { play, stop };
  const createPlayer = vi.fn<() => AudioPlayerLike>(() => player);
  const createResource = vi.fn<(filePath: string) => AudioResourceLike>(() => {
    if (opts?.throwOnCreate) {
      throw new Error('resource error');
    }
    return resource;
  });
  const fileExists = vi.fn<(filePath: string) => boolean>(() => opts?.exists ?? true);
  const sp = new SoundPlayer({
    logger,
    soundsDir: SOUNDS_DIR,
    createPlayer,
    createResource,
    fileExists,
  });
  return { sp, player, play, stop, createPlayer, createResource, fileExists, resource };
}

describe('SoundPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('生成時に AudioPlayer を一度だけ作る', () => {
    const { createPlayer } = setup();
    expect(createPlayer).toHaveBeenCalledTimes(1);
  });

  it('各 play メソッドは対応する音源ファイルを再生する', () => {
    const cases: [keyof SoundPlayer, SoundKey][] = [
      ['playWorkEnd', 'workEnd'],
      ['playBreakEnd', 'breakEnd'],
      ['playFinalStart', 'finalStart'],
      ['playCountdownWarning', 'countdownWarning'],
      ['playFinish', 'finish'],
    ];
    for (const [method, key] of cases) {
      const { sp, play, createResource, resource } = setup();
      (sp[method] as () => void)();
      expect(createResource).toHaveBeenCalledWith(`${SOUNDS_DIR}/${SOUND_FILES[key]}`);
      expect(play).toHaveBeenCalledWith(resource);
    }
  });

  it('音源が無いときは warn を出し再生しない', () => {
    const { sp, play, createResource } = setup({ exists: false });
    sp.playWorkEnd();
    expect(createResource).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('リソース生成で例外が出ても落ちず error ログを残す', () => {
    const { sp, play } = setup({ throwOnCreate: true });
    expect(() => {
      sp.playWorkEnd();
    }).not.toThrow();
    expect(play).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('init は connection に player を購読させる', () => {
    const { sp, player } = setup();
    const subscribe = vi.fn<(player: AudioPlayerLike) => unknown>();
    const connection: VoiceConnectionLike = { subscribe };
    sp.init(connection);
    expect(subscribe).toHaveBeenCalledWith(player);
  });

  it('stop は player.stop を force=true で呼ぶ', () => {
    const { sp, stop } = setup();
    sp.stop();
    expect(stop).toHaveBeenCalledWith(true);
  });
});
