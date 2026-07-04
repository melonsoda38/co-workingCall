import type { AutoStartConfig, TimerConfig, VolumeConfig } from '@co-working-call/shared';

/**
 * config.json 未存在時にコード側が組む初期値 (apps/bot 固有)。
 * shared スキーマの `.default()` は「既存 config の欠損フィールド補完」用の別レイヤで、
 * こちらは /pomo init やモーダル placeholder など「新規に値を用意する」ときの起点。
 * 重複定義を避けるため 1 箇所に集約する。
 */

/** 初期タイマー設定 (commands-spec モーダル placeholder: 50/10/2/15 分)。 */
export const DEFAULT_TIMER_CONFIG: TimerConfig = {
  workSec: 50 * 60,
  breakSec: 10 * 60,
  sets: 2,
  finalBreakSec: 15 * 60,
};

/** 初期音量設定 (全音 0dB = 原音)。 */
export const DEFAULT_VOLUME_CONFIG: VolumeConfig = {
  workEnd: 0,
  breakEnd: 0,
  finalStart: 0,
  countdownWarning: 0,
  finish: 0,
};

/** 初期自動スタート設定 (無効・お知らせ文字は既定)。 */
export const DEFAULT_AUTO_START: AutoStartConfig = { time: null, label: '自動スタート' };

/** 基準となる実行権限ロール名 (config 未確定時のフォールバック)。 */
export const DEFAULT_ADMIN_ROLE_NAME = 'pomo-admin';
