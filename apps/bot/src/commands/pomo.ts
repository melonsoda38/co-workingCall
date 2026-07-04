import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import {
  DEFAULT_ADMIN_ROLE_NAME,
  DEFAULT_AUTO_START,
  DEFAULT_TIMER_CONFIG,
  DEFAULT_VOLUME_CONFIG,
  loadConfig,
  saveConfig,
} from '../config/index.js';
import { purgeOwnEmbeds } from '../discord/purge-embeds.js';
import { buildStartEmbedMessage } from '../embed/index.js';
import type { VoiceSession } from '../voice/session-registry.js';
import { buildAllowedRoleNames, hasAnyAdminRole, missingBotPermissions } from './checks.js';
import { scheduleEphemeralAutoDelete } from './ephemeral.js';
import {
  adminRoleRequiredMessage,
  requireVoiceAdminSession,
  respondError,
  VC_TEXT_ONLY_MESSAGE,
} from './interaction-helpers.js';

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
    sub
      .setName('auto-label')
      .setDescription('自動スタート時のお知らせに使う文字を設定する')
      .addStringOption((opt) =>
        opt
          .setName('text')
          .setDescription('お知らせに差し込む文字 (例: 朝活)')
          .setRequired(true)
          .setMaxLength(50),
      ),
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
  )
  .addSubcommand((sub) =>
    sub.setName('help').setDescription('コマンドとボタンの説明を表示する'),
  );

/**
 * /pomo init ハンドラ。commands-spec.md のフローに準拠。
 * config.json 保存 + スタート Embed 投稿に加え、稼働中セッションがあれば
 * bot を VC に入室させる (旧 /pomo join 相当)。
 * すべてのエラー応答は ephemeral。例外は内部で処理し reject しない。
 */
export async function handlePomoInit(
  interaction: ChatInputCommandInteraction,
  session: VoiceSession | undefined,
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
    const adminRoleName = existingConfig?.adminRoleName ?? DEFAULT_ADMIN_ROLE_NAME;
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
      default: existingConfig?.default ?? DEFAULT_TIMER_CONFIG,
      guildId: guild.id,
      voiceChannelId: channel.id,
      adminRoleName,
      adminRoleNames,
      // 既存の音量設定は維持。新規は全音 0dB (原音)。
      volumes: existingConfig?.volumes ?? DEFAULT_VOLUME_CONFIG,
      // 既存の自動スタート設定は維持。新規は無効 (time=null)。
      autoStart: existingConfig?.autoStart ?? DEFAULT_AUTO_START,
    };
    await saveConfig(configPath, config);
    // 新規スタート Embed 投稿の直前に、対象 VC テキスト欄から bot 自身の過去 Embed を掃除
    // (init 連打や前回起動の追跡漏れも含めてテキスト欄を 1 Embed に保つ)。
    await purgeOwnEmbeds(channel, interaction.client.user.id, logger);
    const startEmbedMessage = await channel.send(buildStartEmbedMessage(config));
    // 投稿した Start Embed の id を EmbedManager に取り込む (session 結線済みの場合)。
    // これをやらないと EmbedManager.#startEmbedId が null のままで、
    // ▶開始 / 設定モーダル保存後の repostStartEmbed が早期 return してしまう。
    session?.embedManager.adoptStartEmbed(startEmbedMessage.id);

    // 稼働中セッションがあれば bot を VC に入室させる (旧 /pomo join 相当)。
    // session が無い場合 (初回 init・setupVoiceFeature 未実行) は bot 再起動が必要。
    if (!session) {
      await interaction.editReply(
        'セットアップ完了しました。bot を再起動すると VC 自動入退室が有効化されます',
      );
      logger.info(
        { guildId: guild.id, voiceChannelId: channel.id },
        '/pomo init 完了 (再起動待ち)',
      );
      return;
    }
    const connected = await session.voiceManager.ensureConnected();
    if (!connected) {
      await interaction.editReply(
        'セットアップ完了しましたが VC への接続に失敗しました。ログを確認のうえ再度 /pomo init を実行してください',
      );
      logger.warn({ guildId: guild.id }, '/pomo init: VC 入室に失敗しました');
      return;
    }
    await interaction.editReply('セットアップ完了しました (bot が VC に入室済み)');
    logger.info({ guildId: guild.id, voiceChannelId: channel.id }, '/pomo init 完了');
  } catch (err) {
    logger.error({ err }, '/pomo init 処理に失敗しました');
    await respondError(interaction, 'セットアップに失敗しました。ログを確認してください', logger);
  } finally {
    // /pomo init の ephemeral 応答を 6 時間後に自動削除する。
    scheduleEphemeralAutoDelete(interaction, logger);
  }
}

