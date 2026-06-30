import type { Logger } from 'pino';
import { loadConfig } from '../config/index.js';
import type { VoiceSession } from '../voice/session-registry.js';

/**
 * 指定時刻による自動スタートの実行本体 (AutoStartScheduler.onFire から呼ばれる)。
 * - 最新 config を読み込む (未設定/無効ならログのみで終了)。
 * - 稼働中セッションがあれば「お知らせ投稿 → リセット」で優先的に明け渡す。
 * - VC に人がいなくても bot を入室させ、現在設定でタイマーを開始する。
 * Start ボタンの handleStartButton と同じ ensureConnected → applyConfig → setVolumes →
 * timer.start のフローを、ロール/在室チェック無しで bot 主導に組み替えたもの。
 */
export async function runAutoStart(
  session: VoiceSession,
  configPath: string,
  logger: Logger,
): Promise<void> {
  try {
    const loaded = await loadConfig(configPath);
    if (loaded.status !== 'ok') {
      logger.warn({ status: loaded.status }, '自動スタート: config が無効なため中止します');
      return;
    }
    const config = loaded.config;

    // 終了演出中は phase が経路で異なるため、phase だけでなく isEnding も見て稼働判定する。
    const running = session.timer.getSnapshot().phase !== 'idle' || session.embedManager.isEnding;
    if (running) {
      // リセットを伴う場合のみ、リセット前にお知らせを投稿する。
      logger.info(
        { label: config.autoStart.label },
        '自動スタート: 稼働中セッションをリセットします',
      );
      await session.embedManager.postAutoStartResetNotice(config.autoStart.label);
      await session.embedManager.resetForRestart();
    }

    // VC に人がいなくても bot を入室させる。
    const connected = await session.voiceManager.ensureConnected();
    if (!connected) {
      logger.warn('自動スタート: VC 接続に失敗したため中止します');
      return;
    }

    // 設定モーダル/音量モーダルの最新値を反映してから開始する。
    session.embedManager.applyConfig(config);
    session.soundPlayer.setVolumes(config.volumes);

    // タイマー開始。phaseChange(work) で EmbedManager がタイマー Embed を投稿する。
    session.timer.start(config.default);
    logger.info({ guildId: config.guildId, default: config.default }, '自動スタートでタイマー開始');
  } catch (err) {
    logger.error({ err }, '自動スタートの実行に失敗しました');
  }
}
