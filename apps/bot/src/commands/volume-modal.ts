import {
  ButtonInteraction,
  LabelBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { Logger } from 'pino';
import type { VolumeConfig } from '@co-working-call/shared';
import { z } from 'zod';
import { DEFAULT_VOLUME_CONFIG } from '../config/index.js';
import type { VoiceSession } from '../voice/session-registry.js';
import { requireConfigAdminForButton, runConfigModalSubmit } from './interaction-helpers.js';

export const VOLUME_MODAL_ID = 'pomo_volume_modal';
export const WORK_END_VOL_ID = 'vol_work_end';
export const BREAK_END_VOL_ID = 'vol_break_end';
export const FINAL_START_VOL_ID = 'vol_final_start';
export const COUNTDOWN_VOL_ID = 'vol_countdown';
export const FINISH_VOL_ID = 'vol_finish';

function volumeField(id: string, labelText: string, value: number): LabelBuilder {
  return new LabelBuilder().setLabel(labelText).setTextInputComponent(
    new TextInputBuilder()
      .setCustomId(id)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      // "-50" の 3 文字を許容。
      .setMaxLength(3)
      .setValue(String(value)),
  );
}

/**
 * 音量設定モーダル。5種の通知音をそれぞれ ±50dB で調整する。
 * Discord のモーダルは最大5フィールドのため、5音でちょうど上限いっぱい。
 * 正方向 (増幅) は音源が大きいと歪みやすいため、ラベルに範囲を明記する。
 */
export function buildVolumeModal(volumes: VolumeConfig): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(VOLUME_MODAL_ID)
    .setTitle('🔊 音量設定（dB: -50〜50）')
    .addLabelComponents(
      volumeField(WORK_END_VOL_ID, '休憩開始（dB）', volumes.workEnd),
      volumeField(BREAK_END_VOL_ID, '作業開始（dB）', volumes.breakEnd),
      volumeField(FINAL_START_VOL_ID, '最終休憩へ（dB）', volumes.finalStart),
      volumeField(COUNTDOWN_VOL_ID, 'まもなく終了（dB）', volumes.countdownWarning),
      volumeField(FINISH_VOL_ID, '終了（dB）', volumes.finish),
    );
}

// 空文字は coerce すると 0 になり範囲 (-50〜50) を通ってしまうため、整数文字列のみ受理する
// (符号付き整数の正規表現で弾いてから数値化する)。小数・空・非数値はここで拒否される。
const VolumeDbField = z
  .string()
  .trim()
  .regex(/^-?\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(-50).max(50));

const VolumeModalSchema = z.object({
  workEnd: VolumeDbField,
  breakEnd: VolumeDbField,
  finalStart: VolumeDbField,
  countdownWarning: VolumeDbField,
  finish: VolumeDbField,
});

const FIELD_ERROR: Record<string, string> = {
  workEnd: '休憩開始は-50〜50の整数(dB)で入力してください',
  breakEnd: '作業開始は-50〜50の整数(dB)で入力してください',
  finalStart: '最終休憩へは-50〜50の整数(dB)で入力してください',
  countdownWarning: 'まもなく終了は-50〜50の整数(dB)で入力してください',
  finish: '終了は-50〜50の整数(dB)で入力してください',
};

/**
 * モーダル入力 (dB・文字列) を検証し VolumeConfig を返す純粋関数。
 * エラーはフィールド別文言で返す (settings-modal と同方式)。
 */
export function parseVolumeModalInput(raw: {
  workEnd: string;
  breakEnd: string;
  finalStart: string;
  countdownWarning: string;
  finish: string;
}): { ok: true; volumes: VolumeConfig } | { ok: false; errors: string[] } {
  const result = VolumeModalSchema.safeParse(raw);
  if (!result.success) {
    const fields = new Set(result.error.issues.map((issue) => String(issue.path[0])));
    const errors = [...fields].map((field) => FIELD_ERROR[field] ?? '入力値が不正です');
    return { ok: false, errors };
  }
  return { ok: true, volumes: result.data };
}

/**
 * 音量設定ボタン (pomo_volume_open) 押下: 現在の音量を入れたモーダルを表示。
 * 認可は設定ボタン (handleSettingsButton) と同じ許可ロール方式・同じ Start Embed 取り込みを行う。
 */
export async function handleVolumeButton(
  interaction: ButtonInteraction,
  session: VoiceSession | undefined,
  configDir: string,
  logger: Logger,
): Promise<void> {
  try {
    // 認可は設定ボタンと同じ config ベースの許可ロール方式 (config 未確定は pomo-admin フォールバック)。
    const ctx = await requireConfigAdminForButton({ interaction, configDir, logger });
    if (!ctx) {
      return;
    }
    const { config } = ctx;

    session?.embedManager.adoptStartEmbed(interaction.message.id);
    const volumes = config?.volumes ?? DEFAULT_VOLUME_CONFIG;
    await interaction.showModal(buildVolumeModal(volumes));
  } catch (err) {
    logger.error({ err }, '音量設定モーダルの表示に失敗しました');
  }
}

/**
 * 音量モーダル送信 (pomo_volume_modal): 検証 → config.volumes 更新 → ephemeral 応答 →
 * Start Embed 投稿し直し。音量自体の再生反映は次セッション (▶開始時の setVolumes) で行う。
 * session 未注入 / repost 失敗は best-effort (config 保存は完了扱い)。
 */
export async function handleVolumeModalSubmit(
  interaction: ModalSubmitInteraction,
  session: VoiceSession | undefined,
  configDir: string,
  logger: Logger,
): Promise<void> {
  await runConfigModalSubmit({
    interaction,
    session,
    configDir,
    logger,
    parse: () => {
      const r = parseVolumeModalInput({
        workEnd: interaction.fields.getTextInputValue(WORK_END_VOL_ID),
        breakEnd: interaction.fields.getTextInputValue(BREAK_END_VOL_ID),
        finalStart: interaction.fields.getTextInputValue(FINAL_START_VOL_ID),
        countdownWarning: interaction.fields.getTextInputValue(COUNTDOWN_VOL_ID),
        finish: interaction.fields.getTextInputValue(FINISH_VOL_ID),
      });
      return r.ok ? { ok: true, value: r } : r;
    },
    buildUpdated: (config, value) => ({ ...config, volumes: value.volumes }),
    successMessage: '音量設定を保存しました ✅（次のタイマー開始から反映されます）',
    errorMessage: '音量設定の保存に失敗しました。ログを確認してください',
    errorLogMessage: '音量モーダル処理に失敗しました',
    logMessage: '音量モーダルで config を更新しました',
    logContext: (updated) => ({ volumes: updated.volumes }),
  });
}
