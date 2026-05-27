import {
  EmbedBuilder,
  MessageFlags,
  type APIEmbedField,
  type BaseMessageOptions,
  type MessageCreateOptions,
} from 'discord.js';
import type { BotConfig, TimerPhase, TimerSnapshot } from '@co-working-call/shared';
import { formatConfigSummary } from './start-embed.js';

/** 残りミリ秒を MM:SS に整形する (負値は 00:00)。 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 経過率 (0..1、範囲外は clamp) を ▰▱ の進捗バーにする。 */
export function progressBar(ratio: number, size = 10): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  const filled = Math.round(clamped * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

/**
 * フェーズ名表記 (絵文字 + 短い日本語)。
 * セット番号は別フィールド (setProgress) に分離するためここには含めない。
 */
export function phaseLabel(snapshot: TimerSnapshot): string {
  switch (snapshot.phase) {
    case 'work':
      return '🔥 作業中';
    case 'break':
      return '☕ 休憩中';
    case 'finalBreak':
      return '🌙 最終休憩';
    case 'countdown':
      return '⏰ もうすぐ終了';
    case 'idle':
    case 'ended':
      return '🍅 ポモドーロタイマー';
  }
}

/**
 * セット進捗表記 (Fields の「セット」列用)。
 * - work / break: "N/M" (現在のセット番号 / 総セット数)
 * - finalBreak / countdown: 「最終」 (セット概念を超えた最終局面のため)
 * - idle / ended: "—" (Timer Embed は表示しないが安全のため埋める)
 */
export function setProgress(snapshot: TimerSnapshot): string {
  switch (snapshot.phase) {
    case 'work':
    case 'break':
      return `${String(snapshot.currentSet)}/${String(snapshot.totalSets)}`;
    case 'finalBreak':
    case 'countdown':
      return '最終';
    case 'idle':
    case 'ended':
      return '—';
  }
}

/**
 * フェーズ別 Embed カラー (左の縦バーに反映され、一目でフェーズ判別できる)。
 * - work: 赤系 (作業=熱量)
 * - break: 緑系 (休憩=リラックス)
 * - finalBreak: 青系 (最終休憩=落ち着き)
 * - countdown: 黄系 (終了予告=注意喚起)
 * - idle / ended: 灰系
 */
export function phaseColor(phase: TimerPhase): number {
  switch (phase) {
    case 'work':
      return 0xe74c3c;
    case 'break':
      return 0x2ecc71;
    case 'finalBreak':
      return 0x3498db;
    case 'countdown':
      return 0xf1c40f;
    case 'idle':
    case 'ended':
      return 0x95a5a6;
  }
}

/** フェーズ総時間 (ms)。進捗率算出用。US-3 の区間長に一致させる。 */
function phaseTotalMs(snapshot: TimerSnapshot, config: BotConfig): number {
  const { workSec, breakSec, finalBreakSec } = config.default;
  switch (snapshot.phase) {
    case 'work':
      return workSec * 1000;
    case 'break':
      return breakSec * 1000;
    case 'finalBreak':
      return Math.max(0, finalBreakSec * 1000 - 10_000);
    case 'countdown':
      return 10_000;
    case 'idle':
    case 'ended':
      return 0;
  }
}

/** Discord field の name 非表示化 / 空行保持に使う zero-width space。 */
const ZWSP = '\u200B';

/**
 * Embed 本文と components (新規投稿・edit 共通の中身)。
 * レイアウト (embed-spec §2):
 * - title: "🍅 ポモドーロタイマー" (固定)
 * - color: フェーズ別 (phaseColor)
 * - description: zero-width space 1 文字。タイトル直下と fields 開始位置の
 *   間に 1 行分の空白を作るためだけに使う (実コンテンツは fields 側に置く)。
 * - fields:
 *   1〜3. (inline) 残り / フェーズ / セット (左から横並び)
 *        残りは平文 "MM:SS"。Embed field の value は Markdown 見出し (#, ##) が
 *        レンダリングされないため、`## MM:SS` のような記法は使わない。
 *   4. (block) 進捗バー。inline 行の下に独立行で配置 (name は zero-width space
 *      で非表示化)。
 *   5. (block) 設定サマリ。進捗バーから 1 行分の空行を挟む (value 先頭の
 *      `<ZWSP>\n` で空行 x1 を作る。Discord は通常の空行を trim するため
 *      zero-width space を挟んで保持させる)。
 * - footer は使わない (自動セパレータ付きで間隔を制御しにくいため)。
 */
export function buildTimerEmbedContent(
  snapshot: TimerSnapshot,
  config: BotConfig,
): BaseMessageOptions {
  const isCountdown = snapshot.phase === 'countdown';
  const total = phaseTotalMs(snapshot, config);

  let ratio: number;
  if (isCountdown) {
    ratio = 1;
  } else if (total > 0) {
    ratio = 1 - snapshot.remainingMs / total;
  } else {
    ratio = 0;
  }
  const remaining = isCountdown ? '──' : formatRemaining(snapshot.remainingMs);

  const fields: APIEmbedField[] = [
    { name: '残り', value: remaining, inline: true },
    { name: 'フェーズ', value: phaseLabel(snapshot), inline: true },
    { name: 'セット', value: setProgress(snapshot), inline: true },
    { name: ZWSP, value: progressBar(ratio), inline: false },
    {
      name: ZWSP,
      value: `${ZWSP}\n${formatConfigSummary(config)}`,
      inline: false,
    },
  ];

  const embed = new EmbedBuilder()
    .setTitle('🍅 ポモドーロタイマー')
    .setColor(phaseColor(snapshot.phase))
    // description は title と最初の field の間に 1 行分の空白を作るためだけに使う。
    .setDescription(ZWSP)
    .addFields(fields);

  // 作業中タイマー Embed にはボタンを置かない (設定アイコンは廃止)。
  return { embeds: [embed] };
}

/** 作業中タイマー用 Embed メッセージ (新規投稿用。SuppressNotifications 付き)。 */
export function buildTimerEmbedMessage(
  snapshot: TimerSnapshot,
  config: BotConfig,
): MessageCreateOptions {
  return {
    ...buildTimerEmbedContent(snapshot, config),
    flags: MessageFlags.SuppressNotifications,
  };
}
