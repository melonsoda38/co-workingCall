import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  MessageFlags,
  ModalSubmitInteraction,
  type RepliableInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import {
  DEFAULT_ADMIN_ROLE_NAME,
  loadVcConfig,
  saveVcConfig,
  type ConfigLoadResult,
} from '../config/index.js';
import type { VoiceSession } from '../voice/session-registry.js';
import {
  buildAllowedRoleNames,
  buttonRoleRequiredMessage,
  hasAnyAdminRole,
  isVoiceTextContext,
} from './checks.js';
import { scheduleEphemeralAutoDelete } from './ephemeral.js';

/** VC 内蔵テキスト欄以外で /pomo 系コマンドを実行したときの共通エラー文言。 */
export const VC_TEXT_ONLY_MESSAGE =
  'このコマンドはボイスチャンネル内のテキスト欄で実行してください';

/** サーバー(ギルド)外で実行したときの共通エラー文言。 */
export const GUILD_ONLY_MESSAGE = 'サーバー内で実行してください';

/** session 未注入 (READY 前 / config 未確定) 時の共通エラー文言 (再起動を促す)。 */
export const SETUP_REQUIRED_RESTART =
  'セットアップが必要です。/pomo init 実行後に bot を再起動してください';

/** config 未確定でモーダル送信されたときの共通エラー文言 (先に init を促す)。 */
export const SETUP_REQUIRED_INIT = 'セットアップが必要です。先に /pomo init を実行してください';

/** 権限不足時の /pomo 系コマンド用エラー文言 (許可ロールを列挙)。 */
export function adminRoleRequiredMessage(allowedRoleNames: readonly string[]): string {
  return `このコマンドの実行には ${allowedRoleNames.join(' / ')} のいずれかのロールが必要です`;
}

/**
 * ephemeral 応答を送り、自動削除をスケジュールする共通ヘルパー (ボタン系の早期 return 用)。
 * deferReply しないボタン/モーダルの成功前 return とエラー応答で使う。
 */
export async function replyEphemeral(
  interaction: RepliableInteraction,
  content: string,
  logger: Logger,
): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  scheduleEphemeralAutoDelete(interaction, logger);
}

/**
 * catch 内の二次エラー応答。呼び出し元の deferred/replied 状態に応じて応答手段を選ぶ:
 * - deferReply 済み (pomo 系 / defer するハンドラ) → editReply で差し替える。
 * - 未応答 (モーダル送信など) → reply(ephemeral) で新規応答する。
 * - 既に通常応答済み (deferred=false, replied=true) → 二次応答しない (元のモーダル挙動を踏襲)。
 * 応答自体が失敗しても例外は伝播させずログのみ。自動削除は呼び出し元の finally / 応答手段側に委ねる。
 */
export async function respondError(
  interaction: RepliableInteraction,
  message: string,
  logger: Logger,
): Promise<void> {
  try {
    if (interaction.deferred) {
      await interaction.editReply(message);
    } else if (!interaction.replied) {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  } catch (replyErr) {
    logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
  }
}

/** guild からメンバーを fetch してロール名一覧を返す。 */
export async function fetchMemberRoleNames(guild: Guild, userId: string): Promise<string[]> {
  const member = await guild.members.fetch(userId);
  return member.roles.cache.map((role) => role.name);
}

/**
 * /pomo stop / admin-role / auto-label の共通前置き (defer 済み前提)。
 * VC-text チェック → session 必須 → guild → 許可ロール判定を行い、通れば guild と許可ロール集合を返す。
 * いずれかで弾く場合は既存文言で editReply して null を返す (呼び出し元は null なら early return)。
 * 許可ロールは session.config を基準にする。
 */
export async function requireVoiceAdminSession(params: {
  interaction: ChatInputCommandInteraction;
  session: VoiceSession | undefined;
  logger: Logger;
}): Promise<{ guild: Guild; session: VoiceSession; allowedRoles: string[] } | null> {
  const { interaction, session } = params;
  if (!isVoiceTextContext(interaction.channel?.type)) {
    await interaction.editReply(VC_TEXT_ONLY_MESSAGE);
    return null;
  }
  if (!session) {
    await interaction.editReply(SETUP_REQUIRED_RESTART);
    return null;
  }
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply(GUILD_ONLY_MESSAGE);
    return null;
  }
  const roleNames = await fetchMemberRoleNames(guild, interaction.user.id);
  const allowedRoles = buildAllowedRoleNames(
    session.config.adminRoleName,
    session.config.adminRoleNames,
  );
  if (!hasAnyAdminRole(roleNames, allowedRoles)) {
    await interaction.editReply(adminRoleRequiredMessage(allowedRoles));
    return null;
  }
  return { guild, session, allowedRoles };
}

/**
 * ボタン/モーダルは VC のテキストチャットで発生するため channelId が対象 VC の id になる。
 * その guildId + channelId(=voiceChannelId) で per-guild ファイルから当該 VC の config を読む。
 * どちらか欠ける (VC 外など) 場合は未確定扱い (missing)。
 */
async function loadVcConfigForInteraction(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  configDir: string,
): Promise<ConfigLoadResult> {
  if (!interaction.guildId || !interaction.channelId) {
    return { status: 'missing' };
  }
  return loadVcConfig(configDir, interaction.guildId, interaction.channelId);
}

