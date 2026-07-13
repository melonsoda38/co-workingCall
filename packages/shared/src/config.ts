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

/**
 * guild ファイル内の VC 1件分の設定 (guild レベル項目 adminRole* を除いた per-VC 設定)。
 * BotConfig からギルド共通項目を差し引いた形。permanenceする際は guild ファイルの vcs 配列に並ぶ。
 */
export const VcConfigSchema = z.object({
  voiceChannelId: z.string().min(1),
  default: TimerConfigSchema,
  volumes: VolumeConfigSchema,
  autoStart: AutoStartConfigSchema,
});
export type VcConfig = z.infer<typeof VcConfigSchema>;

/**
 * guild ファイル1個 = 1 ギルド分の設定。config/<guildId>.json に永続化する。
 * adminRoleName / adminRoleNames は guild 全体で共有する実行権限ロール。
 * vcs は当該ギルドで運用する VC ごとの設定 (現状は各ギルド1件、将来 same-guild 複数VCで N件)。
 * bot は 1 ギルドにつき同時1VC接続までだが、ファイルは複数VC設定を同居できる構造にしておく。
 */
export const GuildConfigFileSchema = z.object({
  guildId: z.string().min(1),
  adminRoleName: z.string().min(1).default('pomo-admin'),
  adminRoleNames: z.array(z.string().min(1)).default([]),
  vcs: z.array(VcConfigSchema).min(1),
});
export type GuildConfigFile = z.infer<typeof GuildConfigFileSchema>;

/**
 * guild ファイルを VC 単位のフラットな BotConfig 配列へ展開する。
 * 下流 (EmbedManager 等) は従来通り BotConfig を消費するため、ファイル層との境界で合成する。
 */
export function toBotConfigs(file: GuildConfigFile): BotConfig[] {
  return file.vcs.map((vc) => ({
    default: vc.default,
    guildId: file.guildId,
    voiceChannelId: vc.voiceChannelId,
    adminRoleName: file.adminRoleName,
    adminRoleNames: file.adminRoleNames,
    volumes: vc.volumes,
    autoStart: vc.autoStart,
  }));
}

/**
 * フラットな BotConfig を guild ファイルへ反映する (same-guild 複数VC 同居アルゴリズムの中核)。
 * guild レベル項目 (adminRole*) を config の値で更新し、config.voiceChannelId をキーに
 * vcs を差し替え/追加する。base 未指定 (初回) は当該 VC のみを持つ新規ファイルを生成する。
 */
export function upsertVc(base: GuildConfigFile | null, config: BotConfig): GuildConfigFile {
  const vc: VcConfig = {
    voiceChannelId: config.voiceChannelId,
    default: config.default,
    volumes: config.volumes,
    autoStart: config.autoStart,
  };
  const others = (base?.vcs ?? []).filter((v) => v.voiceChannelId !== config.voiceChannelId);
  return {
    guildId: config.guildId,
    adminRoleName: config.adminRoleName,
    adminRoleNames: config.adminRoleNames,
    vcs: [...others, vc],
  };
}
