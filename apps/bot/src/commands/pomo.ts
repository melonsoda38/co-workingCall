import {
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import { loadConfig, saveConfig } from '../config/index.js';
import { purgeOwnEmbeds } from '../discord/purge-embeds.js';
import { buildStartEmbedMessage } from '../embed/index.js';
import type { VoiceSession } from '../voice/session-registry.js';
import {
  buildAllowedRoleNames,
  hasAnyAdminRole,
  isVoiceTextContext,
  missingBotPermissions,
} from './checks.js';

/** config 未存在時の初期タイマー設定 (commands-spec モーダル placeholder: 50/10/2/15 分)。 */
const DEFAULT_TIMER: BotConfig['default'] = {
  workSec: 50 * 60,
  breakSec: 10 * 60,
  sets: 2,
  finalBreakSec: 15 * 60,
};

/** VC 内蔵テキスト欄以外で /pomo 系コマンドを実行したときの共通エラー文言。 */
const VC_TEXT_ONLY_MESSAGE = 'このコマンドはボイスチャンネル内のテキスト欄で実行してください';

/** 権限不足時の共通エラー文言 (許可ロールを列挙)。 */
function adminRoleRequiredMessage(allowedRoleNames: readonly string[]): string {
  return `このコマンドの実行には ${allowedRoleNames.join(' / ')} のいずれかのロールが必要です`;
}

export const pomoCommand = new SlashCommandBuilder()
  .setName('pomo')
  .setDescription('ポモドーロ bot のセットアップ')
  // /pomo 系は全て管理操作。コマンド一覧の可視性を「サーバー管理」権限保有者に限定する
  // (実行制御はハンドラ側のロール判定で別途担保する二重防御)。
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub.setName('init').setDescription('このボイスチャンネルでセットアップ/復旧する'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('stop')
      .setDescription('タイマーを強制停止してスタート画面に戻す (設定は保持・テスト用)'),
  )
  .addSubcommand((sub) =>
    sub.setName('join').setDescription('bot を VC に再入室させる (タイマーは開始しない)'),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('admin-role')
      .setDescription('コマンド実行を許可する追加ロールの管理')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('許可ロールを追加する')
          .addRoleOption((opt) =>
            opt.setName('role').setDescription('追加するロール').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('追加した許可ロールを外す')
          .addRoleOption((opt) =>
            opt.setName('role').setDescription('外すロール').setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('現在の許可ロール一覧を表示する')),
  );

/**
 * /pomo init ハンドラ。commands-spec.md のフローに準拠。
 * すべてのエラー応答は ephemeral。例外は内部で処理し reject しない。
 */
export async function handlePomoInit(
  interaction: ChatInputCommandInteraction,
  configPath: string,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.channel;
    if (channel?.type !== ChannelType.GuildVoice) {
      await interaction.editReply(VC_TEXT_ONLY_MESSAGE);
      return;
    }
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply('セットアップに失敗しました。ログを確認してください');
      return;
    }

    const existing = await loadConfig(configPath);
    const existingConfig = existing.status === 'ok' ? existing.config : null;
    const adminRoleName = existingConfig?.adminRoleName ?? 'pomo-admin';
    const adminRoleNames = existingConfig?.adminRoleNames ?? [];
    const allowedRoles = buildAllowedRoleNames(adminRoleName, adminRoleNames);

    const member = await guild.members.fetch(interaction.user.id);
    const roleNames = member.roles.cache.map((role) => role.name);
    if (!hasAnyAdminRole(roleNames, allowedRoles)) {
      await interaction.editReply(adminRoleRequiredMessage(allowedRoles));
      return;
    }

    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms || missingBotPermissions(perms).length > 0) {
      const missing = perms ? missingBotPermissions(perms) : ['(権限取得不可)'];
      logger.warn({ missing, channelId: channel.id }, 'bot の VC 権限が不足しています');
      await interaction.editReply(
        'botがこのVCにアクセスする権限がありません。管理者に確認してください',
      );
      return;
    }

    if (existingConfig && existingConfig.voiceChannelId !== channel.id) {
      logger.info(
        { oldVoiceChannelId: existingConfig.voiceChannelId, newVoiceChannelId: channel.id },
        'VC切替: 旧VCのスタートEmbedは新VC側のpurgeOwnEmbeds対象外。必要なら旧VCで手動削除を',
      );
    }

    const config: BotConfig = {
      default: existingConfig?.default ?? DEFAULT_TIMER,
      guildId: guild.id,
      voiceChannelId: channel.id,
      adminRoleName,
      adminRoleNames,
    };
    await saveConfig(configPath, config);
    // 新規スタート Embed 投稿の直前に、対象 VC テキスト欄から bot 自身の過去 Embed を掃除
    // (init 連打や前回起動の追跡漏れも含めてテキスト欄を 1 Embed に保つ)。
    await purgeOwnEmbeds(channel, interaction.client.user.id, logger);
    await channel.send(buildStartEmbedMessage(config));

    await interaction.editReply('セットアップ完了しました');
    logger.info({ guildId: guild.id, voiceChannelId: channel.id }, '/pomo init 完了');
  } catch (err) {
    logger.error({ err }, '/pomo init 処理に失敗しました');
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('セットアップに失敗しました。ログを確認してください');
      } else {
        await interaction.reply({
          content: 'セットアップに失敗しました。ログを確認してください',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
    }
  }
}

