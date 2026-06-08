import {
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  type BaseMessageOptions,
  type MessageCreateOptions,
} from 'discord.js';
import type { BotConfig, TimerPhase, TimerSnapshot } from '@co-working-call/shared';
import { formatConfigSummary } from './start-embed.js';
import { phaseColorHex, renderTimerImage } from './timer-image.js';

/** タイマー画像の添付ファイル名 (Embed から attachment:// で参照する)。 */
export const TIMER_IMAGE_NAME = 'timer.png';

/** 「続行」ボタンの customId (最終休憩カードに表示。US-続行)。 */
export const CONTINUE_BUTTON_ID = 'pomo_continue';

/** 最終休憩で続行ボタンの上 (画像の下) に太字表示する続行案内テキスト。 */
export const CONTINUE_PROMPT_TEXT = '続ける場合:';

/**
 * Components V2 で組むフェーズ。
 * finalBreak は「続ける場合:」+続行ボタンを画像の下に置くために V2 Container にする。
 * countdown も V2 にする理由: finalBreak→countdown は同一メッセージの edit で遷移するため、
 * V2 メッセージを Embed へ edit で戻せない (IsComponentsV2 は不変)。よって両者を V2 に揃える。
 */
function isComponentsV2Phase(phase: TimerPhase): boolean {
  return phase === 'finalBreak' || phase === 'countdown';
}

/** phaseColorHex ("#rrggbb") を Embed/Container 用の数値カラーに変換する。 */
function phaseColorNumber(phase: TimerPhase): number {
  return Number.parseInt(phaseColorHex(phase).slice(1), 16);
}

/** 「続行」ボタン (最終休憩カードのみ付与)。 */
function buildContinueButton(): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(CONTINUE_BUTTON_ID)
    .setStyle(ButtonStyle.Success)
    .setLabel('続行');
}

/**
 * finalBreak / countdown 用の Components V2 Container を組む。
 * 構成 (上から): タイトル → 円形タイマー画像 → 設定サマリ (subtext)
 *   → (finalBreak のみ) 太字「続ける場合:」→ (finalBreak のみ) 続行ボタン。
 * accentColor はフェーズ色 (Embed 左バー相当)。
 */
function buildTimerContainer(snapshot: TimerSnapshot, config: BotConfig): ContainerBuilder {
  const container = new ContainerBuilder()
    .setAccentColor(phaseColorNumber(snapshot.phase))
    .addTextDisplayComponents((t) => t.setContent('**Timer**'))
    .addMediaGalleryComponents((g) =>
      g.addItems((i) => i.setURL(`attachment://${TIMER_IMAGE_NAME}`)),
    )
    // footer 相当の設定サマリは subtext (-#) で小さい灰文字にして従来の見た目に寄せる。
    .addTextDisplayComponents((t) => t.setContent(`-# ${formatConfigSummary(config)}`));

  if (snapshot.phase === 'finalBreak') {
    container
      .addTextDisplayComponents((t) => t.setContent(`**${CONTINUE_PROMPT_TEXT}**`))
      .addActionRowComponents((r) => r.addComponents(buildContinueButton()));
  }
  return container;
}

/**
 * タイマーカードの本文・添付 (新規投稿・edit 共通の中身)。
 *
 * work / break: 従来の Embed。
 * - title: "Timer" / color: フェーズ別左バー / image: 円形タイマー画像
 * - footer: 設定サマリ "作業X分 / 休憩Y分 / Mセット / 最終休憩Z分"
 *
 * finalBreak / countdown: Components V2 Container (buildTimerContainer)。
 * - 画像の下・続行ボタンの上に太字「続ける場合:」を置くため V2 化 (Embed footer は太字不可)。
 *
 * 画像は分刻み更新前提 (TimerEmbedUpdater の間隔 60 秒)。
 * components は **常に明示的に返す** (Embed フェーズは空配列、V2 は Container)。これにより
 * 同一フェーズ内の edit で付け外しが確実に反映される (フェーズ跨ぎは repost か V2↔V2 edit)。
 */
export function buildTimerEmbedContent(
  snapshot: TimerSnapshot,
  config: BotConfig,
): BaseMessageOptions {
  const png = renderTimerImage(snapshot, config);
  const attachment = new AttachmentBuilder(png, { name: TIMER_IMAGE_NAME });

  if (isComponentsV2Phase(snapshot.phase)) {
    return {
      components: [buildTimerContainer(snapshot, config)],
      files: [attachment],
    };
  }

  const embed = new EmbedBuilder()
    .setTitle('Timer')
    .setColor(phaseColorNumber(snapshot.phase))
    .setImage(`attachment://${TIMER_IMAGE_NAME}`)
    .setFooter({ text: formatConfigSummary(config) });

  return {
    embeds: [embed],
    files: [attachment],
    components: [],
  };
}

/**
 * 作業中タイマー用メッセージ (新規投稿用)。
 * V2 フェーズ (finalBreak/countdown) は IsComponentsV2 フラグが必須。常に SuppressNotifications。
 */
export function buildTimerEmbedMessage(
  snapshot: TimerSnapshot,
  config: BotConfig,
): MessageCreateOptions {
  const flags = isComponentsV2Phase(snapshot.phase)
    ? MessageFlags.SuppressNotifications | MessageFlags.IsComponentsV2
    : MessageFlags.SuppressNotifications;
  return {
    ...buildTimerEmbedContent(snapshot, config),
    flags,
  };
}
