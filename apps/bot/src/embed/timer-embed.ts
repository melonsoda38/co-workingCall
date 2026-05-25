import {
  EmbedBuilder,
  MessageFlags,
  type BaseMessageOptions,
  type MessageCreateOptions,
} from 'discord.js';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
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

/** フェーズ表示テキスト (embed-spec §2)。 */
export function phaseLabel(snapshot: TimerSnapshot): string {
  const { phase, currentSet, totalSets } = snapshot;
  switch (phase) {
    case 'work':
      return `🔥 作業中 (${String(currentSet)}/${String(totalSets)})`;
    case 'break':
      return `☕ 休憩中 (${String(currentSet)}/${String(totalSets)})`;
    case 'finalBreak':
      return '🌙 最終休憩';
    case 'countdown':
      return '⏰ もうすぐ終了';
    case 'idle':
    case 'ended':
      return '🍅 ポモドーロタイマー';
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

/** Embed 本文と components (新規投稿・edit 共通の中身)。 */
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

  const embed = new EmbedBuilder()
    .setTitle('🍅 ポモドーロタイマー')
    .setDescription(`${phaseLabel(snapshot)}\n残り ${remaining}\n${progressBar(ratio)}`)
    .setFooter({ text: formatConfigSummary(config) });

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
