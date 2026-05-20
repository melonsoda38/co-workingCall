import {
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import ffmpegStatic from 'ffmpeg-static';
import type { Logger } from 'pino';
import { SoundPlayer } from './sound-player.js';

// ffmpeg-static は CJS でパス文字列を default export するが、型定義が ESM 形式の
// ため NodeNext では名前空間として解釈される。実行時は文字列なので値を取り出す。
const ffmpegPath = ffmpegStatic as unknown as string | null;

// prism-media が同梱 ffmpeg を確実に使うようパスを通す (システム ffmpeg 不要)。
if (ffmpegPath) {
  process.env.FFMPEG_PATH ??= ffmpegPath;
}

/**
 * 本番用 SoundPlayer を生成する (@discordjs/voice の実体を注入)。
 * 多重再生は AudioPlayer 既定の上書き挙動に委ねる。購読者がいなくても
 * 再生を進める NoSubscriberBehavior.Play で、入室直後の取りこぼしを防ぐ。
 */
export function createDiscordSoundPlayer(logger: Logger, soundsDir?: string): SoundPlayer {
  return new SoundPlayer({
    logger,
    soundsDir,
    createPlayer: () =>
      createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
    createResource: (filePath) =>
      createAudioResource(filePath, { inputType: StreamType.Arbitrary }),
  });
}
