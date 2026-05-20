import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { PhaseSoundNotifier } from '../embed/sound-notifier.js';

/** 通知音の種別 (audio-spec ファイル一覧)。 */
export type SoundKey = 'workEnd' | 'breakEnd' | 'finalStart' | 'countdownWarning' | 'finish';

/** 種別 → 音源ファイル名 (assets/sounds 配下)。 */
export const SOUND_FILES: Record<SoundKey, string> = {
  workEnd: 'work_end.mp3',
  breakEnd: 'break_end.mp3',
  finalStart: 'final_start.mp3',
  countdownWarning: 'countdown_warning.mp3',
  finish: 'finish.mp3',
};

/**
 * audio-spec 実装定数。音源を差し替える場合はこの値も必ず更新する。
 * Embed 表示やフェーズ制御が音源の長さに依存するため (US-18 終了予告など)。
 */
export const COUNTDOWN_WARNING_DURATION_SEC = 10;
export const FINISH_DURATION_SEC = 4;

/**
 * @discordjs/voice の AudioResource の最小抽象 (中身は不透明)。
 * 生成は createResource に委譲し、player.play へ渡すだけ。
 */
export type AudioResourceLike = object;

/** @discordjs/voice の AudioPlayer の最小抽象 (テスト時はモック注入)。 */
export interface AudioPlayerLike {
  play(resource: AudioResourceLike): void;
  stop(force?: boolean): boolean;
}

/** @discordjs/voice の VoiceConnection の最小抽象 (購読のみ利用)。 */
export interface VoiceConnectionLike {
  subscribe(player: AudioPlayerLike): unknown;
}

export interface SoundPlayerDeps {
  logger: Logger;
  /** 音源ディレクトリ。未指定なら同梱の assets/sounds を解決する。 */
  soundsDir?: string;
  /** AudioPlayer を生成する (本番は @discordjs/voice、テストはモック)。 */
  createPlayer: () => AudioPlayerLike;
  /** ファイルパスから AudioResource を生成する。 */
  createResource: (filePath: string) => AudioResourceLike;
  /** ファイル存在判定 (テスト差し替え用、既定は fs.existsSync)。 */
  fileExists?: (filePath: string) => boolean;
}

/** 同梱音源ディレクトリ (dist/audio/ から見た apps/bot/assets/sounds)。 */
function defaultSoundsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../../assets/sounds');
}

/**
 * 通知音の再生を担う基盤 (audio-spec SoundPlayer 設計指針)。
 * US-13 では初期化・再生・停止までを実装。実際の音源 5 種は US-14、
 * フェーズ切替への結線は US-15、VC 入退室との連動は US-16 で行う。
 * 多重再生は AudioPlayer.play による「上書き」で回避する (audio-spec)。
 */
export class SoundPlayer implements PhaseSoundNotifier {
  readonly #logger: Logger;
  readonly #soundsDir: string;
  readonly #createResource: (filePath: string) => AudioResourceLike;
  readonly #fileExists: (filePath: string) => boolean;
  readonly #player: AudioPlayerLike;

  constructor(deps: SoundPlayerDeps) {
    this.#logger = deps.logger;
    this.#soundsDir = deps.soundsDir ?? defaultSoundsDir();
    this.#createResource = deps.createResource;
    this.#fileExists = deps.fileExists ?? ((filePath) => existsSync(filePath));
    this.#player = deps.createPlayer();
  }

  /** bot 入室時に VC 接続へ player を購読させる (audio-spec init)。 */
  init(connection: VoiceConnectionLike): void {
    connection.subscribe(this.#player);
  }

  // フェーズ切替系 (PhaseSoundNotifier 実装)。
  playWorkEnd(): void {
    this.#play('workEnd');
  }
  playBreakEnd(): void {
    this.#play('breakEnd');
  }
  playFinalStart(): void {
    this.#play('finalStart');
  }

  // 終了演出系 (US-18 終了予告 / US-19 終了で使用)。
  playCountdownWarning(): void {
    this.#play('countdownWarning');
  }
  playFinish(): void {
    this.#play('finish');
  }

  /** 再生中止 (audio-spec stop)。VC 退出時に呼ぶ。 */
  stop(): void {
    this.#player.stop(true);
  }

  /** 共通再生処理。欠損・再生失敗はログを残しその回をスキップする。 */
  #play(key: SoundKey): void {
    const filePath = join(this.#soundsDir, SOUND_FILES[key]);
    if (!this.#fileExists(filePath)) {
      this.#logger.warn({ key, filePath }, '音源ファイルが見つからないため再生をスキップします');
      return;
    }
    try {
      const resource = this.#createResource(filePath);
      this.#player.play(resource); // 多重再生は上書き (audio-spec)
    } catch (err) {
      this.#logger.error({ err, key, filePath }, '通知音の再生に失敗しました');
    }
  }
}
