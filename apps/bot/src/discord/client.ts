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
import { loadConfig } from '../config/index.js';
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
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });
}

/** READY 後、config 有効なら VC 自動入退室機能を結線する (US-16)。 */
async function setupVoiceOnReady(
  client: Client<true>,
  configPath: string,
  logger: Logger,
  sessions: VoiceSessionRegistry,
): Promise<void> {
  const result = await loadConfig(configPath);
  if (result.status !== 'ok') {
    logger.info('config 未確定のため VC 機能は待機 (/pomo init 後の再起動で有効化)');
    return;
  }
  await setupVoiceFeature(client, result.config, logger, sessions, configPath);
}

/**
 * Discord にログインし READY を待つ。
 * /pomo init・設定ボタン・設定モーダルを interactionCreate で振り分ける。
 */
export async function startBot(token: string, logger: Logger, configPath: string): Promise<Client> {
  const client = createClient();
  const sessions = createVoiceSessionRegistry();

  client.once(Events.ClientReady, (ready) => {
    logger.info({ tag: ready.user.tag, id: ready.user.id }, 'Discord bot READY');
    void registerCommands(ready, token, logger);
    void setupVoiceOnReady(ready, configPath, logger, sessions);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    // guild スコープのセッションは一度だけ解決する (button/modal/command 共通)。
    const session = interaction.guildId ? sessions.get(interaction.guildId) : undefined;

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'pomo') {
        return;
      }
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(false);
      if (group === 'admin-role') {
        void handleAdminRole(interaction, session, configPath, logger);
      } else if (sub === 'init') {
        void handlePomoInit(interaction, session, configPath, logger);
      } else if (sub === 'stop') {
        void handlePomoStop(interaction, session, logger);
      } else if (sub === 'auto-label') {
        void handleAutoLabel(interaction, session, configPath, logger);
      } else if (sub === 'help') {
        void handlePomoHelp(interaction, session, configPath, logger);
      }
      return;
    }

    if (interaction.isButton()) {
      switch (interaction.customId) {
        case START_BUTTON_ID:
          void handleStartButton(interaction, session, configPath, logger);
          break;
        case CONTINUE_BUTTON_ID:
          void handleContinueButton(interaction, session, logger);
          break;
        case SETTINGS_BUTTON_ID:
          void handleSettingsButton(interaction, session, configPath, logger);
          break;
        case VOLUME_BUTTON_ID:
          void handleVolumeButton(interaction, session, configPath, logger);
          break;
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      switch (interaction.customId) {
        case SETTINGS_MODAL_ID:
          void handleSettingsModalSubmit(interaction, session, configPath, logger);
          break;
        case VOLUME_MODAL_ID:
          void handleVolumeModalSubmit(interaction, session, configPath, logger);
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
    const session = sessions.get(message.guildId);
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