/**
 * 設定 / 音量ボタン押下時の共通認可 (defer しないボタン前提)。
 * guild → config ベースの許可ロール判定を行い、通れば guild・config・許可ロール集合を返す。
 * 弾く場合は replyEphemeral (自動削除付き) して null を返す。config 未確定時は基準ロール
 * 'pomo-admin' にフォールバックする (config は ok のときのみ値、それ以外は undefined)。
 */
export async function requireConfigAdminForButton(params: {
  interaction: ButtonInteraction;
  configDir: string;
  logger: Logger;
}): Promise<{ guild: Guild; config: BotConfig | undefined; allowedRoles: string[] } | null> {
  const { interaction, configDir, logger } = params;
  const guild = interaction.guild;
  if (!guild) {
    await replyEphemeral(interaction, GUILD_ONLY_MESSAGE, logger);
    return null;
  }
  const existing = await loadVcConfigForInteraction(interaction, configDir);
  const config = existing.status === 'ok' ? existing.config : undefined;
  const allowedRoles = buildAllowedRoleNames(
    config?.adminRoleName ?? DEFAULT_ADMIN_ROLE_NAME,
    config?.adminRoleNames ?? [],
  );
  const roleNames = await fetchMemberRoleNames(guild, interaction.user.id);
  if (!hasAnyAdminRole(roleNames, allowedRoles)) {
    await replyEphemeral(interaction, buttonRoleRequiredMessage(allowedRoles), logger);
    return null;
  }
  return { guild, config, allowedRoles };
}

/**
 * モーダル送信で config を読み、ok でなければセットアップ必要を reply して null を返す。
 * ok なら BotConfig を返す (呼び出し元は null なら early return)。
 */
export async function loadOkConfigOrReplySetup(
  interaction: ModalSubmitInteraction,
  configDir: string,
): Promise<BotConfig | null> {
  const existing = await loadVcConfigForInteraction(interaction, configDir);
  if (existing.status !== 'ok') {
    await interaction.reply({ content: SETUP_REQUIRED_INIT, flags: MessageFlags.Ephemeral });
    return null;
  }
  return existing.config;
}

/**
 * 最新 config で Start Embed を投稿し直す (モーダル送信の best-effort フォローアップ)。
 * session 未注入ならスキップ。失敗は warn ログのみで握りつぶす (config 保存は完了扱いのため)。
 */
export async function repostStartEmbedBestEffort(
  session: VoiceSession | undefined,
  updated: BotConfig,
  logger: Logger,
): Promise<void> {
  if (!session) {
    return;
  }
  try {
    await session.embedManager.repostStartEmbed(updated);
  } catch (repostErr) {
    logger.warn({ err: repostErr }, 'Start Embed の投稿し直しに失敗 (best-effort、config 保存は完了)');
  }
}

/** モーダル入力の検証結果 (成功なら値、失敗ならフィールド別エラー文言)。 */
export type ModalParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * 設定 / 音量モーダル送信の共通骨格。両モーダルで同一だった
 * 「検証 → config 読込 → 権限再チェック → 更新 → 保存 → 応答 → Start Embed 再投稿 →
 * catch / finally 自動削除」を集約する。差分 (parse・updated 生成・成功/失敗文言・保存後処理) は
 * 引数で注入する。挙動は各ハンドラ内蔵時と同一。
 *
 * 権限再チェック (defense-in-depth): モーダルは管理者にのみ表示されるが、送信時にも
 * 実行者のロールを再検証し、権限外なら保存せず弾く。
 */
export async function runConfigModalSubmit<T>(params: {
  interaction: ModalSubmitInteraction;
  session: VoiceSession | undefined;
  configDir: string;
  logger: Logger;
  parse: () => ModalParseResult<T>;
  buildUpdated: (config: BotConfig, value: T) => BotConfig;
  successMessage: string;
  errorMessage: string;
  errorLogMessage: string;
  logMessage: string;
  logContext?: (updated: BotConfig) => Record<string, unknown>;
  afterSave?: (updated: BotConfig, session: VoiceSession | undefined) => void;
}): Promise<void> {
  const { interaction, session, configDir, logger } = params;
  try {
    const parsed = params.parse();
    if (!parsed.ok) {
      await interaction.reply({ content: parsed.errors.join('\n'), flags: MessageFlags.Ephemeral });
      return;
    }

    const config = await loadOkConfigOrReplySetup(interaction, configDir);
    if (!config) {
      return;
    }

    // 権限再チェック: 送信時にも実行者が許可ロールを持つか確認する。
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: GUILD_ONLY_MESSAGE, flags: MessageFlags.Ephemeral });
      return;
    }
    const allowedRoles = buildAllowedRoleNames(config.adminRoleName, config.adminRoleNames);
    const roleNames = await fetchMemberRoleNames(guild, interaction.user.id);
    if (!hasAnyAdminRole(roleNames, allowedRoles)) {
      await interaction.reply({
        content: buttonRoleRequiredMessage(allowedRoles),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const updated = params.buildUpdated(config, parsed.value);
    await saveVcConfig(configDir, updated);
    params.afterSave?.(updated, session);
    await interaction.reply({ content: params.successMessage, flags: MessageFlags.Ephemeral });
    logger.info(params.logContext?.(updated) ?? {}, params.logMessage);

    // 最新 config で Start Embed を投稿し直す (ephemeral 応答後・best-effort)。
    await repostStartEmbedBestEffort(session, updated, logger);
  } catch (err) {
    logger.error({ err }, params.errorLogMessage);
    await respondError(interaction, params.errorMessage, logger);
  } finally {
    scheduleEphemeralAutoDelete(interaction, logger);
  }
}
