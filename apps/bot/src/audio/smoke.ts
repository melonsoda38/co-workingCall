import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamType, createAudioResource } from '@discordjs/voice';
import ffmpegStatic from 'ffmpeg-static';
import { createLogger } from '../logger.js';

// ffmpeg-static は CJS でパス文字列を default export する (型は名前空間扱いになる)。
const ffmpegPath = ffmpegStatic as unknown as string | null;

/**
 * US-13 最小再生確認スクリプト。
 * 依存 (@discordjs/voice / opusscript / libsodium-wrappers / ffmpeg-static) の
 * 解決を確認し、ffmpeg で 1 秒の無音 mp3 を生成 → createAudioResource で
 * Opus へエンコードできることを実証する (VC・実音源は不要)。
 */
const logger = createLogger('info');
const require = createRequire(import.meta.url);

const REQUIRED_DEPS = [
  '@discordjs/voice',
  'opusscript',
  'libsodium-wrappers',
  'ffmpeg-static',
] as const;

/** 各依存がインストール解決できることを確認する。 */
function checkDeps(): void {
  for (const dep of REQUIRED_DEPS) {
    const resolved = require.resolve(dep);
    logger.info({ dep, resolved }, '依存解決 OK');
  }
}

/** ffmpeg で 1 秒の無音 mp3 を生成する。 */
function generateSilence(ffmpeg: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpeg,
      ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1', '-q:a', '9', '-y', outPath],
      { stdio: 'ignore' },
    );
    proc.on('error', (err) => {
      reject(err);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg が異常終了しました (code=${String(code)})`));
      }
    });
  });
}

/** mp3 から AudioResource を生成し、Opus パケットのバイト数を数える。 */
function probeResource(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const resource = createAudioResource(filePath, { inputType: StreamType.Arbitrary });
    const stream = resource.playStream;
    let bytes = 0;
    const timer = setTimeout(() => {
      resolve(bytes);
    }, 10_000);
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolve(bytes);
    });
    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  try {
    checkDeps();

    if (!ffmpegPath) {
      throw new Error('ffmpeg-static のバイナリパスを取得できませんでした');
    }
    process.env.FFMPEG_PATH = ffmpegPath;
    logger.info({ ffmpegPath }, 'ffmpeg-static バイナリ OK');

    const dir = mkdtempSync(join(tmpdir(), 'pomo-smoke-'));
    const mp3 = join(dir, 'silence.mp3');
    try {
      await generateSilence(ffmpegPath, mp3);
      logger.info('1 秒の無音 mp3 を生成しました');

      const bytes = await probeResource(mp3);
      if (bytes <= 0) {
        throw new Error('Opus パケットが得られませんでした (エンコード失敗)');
      }
      logger.info({ bytes }, 'pipeline OK (ffmpeg デコード → Opus エンコード成功)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    logger.error({ err }, 'smoke:audio 失敗');
    process.exitCode = 1;
  }
}

void main();
