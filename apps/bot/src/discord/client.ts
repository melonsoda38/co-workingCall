import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { Logger } from 'pino';
import {
  SETTINGS_MODAL_ID,
  VOLUME_MODAL_ID,
  handleAdminRole,
  handleAutoLabel,
  handleContinueButton,
  handlePomoHelp,
  handlePomoInit,
  handlePomoStop,
  handleSettingsButton,
  handleSettingsModalSubmit,
  handleStartButton,
  handleVolumeButton,
  handleVolumeModalSubmit,
  registerCommands,
} from '../commands/index.js';
import { loadAllGuildConfigs, migrateLegacyConfig, resolveConfigDir } from '../config/index.js';
import {
  CONTINUE_BUTTON_ID,
  SETTINGS_BUTTON_ID,
  START_BUTTON_ID,
  VOLUME_BUTTON_ID,
  shouldHandleHumanMessage,
} from '../embed/index.js';
import {
  createVoiceSessionRegistry,
  setupVoiceFeature,
  type VoiceSessionRegistry,
} from '../voice/index.js';

/**
 * Discord Client を生成する。
 * intents は Guilds (interaction/channel 種別)、GuildMessages (messageCreate 検知)、
 * GuildVoiceStates (voiceStateUpdate と VC メンバー把握)。
 * 人間メッセージは存在検知のみで内容は読まないため MessageContent は不要。
 *
 * allowedMentions: { parse: [] } で全 bot 投稿のメンション解釈を無効化する (セキュリティ)。
 * bot は本来メンションを行わないが、入室挨拶はユーザー制御の表示名 (ニックネーム) を本文に
 * 埋め込むため、これを付けないと `@everyone` や `<@&roleId>` を含むニックネームで意図しない
 * ping を誘発できてしまう (メンション注入)。Client 既定で一括無効化して根本から防ぐ。
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
    allowedMentions: { parse: [] },
  });
}

/**
 * READY 後、全 guild/VC の config をロードして VC 自動入退室機能を結線する (US-16)。
 * 旧単一 config.json は per-guild ファイルへ自動移行してから読み込む。
 * 各 (guild, VC) ごとにセッションを構築し、registry へ voiceChannelId で登録する。
 */
async function setupAllVoiceFeatures(
  client: Client<true>,
  legacyConfigPath: string,
  configDir: string,
  logger: Logger,
  sessions: VoiceSessionRegistry,
): Promise<void> {
  await migrateLegacyConfig(legacyConfigPath, configDir, logger);
  const all = await loadAllGuildConfigs(configDir, logger);
  if (all.length === 0) {
    logger.info('有効な config が無いため VC 機能は待機 (/pomo init 後の再起動で有効化)');
    return;
  }
  for (const { config } of all) {
    await setupVoiceFeature(client, config, logger, sessions, configDir);
  }
  logger.info({ sessions: all.length }, '全 guild/VC の VC 機能を有効化しました');
}

/**
 * Discord にログインし READY を待つ。
 * /pomo init・設定ボタン・設定モーダルを interactionCreate で振り分ける。
 */
export async function startBot(token: string, logger: Logger, configPath: string): Promise<Client> {
  const client = createClient();
  const sessions = createVoiceSessionRegistry();
  // config は per-guild ファイル (<configDir>/<guildId>.json)。configPath は旧単一 config.json の
  // パス (移行元) で、そこから configDir を導出する。
  const configDir = resolveConfigDir(configPath);

  client.once(Events.ClientReady, (ready) => {
    logger.info({ tag: ready.user.tag, id: ready.user.id }, 'Discord bot READY');
    void registerCommands(ready, token, logger);
    void setupAllVoiceFeatures(ready, configPath, configDir, logger, sessions);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    // セッションは VC 単位 (registry キー=voiceChannelId)。/pomo 系・ボタン・モーダルは
    // いずれも VC のテキストチャットで発生するため channelId で一度だけ解決する。
    const session = interaction.channelId ? sessions.get(interaction.channelId) : undefined;

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'pomo') {
        return;
      }
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(false);
      if (group === 'admin-role') {
        void handleAdminRole(interaction, session, configDir, logger);
      } else if (sub === 'init') {
        void handlePomoInit(interaction, session, configDir, logger);
      } else if (sub === 'stop') {
        void handlePomoStop(interaction, session, logger);
      } else if (sub === 'auto-label') {
        void handleAutoLabel(interaction, session, configDir, logger);
      } else if (sub === 'help') {
        void handlePomoHelp(interaction, session, configDir, logger);
      }
      return;
    }

    if (interaction.isButton()) {
      switch (interaction.customId) {
        case START_BUTTON_ID:
          void handleStartButton(interaction, session, configDir, logger);
          break;
        case CONTINUE_BUTTON_ID:
          void handleContinueButton(interaction, session, logger);
          break;
        case SETTINGS_BUTTON_ID:
          void handleSettingsButton(interaction, session, configDir, logger);
          break;
        case VOLUME_BUTTON_ID:
          void handleVolumeButton(interaction, session, configDir, logger);
          break;
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      switch (interaction.customId) {
        case SETTINGS_MODAL_ID:
          void handleSettingsModalSubmit(interaction, session, configDir, logger);
          break;
        case VOLUME_MODAL_ID:
          void handleVolumeModalSubmit(interaction, session, configDir, logger);
          break;
      }
      return;
    }
  });

  client.on(Events.MessageCreate, (message) => {
    // embed-spec §自動削除&再投稿仕様: 人間メッセージ検知で debouncer をトリガー
    // (work/break/finalBreak のみ、60秒 debounce / 180秒 maxWait で旧 Embed 削除 → 最下部再投稿)。
    // フェーズガードと debouncer 制御は EmbedManager.onHumanMessage 内に閉じ込めているため、
    // ここでは bot 自身の除外 + 対象 VC テキスト欄絞り込みだけ行えばよい。
    if (!message.guildId) {
      return;
    }
    // セッションは VC 単位。VC のテキストチャット (channelId=voiceChannelId) で解決する。
    const session = sessions.get(message.channelId);
    if (!session) {
      return;
    }
    if (
      !shouldHandleHumanMessage({
        authorIsBot: message.author.bot,
        channelId: message.channelId,
        targetChannelId: session.config.voiceChannelId,
      })
    ) {
      return;
    }
    logger.debug({ channelId: message.channelId }, '人間メッセージ検知 → onHumanMessage');
    session.embedManager.onHumanMessage();
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, 'Discord client error');
  });

  await client.login(token);
  return client;
}
