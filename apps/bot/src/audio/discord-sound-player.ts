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
    createPlayer: () => {
      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      // AudioPlayer の 'error' は未処理だと例外で落ちうる。必ず捕捉してログに残す。
      player.on('error', (err) => {
        logger.error({ err: err.message }, 'AudioPlayer エラー');
      });
      return player;
    },
    createResource: (filePath, volumeDb) => {
      // inlineVolume: true で AudioResource.volume を有効化し、dB 補正をかける。
      // 0dB なら原音そのまま。正方向は増幅 (音源が大きいとクリッピングし得る)。
      const resource = createAudioResource(filePath, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });
      resource.volume?.setVolumeDecibels(volumeDb);
      return resource;
    },
  });
}