/**
 * /pomo stop ハンドラ (テスト用)。タイマーを強制停止しスタート Embed に戻す。
 * タイマー設定 (config.json) はリセットしない。実行権限は pomo-admin ロール。
 * セッションは guildId で VoiceSessionRegistry から解決して渡す。
 */
export async function handlePomoStop(
  interaction: ChatInputCommandInteraction,
  session: VoiceSession | undefined,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isVoiceTextContext(interaction.channel?.type)) {
      await interaction.editReply(VC_TEXT_ONLY_MESSAGE);
      return;
    }
    if (!session) {
      await interaction.editReply(
        'セットアップが必要です。/pomo init 実行後に bot を再起動してください',
      );
      return;
    }
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply('サーバー内で実行してください');
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const roleNames = member.roles.cache.map((role) => role.name);
    const allowedRoles = buildAllowedRoleNames(
      session.config.adminRoleName,
      session.config.adminRoleNames,
    );
    if (!hasAnyAdminRole(roleNames, allowedRoles)) {
      await interaction.editReply(adminRoleRequiredMessage(allowedRoles));
      return;
    }

    // 強制停止 → VC 退出 → スタート Embed 表示。設定は保持 (timer.stop は config.json を触らない)。
    session.timer.stop();
    session.voiceManager.forceDisconnect();
    await session.embedManager.onIdle();

    // 成功時は確認メッセージを出さない (結果はスタート Embed 再表示で分かる)。
    // 3 秒以内の応答義務を満たすため defer 済みの ephemeral 応答は削除する。
    await interaction.deleteReply();
    logger.info({ guildId: guild.id }, '/pomo stop 実行');
  } catch (err) {
    logger.error({ err }, '/pomo stop 処理に失敗しました');
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('停止処理に失敗しました。ログを確認してください');
      } else {
        await interaction.reply({
          content: '停止処理に失敗しました。ログを確認してください',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
    }
  }
}

/**
 * /pomo join ハンドラ。bot を対象 VC へ再入室させる (タイマーは開始しない)。
 * /pomo stop で退出させた後、VC に居たまま bot を呼び戻す用途。
 * 実行権限は pomo-admin ロール。セッションは VoiceSessionRegistry から解決して渡す。
 */
