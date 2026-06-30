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
import type { VoiceSession } from '../voice/session-registry.js';
import { buildAllowedRoleNames, buttonRoleRequiredMessage, hasAnyAdminRole } from './checks.js';
import { scheduleEphemeralAutoDelete } from './ephemeral.js';

export const SETTINGS_MODAL_ID = 'pomo_settings_modal';
export const WORK_MIN_ID = 'work_min';
export const BREAK_MIN_ID = 'break_min';
export const SETS_ID = 'sets';
export const FINAL_MIN_ID = 'final_min';
export const AUTO_START_TIME_ID = 'auto_start_time';

/** 自動スタート時刻の入力形式 (JST "HH:MM" 24時間表記)。 */
const AUTO_START_TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const AUTO_START_TIME_ERROR = '自動スタート時刻はHH:MM形式（例 07:30）で入力してください';

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

/** 任意入力フィールド (空欄送信を許す)。自動スタート時刻用。 */
function optionalLabelField(
  id: string,
  labelText: string,
  value: string,
  placeholder: string,
  maxLength: number,
): LabelBuilder {
  return new LabelBuilder()
    .setLabel(labelText)
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId(id)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(maxLength)
        .setPlaceholder(placeholder)
        .setValue(value),
    );
}

/**
 * タイマー設定モーダル (commands-spec §タイマー設定モーダル)。
 * 5番目に自動スタート時刻 (JST "HH:MM"、任意) を持つ。空欄送信で自動スタート無効。
 * Discord のモーダルは最大5フィールドのため、これで上限いっぱい。
 */
export function buildSettingsModal(timer: TimerConfig, autoStartTime: string | null): ModalBuilder {
  const min = (sec: number): string => String(Math.round(sec / 60));
  return new ModalBuilder()
    .setCustomId(SETTINGS_MODAL_ID)
    .setTitle('🍅 タイマー設定')
    .addLabelComponents(
      // 全フィールドの最大は 999 → 入力長 3 桁。
      labelField(WORK_MIN_ID, '作業時間（分）', min(timer.workSec), 3),
      labelField(BREAK_MIN_ID, '休憩時間（分）', min(timer.breakSec), 3),
      labelField(SETS_ID, 'セット数', String(timer.sets), 3),
      labelField(FINAL_MIN_ID, '最終休憩（分）', min(timer.finalBreakSec), 3),
      // "HH:MM" の 5 文字。空欄で自動スタート無効。
      optionalLabelField(
        AUTO_START_TIME_ID,
        '自動スタート時刻（JST・任意・空欄で無効）',
        autoStartTime ?? '',
        '07:30',
        5,
      ),
    );
}

const SettingsModalSchema = z.object({
  workMin: z.coerce.number().int().min(1).max(999),
  breakMin: z.coerce.number().int().min(1).max(999),
  sets: z.coerce.number().int().min(1).max(999),
  finalMin: z.coerce.number().int().min(1).max(999),
});

const FIELD_ERROR: Record<string, string> = {
  workMin: '作業時間は1〜999分の整数で入力してください',
  breakMin: '休憩時間は1〜999分の整数で入力してください',
  sets: 'セット数は1〜999の整数で入力してください',
  finalMin: '最終休憩は1〜999分の整数で入力してください',
};

/** 自動スタート時刻 (任意) を検証する。空 → null (無効化)、非空 → HH:MM 検証。 */
function parseAutoStartTime(raw: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, value: null };
  }
  return AUTO_START_TIME_REGEX.test(trimmed) ? { ok: true, value: trimmed } : { ok: false };
}

/**
 * モーダル入力 (分・文字列) を検証し TimerConfig (秒) と自動スタート時刻を返す純粋関数。
 * エラーは commands-spec のフィールド別文言で返す。autoStartTime は空欄で null (自動スタート無効)。
 */
