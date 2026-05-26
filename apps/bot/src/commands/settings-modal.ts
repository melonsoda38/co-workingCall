import {
  ButtonInteraction,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { Logger } from 'pino';
import { TimerConfigSchema, type BotConfig, type TimerConfig } from '@co-working-call/shared';
import { z } from 'zod';
import { loadConfig, saveConfig } from '../config/index.js';

export const SETTINGS_MODAL_ID = 'pomo_settings_modal';
export const WORK_MIN_ID = 'work_min';
export const BREAK_MIN_ID = 'break_min';
export const SETS_ID = 'sets';
export const FINAL_MIN_ID = 'final_min';

/** config 未存在時のフォールバック (commands-spec モーダル placeholder: 50/10/2/15 分)。 */
const DEFAULT_TIMER: TimerConfig = {
  workSec: 50 * 60,
  breakSec: 10 * 60,
  sets: 2,
  finalBreakSec: 15 * 60,
};

function labelField(id: string, labelText: string, value: string, maxLength: number): LabelBuilder {
  return new LabelBuilder()
    .setLabel(labelText)
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId(id)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(maxLength)
        .setValue(value),
    );
}

/** タイマー設定モーダル (commands-spec §タイマー設定モーダル)。 */
export function buildSettingsModal(timer: TimerConfig): ModalBuilder {
  const min = (sec: number): string => String(Math.round(sec / 60));
  return new ModalBuilder()
    .setCustomId(SETTINGS_MODAL_ID)
    .setTitle('🍅 タイマー設定')
    .addLabelComponents(
      labelField(WORK_MIN_ID, '作業時間（分）', min(timer.workSec), 3),
      labelField(BREAK_MIN_ID, '休憩時間（分）', min(timer.breakSec), 3),
      labelField(SETS_ID, 'セット数', String(timer.sets), 2),
      labelField(FINAL_MIN_ID, '最終休憩（分）', min(timer.finalBreakSec), 3),
    );
}

const SettingsModalSchema = z.object({
  workMin: z.coerce.number().int().min(1).max(60),
  breakMin: z.coerce.number().int().min(1).max(30),
  sets: z.coerce.number().int().min(1).max(20),
  finalMin: z.coerce.number().int().min(1).max(30),
});

const FIELD_ERROR: Record<string, string> = {
  workMin: '作業時間は1〜60分の整数で入力してください',
  breakMin: '休憩時間は1〜30分の整数で入力してください',
  sets: 'セット数は1〜20の整数で入力してください',
  finalMin: '最終休憩は1〜30分の整数で入力してください',
};

/**
 * モーダル入力 (分・文字列) を検証し TimerConfig (秒) を返す純粋関数。
 * エラーは commands-spec のフィールド別文言で返す。
 */
export function parseSettingsModalInput(raw: {
  workMin: string;
  breakMin: string;
  sets: string;
  finalMin: string;
}): { ok: true; timer: TimerConfig } | { ok: false; errors: string[] } {
  const result = SettingsModalSchema.safeParse(raw);
  if (!result.success) {
    const fields = new Set(result.error.issues.map((issue) => String(issue.path[0])));
    const errors = [...fields].map((field) => FIELD_ERROR[field] ?? '入力値が不正です');
    return { ok: false, errors };
  }
  const timer = {
    workSec: result.data.workMin * 60,
    breakSec: result.data.breakMin * 60,
    sets: result.data.sets,
    finalBreakSec: result.data.finalMin * 60,
  };
  const parsed = TimerConfigSchema.safeParse(timer);
  if (!parsed.success) {
    return { ok: false, errors: ['設定値が不正です'] };
  }
  return { ok: true, timer: parsed.data };
}

/** 設定ボタン (pomo_settings_open) 押下: 現設定を入れたモーダルを表示。 */
export async function handleSettingsButton(
  interaction: ButtonInteraction,
  configPath: string,
  logger: Logger,
): Promise<void> {
  try {
    const existing = await loadConfig(configPath);
    const timer = existing.status === 'ok' ? existing.config.default : DEFAULT_TIMER;
    await interaction.showModal(buildSettingsModal(timer));
  } catch (err) {
    logger.error({ err }, '設定モーダルの表示に失敗しました');
  }
}

/** モーダル送信 (pomo_settings_modal): 検証 → config 更新 → ephemeral 応答。 */
export async function handleSettingsModalSubmit(
  interaction: ModalSubmitInteraction,
  configPath: string,
  logger: Logger,
): Promise<void> {
  try {
    const result = parseSettingsModalInput({
      workMin: interaction.fields.getTextInputValue(WORK_MIN_ID),
      breakMin: interaction.fields.getTextInputValue(BREAK_MIN_ID),
      sets: interaction.fields.getTextInputValue(SETS_ID),
      finalMin: interaction.fields.getTextInputValue(FINAL_MIN_ID),
    });
    if (!result.ok) {
      await interaction.reply({
        content: result.errors.join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const existing = await loadConfig(configPath);
    if (existing.status !== 'ok') {
      await interaction.reply({
        content: 'セットアップが必要です。先に /pomo init を実行してください',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const updated: BotConfig = { ...existing.config, default: result.timer };
    await saveConfig(configPath, updated);
    await interaction.reply({
      content: '設定を保存しました ✅',
      flags: MessageFlags.Ephemeral,
    });
    logger.info({ default: updated.default }, '設定モーダルで config を更新しました');
    // スタート用 Embed の内容更新は EmbedManager.updateStartEmbed で行うが、
    // EmbedManager 実インスタンスの結線は後続 US (全体結線) のため US-12 では未接続。
  } catch (err) {
    logger.error({ err }, '設定モーダル処理に失敗しました');
    if (!interaction.replied) {
      try {
        await interaction.reply({
          content: '設定の保存に失敗しました。ログを確認してください',
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyErr) {
        logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
      }
    }
  }
}
