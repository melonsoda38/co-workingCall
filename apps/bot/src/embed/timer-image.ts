import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import type { BotConfig, TimerPhase, TimerSnapshot } from '@co-working-call/shared';

/**
 * canvas のテキスト描画に使う日本語フォント名。
 *
 * canvas は OS にインストールされたフォントから字形を探すため、既定の 'sans-serif'
 * (DejaVu Sans 等) では日本語が豆腐 (□) になる。システムに 'Noto Sans CJK JP' が
 * あればそれを使い、無ければ 'sans-serif' にフォールバック (数字は出るが日本語は化ける)。
 *
 * Raspberry Pi 等へ移設する際は `fonts-noto-cjk` のインストールが必要。
 */
export const TIMER_IMAGE_FONT = GlobalFonts.has('Noto Sans CJK JP')
  ? 'Noto Sans CJK JP'
  : 'sans-serif';

/** 画像サイズ (正方形)。 */
export const TIMER_IMAGE_SIZE = 256;

/** フェーズ別のリング色 (16進文字列。timer-embed の phaseColor と対応)。 */
export function phaseColorHex(phase: TimerPhase): string {
  switch (phase) {
    case 'work':
      return '#3498db';
    case 'break':
      return '#2ecc71';
    case 'finalBreak':
      return '#95a5a6';
    case 'countdown':
      return '#f1c40f';
    case 'idle':
    case 'ended':
      return '#95a5a6';
  }
}

/** フェーズ総時間 (ms)。進捗率の分母。US-3 の区間長に一致させる。 */
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

/** 進捗率 (経過割合 0..1)。countdown は満杯 (1)、総時間 0 のフェーズは 0。 */
export function progressRatio(snapshot: TimerSnapshot, config: BotConfig): number {
  if (snapshot.phase === 'countdown') {
    return 1;
  }
  const total = phaseTotalMs(snapshot, config);
  if (total <= 0) {
    return 0;
  }
  const ratio = 1 - snapshot.remainingMs / total;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * 円の中央に出す主テキスト (分刻み)。countdown は「まもなく / 終了」の 2 行
 * (main に改行 \n を含む。renderTimerImage 側で行ごとに描画する)。
 */
export function centerText(snapshot: TimerSnapshot): { main: string; unit: string } {
  switch (snapshot.phase) {
    case 'work':
    case 'break':
    case 'finalBreak': {
      // 分刻み更新なので残りは分で表示 (端数は切り上げ: 残り 90 秒なら "2分")。
      const minutes = Math.max(0, Math.ceil(snapshot.remainingMs / 60_000));
      return { main: String(minutes), unit: '分' };
    }
    case 'countdown':
      return { main: 'まもなく\n終了', unit: '' };
    case 'idle':
    case 'ended':
      return { main: '-', unit: '' };
  }
}

/**
 * フェーズ名 (絵文字なし。canvas はカラー絵文字を描けないため平文)。
 * countdown は中央の「まもなく」だけで完結させるため下段は空。
 */
export function phaseTextPlain(snapshot: TimerSnapshot): string {
  switch (snapshot.phase) {
    case 'work':
      return '作業中';
    case 'break':
      return '休憩中';
    case 'finalBreak':
      return '最終休憩';
    case 'countdown':
    case 'idle':
    case 'ended':
      return '';
  }
}

/** セット進捗 ("N/M" / それ以外は空。countdown は中央「まもなく」のみで下段なし)。 */
export function setText(snapshot: TimerSnapshot): string {
  switch (snapshot.phase) {
    case 'work':
    case 'break':
      return `${String(snapshot.currentSet)}/${String(snapshot.totalSets)}`;
    case 'finalBreak':
    case 'countdown':
    case 'idle':
    case 'ended':
      return '';
  }
}

/**
 * 「中央に残り時間 + フェーズ + セット、外周に進捗リング」の PNG を描画して返す。
 * 分刻み更新前提 (秒は表示しない)。背景は Discord ダークテーマ調の角丸カード。
 */
export function renderTimerImage(snapshot: TimerSnapshot, config: BotConfig): Buffer {
  const size = TIMER_IMAGE_SIZE;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // 背景 (角丸ダークカード。light/dark どちらのテーマでも読めるよう自前で塗る)。
  ctx.fillStyle = '#2b2d31';
  const radius = 24;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.fill();

  const cx = size / 2;
  const cy = size / 2;
  const ringRadius = 96;
  const ringWidth = 20;
  const color = phaseColorHex(snapshot.phase);
  const ratio = progressRatio(snapshot, config);

  // トラック (背景リング)。
  ctx.lineWidth = ringWidth;
  ctx.strokeStyle = '#40444b';
  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
  ctx.stroke();

  // 進捗リング (12時方向起点・時計回り)。
  // 注意: skia ベースの canvas では arc(..., s, s + 2π) (起点をずらした全周) は
  // start ≡ end と正規化され 0 長さ弧扱いで「何も描画されない」。よって ratio>=1 は
  // arc(..., 0, 2π) で全周を確実に描く (部分弧 ratio<1 のみ起点ずらしを使う)。
  if (ratio >= 1) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
  } else if (ratio > 0) {
    const start = -Math.PI / 2;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, start, start + Math.PI * 2 * ratio);
    ctx.stroke();
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 中央: 残り時間 (大) + 単位 (小)。main は改行 (\n) を含み得る (countdown の「まもなく/終了」)。
  const { main, unit } = centerText(snapshot);
  const mainLines = main.split('\n');
  const mainIsLong = mainLines.some((line) => line.length >= 3); // 長い文字列はフォントを小さく。
  const fontPx = mainIsLong ? 36 : 56;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${String(fontPx)}px "${TIMER_IMAGE_FONT}"`;
  if (mainLines.length === 1) {
    // 単一行: 下に単位を置く前提で少し上寄せ。
    ctx.fillText(main, cx, cy - 16);
  } else {
    // 複数行 (countdown): 円の中央に行ブロックを縦中央寄せ。
    const lineHeight = fontPx + 6;
    const top = cy - ((mainLines.length - 1) * lineHeight) / 2;
    mainLines.forEach((line, i) => {
      ctx.fillText(line, cx, top + i * lineHeight);
    });
  }
  if (unit) {
    ctx.font = `20px "${TIMER_IMAGE_FONT}"`;
    ctx.fillText(unit, cx, cy + 24);
  }

  // 下段: フェーズ名 + セット。
  ctx.fillStyle = '#b9bbbe';
  ctx.font = `20px "${TIMER_IMAGE_FONT}"`;
  const phase = phaseTextPlain(snapshot);
  const set = setText(snapshot);
  const sub = set ? `${phase}  ${set}` : phase;
  if (sub) {
    ctx.fillText(sub, cx, cy + 56);
  }

  return canvas.toBuffer('image/png');
}