export async function handlePomoJoin(
  interaction: ChatInputCommandInteraction,
  session: VoiceSession | undefined,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isVoiceTextContext(interaction.channel?.type)) {
      await interaction.editReply(VC_TEXT_ONLY_MESSAGE);
      return;
    }
    if (!session) {
      await interaction.editReply(
        'セットアップが必要です。/pomo init 実行後に bot を再起動してください',
      );
      return;
    }
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply('サーバー内で実行してください');
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const roleNames = member.roles.cache.map((role) => role.name);
    const allowedRoles = buildAllowedRoleNames(
      session.config.adminRoleName,
      session.config.adminRoleNames,
    );
    if (!hasAnyAdminRole(roleNames, allowedRoles)) {
      await interaction.editReply(adminRoleRequiredMessage(allowedRoles));
      return;
    }

    // 既に VC に居る場合は何もしない (実行者にのみ ephemeral で通知)。
    if (session.voiceManager.connected) {
      await interaction.editReply('bot は既に VC に入室しています');
      return;
    }

    // 対象 VC へ再入室。タイマーには触れない。
    const connected = await session.voiceManager.ensureConnected();
    if (!connected) {
      await interaction.editReply('VCへの接続に失敗しました。ログを確認してください');
      return;
    }

    // 成功時は確認メッセージを出さない (bot が VC に現れることで分かる)。
    await interaction.deleteReply();
    logger.info({ guildId: guild.id }, '/pomo join 実行');
  } catch (err) {
    logger.error({ err }, '/pomo join 処理に失敗しました');
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('再入室処理に失敗しました。ログを確認してください');
      } else {
        await interaction.reply({
          content: '再入室処理に失敗しました。ログを確認してください',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
    }
  }
}

/**
 * /pomo admin-role (add/remove/list) ハンドラ。
 * コマンド実行を許可する追加ロール (config.adminRoleNames) を GUI のロール選択で管理する。
 * 基準ロール (adminRoleName, 既定 pomo-admin) は常に許可で、ここでは外せない。
 * 変更は config.json 保存に加え、稼働中セッションへも即反映する (再起動不要)。
 */
export async function handleAdminRole(
  interaction: ChatInputCommandInteraction,
  session: VoiceSession | undefined,
  configPath: string,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isVoiceTextContext(interaction.channel?.type)) {
      await interaction.editReply(VC_TEXT_ONLY_MESSAGE);
      return;
    }
    if (!session) {
      await interaction.editReply(
        'セットアップが必要です。/pomo init 実行後に bot を再起動してください',
      );
      return;
    }
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply('サーバー内で実行してください');
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const roleNames = member.roles.cache.map((role) => role.name);
    const allowedRoles = buildAllowedRoleNames(
      session.config.adminRoleName,
      session.config.adminRoleNames,
    );
    if (!hasAnyAdminRole(roleNames, allowedRoles)) {
      await interaction.editReply(adminRoleRequiredMessage(allowedRoles));
      return;
    }

    const action = interaction.options.getSubcommand();
    if (action === 'list') {
      await interaction.editReply(`現在の許可ロール: ${allowedRoles.join(' / ')}`);
      return;
    }

    // add / remove: 最新 config を基に adminRoleNames を更新し、保存 + セッションへ即反映。
    const loaded = await loadConfig(configPath);
    const base = loaded.status === 'ok' ? loaded.config : session.config;
    const role = interaction.options.getRole('role', true);
    const names = new Set(base.adminRoleNames);

    if (action === 'add') {
      if (role.name === base.adminRoleName || names.has(role.name)) {
        await interaction.editReply(`「${role.name}」は既に許可されています`);
        return;
      }
      names.add(role.name);
    } else {
      if (role.name === base.adminRoleName) {
        await interaction.editReply(`「${role.name}」は基準ロールのため外せません`);
        return;
      }
      if (!names.has(role.name)) {
        await interaction.editReply(`「${role.name}」は許可ロールに登録されていません`);
        return;
      }
      names.delete(role.name);
    }

    const updated: BotConfig = { ...base, adminRoleNames: [...names] };
    await saveConfig(configPath, updated);
    session.config = updated; // 稼働中セッションへ即反映 (再起動不要)

    const verb = action === 'add' ? '追加' : '削除';
    const current = buildAllowedRoleNames(updated.adminRoleName, updated.adminRoleNames);
    await interaction.editReply(`許可ロールを${verb}しました。現在: ${current.join(' / ')}`);
    logger.info({ guildId: guild.id, action, role: role.name }, '/pomo admin-role 実行');
  } catch (err) {
    logger.error({ err }, '/pomo admin-role 処理に失敗しました');
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('ロール設定の更新に失敗しました。ログを確認してください');
      } else {
        await interaction.reply({
          content: 'ロール設定の更新に失敗しました。ログを確認してください',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
    }
  }
}