/**
 * /pomo help ハンドラ。このコマンド (/pomo のサブコマンド) とスタート/最終休憩 Embed の
 * ボタンの機能一覧を Embed で表示する。config/session は参照しないため、
 * 他ハンドラとのシグネチャ統一のため引数に残すが未使用。応答は本人のみの ephemeral。
 */
export async function handlePomoHelp(
  interaction: ChatInputCommandInteraction,
  _session: VoiceSession | undefined,
  _configPath: string,
  logger: Logger,
): Promise<void> {
  try {
    const embed = new EmbedBuilder()
      .setTitle('ポモドーロ bot ヘルプ')
      .setDescription('このサーバーで使えるコマンドとボタンの一覧です。')
      .addFields(
        {
          name: 'スラッシュコマンド (/pomo)',
          value: [
            '`/pomo init` : このボイスチャンネルでセットアップ/復旧する (設定生成 + bot 入室)',
            '`/pomo stop` : タイマーを強制停止してスタート画面に戻す (設定は保持・テスト用)',
            '`/pomo auto-label <text>` : 自動スタート時のお知らせに差し込む文字を設定する (最大50文字)',
            '`/pomo admin-role add/remove/list` : コマンド実行を許可する追加ロールを管理する',
            '`/pomo help` : このヘルプを表示する',
          ].join('\n'),
        },
        {
          name: 'ボタン (スタート画面)',
          value: [
            '**タイマー開始 (▶️)** : タイマーを開始し作業フェーズへ移行する',
            '**設定 (⚙️: ⏰)** : 作業/休憩時間・セット数・最終休憩・自動スタート時刻の設定モーダルを開く',
            '**音量 (⚙️: 🔊)** : 5種の通知音の音量 (dB) を設定するモーダルを開く',
          ].join('\n'),
        },
        {
          name: 'ボタン (最終休憩フェーズ)',
          value: '**続行** : 最終休憩後もタイマーを続ける (VC 参加者なら誰でも押せる・権限不要)',
        },
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (err) {
    logger.error({ err }, '/pomo help 処理に失敗しました');
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

    const ctx = await requireVoiceAdminSession({ interaction, session, logger });
    if (!ctx) {
      return;
    }
    const { guild, session: activeSession } = ctx;

    // 強制停止 → VC 退出 → スタート Embed 表示。設定は保持 (timer.stop は config.json を触らない)。
    activeSession.timer.stop();
    activeSession.voiceManager.forceDisconnect();
    await activeSession.embedManager.onIdle();

    // 成功時は確認メッセージを出さない (結果はスタート Embed 再表示で分かる)。
    // 3 秒以内の応答義務を満たすため defer 済みの ephemeral 応答は削除する。
    await interaction.deleteReply();
    logger.info({ guildId: guild.id }, '/pomo stop 実行');
  } catch (err) {
    logger.error({ err }, '/pomo stop 処理に失敗しました');
    await respondError(interaction, '停止処理に失敗しました。ログを確認してください', logger);
  } finally {
    // /pomo stop の ephemeral エラー応答を 6 時間後に自動削除 (成功時は deleteReply 済み = no-op)。
    scheduleEphemeralAutoDelete(interaction, logger);
  }
}

/**
 * /pomo admin-role (add/remove/list) ハンドラ。
 * コマンド実行を許可するロール (基準ロール adminRoleName + 追加ロール adminRoleNames) を
 * GUI のロール選択で管理する。基準ロールも remove 可能だが、許可ロールが 1 つだけのときは
 * 外せない (誰も操作できなくなるのを防ぐ)。基準ロールを外した場合は残った集合の先頭を
 * 新しい基準ロールに繰り上げる。変更は config.json 保存に加え稼働中セッションへも即反映 (再起動不要)。
 */
export async function handleAdminRole(
  interaction: ChatInputCommandInteraction,
  session: VoiceSession | undefined,
  configPath: string,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ctx = await requireVoiceAdminSession({ interaction, session, logger });
    if (!ctx) {
      return;
    }
    const { guild, session: activeSession, allowedRoles } = ctx;

    const action = interaction.options.getSubcommand();
    if (action === 'list') {
      await interaction.editReply(`現在の許可ロール: ${allowedRoles.join(' / ')}`);
      return;
    }

    // add / remove: 最新 config を基に adminRoleNames を更新し、保存 + セッションへ即反映。
    const loaded = await loadConfig(configPath);
    const base = loaded.status === 'ok' ? loaded.config : activeSession.config;
    const role = interaction.options.getRole('role', true);
    // 許可ロール集合 (基準ロール + 追加ロール、重複除去)。基準ロールは常に先頭。
    const allowed = buildAllowedRoleNames(base.adminRoleName, base.adminRoleNames);
    let updated: BotConfig;

    if (action === 'add') {
      if (allowed.includes(role.name)) {
        await interaction.editReply(`「${role.name}」は既に許可されています`);
        return;
      }
      updated = { ...base, adminRoleNames: [...base.adminRoleNames, role.name] };
    } else {
      if (!allowed.includes(role.name)) {
        await interaction.editReply(`「${role.name}」は許可ロールに登録されていません`);
        return;
      }
      // 許可ロールが 1 つだけのときは外せない (誰も操作できなくなるのを防ぐ)。
      if (allowed.length === 1) {
        await interaction.editReply(
          `「${role.name}」は唯一の許可ロールのため外せません (最低 1 つは必要です)`,
        );
        return;
      }
      // 基準ロールを外す場合も含め、残った集合の先頭を新しい基準ロールとして取り直す。
      // 上の length===1 ガードで残りは必ず 1 つ以上 (default は型確定用の到達不能フォールバック)。
      const [newBase = base.adminRoleName, ...rest] = allowed.filter((name) => name !== role.name);
      updated = { ...base, adminRoleName: newBase, adminRoleNames: rest };
    }
    await saveConfig(configPath, updated);
    activeSession.config = updated; // 稼働中セッションへ即反映 (再起動不要)

    const verb = action === 'add' ? '追加' : '削除';
    const current = buildAllowedRoleNames(updated.adminRoleName, updated.adminRoleNames);
    await interaction.editReply(`許可ロールを${verb}しました。現在: ${current.join(' / ')}`);
    logger.info({ guildId: guild.id, action, role: role.name }, '/pomo admin-role 実行');
  } catch (err) {
    logger.error({ err }, '/pomo admin-role 処理に失敗しました');
    await respondError(interaction, 'ロール設定の更新に失敗しました。ログを確認してください', logger);
  } finally {
    // /pomo admin-role の ephemeral 応答を 6 時間後に自動削除する。
    scheduleEphemeralAutoDelete(interaction, logger);
  }
}

/**
 * /pomo auto-label ハンドラ。自動スタート時のお知らせ ("xx") に使う文字を設定する。
 * admin-role と同方式で config.json 保存に加え稼働中セッションへも即反映 (再起動不要)。
 * 時刻 (autoStart.time) には影響しないため再スケジュールは不要。
 */
export async function handleAutoLabel(
  interaction: ChatInputCommandInteraction,
  session: VoiceSession | undefined,
  configPath: string,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ctx = await requireVoiceAdminSession({ interaction, session, logger });
    if (!ctx) {
      return;
    }
    const { guild, session: activeSession } = ctx;

    const text = interaction.options.getString('text', true).trim();
    if (text === '') {
      await interaction.editReply('ラベルには1文字以上を指定してください');
      return;
    }

    const loaded = await loadConfig(configPath);
    const base = loaded.status === 'ok' ? loaded.config : activeSession.config;
    const updated: BotConfig = { ...base, autoStart: { ...base.autoStart, label: text } };
    await saveConfig(configPath, updated);
    activeSession.config = updated; // 稼働中セッションへ即反映 (再起動不要)

    await interaction.editReply(`自動スタートのお知らせ文字を「${text}」に設定しました`);
    logger.info({ guildId: guild.id, label: text }, '/pomo auto-label 実行');
  } catch (err) {
    logger.error({ err }, '/pomo auto-label 処理に失敗しました');
    await respondError(interaction, 'ラベル設定の更新に失敗しました。ログを確認してください', logger);
  } finally {
    // /pomo auto-label の ephemeral 応答を 6 時間後に自動削除する。
    scheduleEphemeralAutoDelete(interaction, logger);
  }
}
