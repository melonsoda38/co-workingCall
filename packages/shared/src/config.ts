import { z } from 'zod';
import { TimerConfigSchema } from './timer.js';

/** 通知音1種あたりの音量補正 (dB)。0=原音、負=減衰、正=増幅。範囲は ±50dB。 */
const VolumeDbSchema = z.number().int().min(-50).max(50).default(0);

/**
 * 5種の通知音 (audio-spec) ごとの音量補正 (dB)。音量設定モーダルで調整し config.json に永続化、
 * 次セッション (▶開始) 開始時に SoundPlayer へ反映する。キーは apps/bot の SoundKey と一致。
 * 各フィールドに default(0) があるため volumes 自体を持たない既存 config も後方互換でロードできる。
 */
export const VolumeConfigSchema = z
  .object({
    workEnd: VolumeDbSchema,
    breakEnd: VolumeDbSchema,
    finalStart: VolumeDbSchema,
    countdownWarning: VolumeDbSchema,
    finish: VolumeDbSchema,
  })
  .default({});
export type VolumeConfig = z.infer<typeof VolumeConfigSchema>;

/**
 * 指定時刻による毎日のタイマー自動スタート設定。
 * time は日本時間 (JST) の "HH:MM" (24時間表記)。null のとき自動スタートは無効。
 * label はリセットを伴う自動スタート時のお知らせメッセージに差し込む文字列 ("xx")。
 * autoStart 自体に default({}) があるため、autoStart を持たない既存 config も後方互換でロードできる。
 */
export const AutoStartConfigSchema = z
  .object({
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .default(null),
    label: z.string().min(1).default('自動スタート'),
  })
  .default({});
export type AutoStartConfig = z.infer<typeof AutoStartConfigSchema>;

/**
 * 永続化設定 (config.json)。初回起動時は存在せず /pomo init 実行時に生成される。
 * adminRoleName は基準となる実行権限ロール名 (既定 'pomo-admin'、常に許可)。
 * adminRoleNames は /pomo admin-role で追加した許可ロール名の一覧 (既定 [])。
 * いずれかのロールを持つメンバーが /pomo 系コマンドを実行できる。
 * volumes は 5種の通知音の音量補正 (dB)。未指定時は全て 0 (原音) で埋まる。
 * autoStart は指定時刻による毎日の自動スタート設定。未指定時は無効 (time=null) で埋まる。
 */
export const BotConfigSchema = z.object({
  default: TimerConfigSchema,
  guildId: z.string().min(1),
  voiceChannelId: z.string().min(1),
  adminRoleName: z.string().min(1).default('pomo-admin'),
  adminRoleNames: z.array(z.string().min(1)).default([]),
  volumes: VolumeConfigSchema,
  autoStart: AutoStartConfigSchema,
});
export type BotConfig = z.infer<typeof BotConfigSchema>;