export function parseSettingsModalInput(raw: {
  workMin: string;
  breakMin: string;
  sets: string;
  finalMin: string;
  autoStartTime: string;
}):
  | { ok: true; timer: TimerConfig; autoStartTime: string | null }
  | { ok: false; errors: string[] } {
  const result = SettingsModalSchema.safeParse({
    workMin: raw.workMin,
    breakMin: raw.breakMin,
    sets: raw.sets,
    finalMin: raw.finalMin,
  });
  const time = parseAutoStartTime(raw.autoStartTime);
  if (!result.success || !time.ok) {
    const errors: string[] = [];
    if (!result.success) {
      const fields = new Set(result.error.issues.map((issue) => String(issue.path[0])));
      errors.push(...[...fields].map((field) => FIELD_ERROR[field] ?? '入力値が不正です'));
    }
    if (!time.ok) {
      errors.push(AUTO_START_TIME_ERROR);
    }
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
  return { ok: true, timer: parsed.data, autoStartTime: time.value };
}

/**
 * 設定ボタン (pomo_settings_open) 押下: 現設定を入れたモーダルを表示。
 *
 * 設定変更は /pomo と同じ許可ロール保持者に限定する。Discord はボタンを
 * ロール別に非表示にできないため、押下時にロールを判定し、権限が無ければ
 * モーダルを開かず ephemeral で弾く方式 (▶開始ボタンと同じ pattern)。
 *
 * 認可後は押下された Start Embed の id を EmbedManager に取り込む。
 * これをやらないと、bot 再起動後など #startEmbedId が null の状態でモーダル保存しても
 * repostStartEmbed が早期 return し、設定変更後の Start Embed 再投稿が動かない
 * (start-button.ts と対称形)。
 */
export async function handleSettingsButton(
  interaction: ButtonInteraction,
  session: VoiceSession | undefined,
  configPath: string,
  logger: Logger,
): Promise<void> {
  const replyEphemeral = async (content: string): Promise<void> => {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    scheduleEphemeralAutoDelete(interaction, logger);
  };

  try {
    const guild = interaction.guild;
    if (!guild) {
      await replyEphemeral('サーバー内で実行してください');
      return;
    }

    // 許可ロールは config から決める (session 未注入=READY 前 でも判定できるよう
    // loadConfig を基準にする)。config 未確定時は基準ロール pomo-admin にフォールバック。
    const existing = await loadConfig(configPath);
    const config = existing.status === 'ok' ? existing.config : undefined;
    const allowedRoles = buildAllowedRoleNames(
      config?.adminRoleName ?? 'pomo-admin',
      config?.adminRoleNames ?? [],
    );
    const member = await guild.members.fetch(interaction.user.id);
    const roleNames = member.roles.cache.map((role) => role.name);
    if (!hasAnyAdminRole(roleNames, allowedRoles)) {
      await replyEphemeral(buttonRoleRequiredMessage(allowedRoles));
      return;
    }

    session?.embedManager.adoptStartEmbed(interaction.message.id);
    const timer = config?.default ?? DEFAULT_TIMER;
    const autoStartTime = config?.autoStart.time ?? null;
    await interaction.showModal(buildSettingsModal(timer, autoStartTime));
  } catch (err) {
    logger.error({ err }, '設定モーダルの表示に失敗しました');
  }
}

/**
 * モーダル送信 (pomo_settings_modal): 検証 → config 更新 → ephemeral 応答 →
 * Start Embed 投稿し直し (最新 config で表示)。
 * session 未注入 (READY 前 / config 未確定) なら Embed 投稿し直しはスキップ
 * (config 保存は完了しているので、再起動 or 次回 /pomo init で反映される)。
 * Embed 再投稿の失敗は best-effort: warn ログのみで例外を握りつぶす
 * (config 保存自体はユーザーに成功通知済みのため、ここで失敗扱いに格上げしない)。
 */
export async function handleSettingsModalSubmit(
  interaction: ModalSubmitInteraction,
  session: VoiceSession | undefined,
  configPath: string,
  logger: Logger,
): Promise<void> {
  try {
    const result = parseSettingsModalInput({
      workMin: interaction.fields.getTextInputValue(WORK_MIN_ID),
      breakMin: interaction.fields.getTextInputValue(BREAK_MIN_ID),
      sets: interaction.fields.getTextInputValue(SETS_ID),
      finalMin: interaction.fields.getTextInputValue(FINAL_MIN_ID),
      autoStartTime: interaction.fields.getTextInputValue(AUTO_START_TIME_ID),
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

    const updated: BotConfig = {
      ...existing.config,
      default: result.timer,
      autoStart: { ...existing.config.autoStart, time: result.autoStartTime },
    };
    await saveConfig(configPath, updated);
    // 自動スタート時刻の変更を稼働中スケジューラへ即反映 (再起動不要)。
    session?.autoStartScheduler.schedule(updated.autoStart.time);
    await interaction.reply({
      content: '設定を保存しました ✅',
      flags: MessageFlags.Ephemeral,
    });
    logger.info(
      { default: updated.default, autoStart: updated.autoStart },
      '設定モーダルで config を更新しました',
    );

    // 最新 config で Start Embed を投稿し直す (ephemeral 応答後に実行し、
    // チャンネル最下部に最新版 Embed を露出させる)。
    // session 不在 (READY 前) or 失敗時は warn のみ・ユーザー応答は成功扱いのまま。
    if (session) {
      try {
        await session.embedManager.repostStartEmbed(updated);
      } catch (repostErr) {
        logger.warn(
          { err: repostErr },
          'Start Embed の投稿し直しに失敗 (best-effort、config 保存は完了)',
        );
      }
    }
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
  } finally {
    // 設定モーダル送信の ephemeral 応答を 14 分後に自動削除する。
    scheduleEphemeralAutoDelete(interaction, logger);
  }
}
