import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { Logger } from 'pino';
import {
  SETTINGS_MODAL_ID,
  handlePomoInit,
  handleSettingsButton,
  handleSettingsModalSubmit,
  registerCommands,
} from '../commands/index.js';
import { loadConfig } from '../config/index.js';
import { SETTINGS_BUTTON_ID } from '../embed/index.js';
import { setupVoiceFeature } from '../voice/index.js';

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
): Promise<void> {
  const result = await loadConfig(configPath);
  if (result.status !== 'ok') {
    logger.info('config 未確定のため VC 機能は待機 (/pomo init 後の再起動で有効化)');
    return;
  }
  await setupVoiceFeature(client, result.config, logger);
}

/**
 * Discord にログインし READY を待つ。
 * /pomo init・設定ボタン・設定モーダルを interactionCreate で振り分ける。
 */
export async function startBot(token: string, logger: Logger, configPath: string): Promise<Client> {
  const client = createClient();

  client.once(Events.ClientReady, (ready) => {
    logger.info({ tag: ready.user.tag, id: ready.user.id }, 'Discord bot READY');
    void registerCommands(ready, token, logger);
    void setupVoiceOnReady(ready, configPath, logger);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName === 'pomo' &&
        interaction.options.getSubcommand(false) === 'init'
      ) {
        void handlePomoInit(interaction, configPath, logger);
      }
      return;
    }
    if (interaction.isButton() && interaction.customId === SETTINGS_BUTTON_ID) {
      void handleSettingsButton(interaction, configPath, logger);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId === SETTINGS_MODAL_ID) {
      void handleSettingsModalSubmit(interaction, configPath, logger);
      return;
    }
  });

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) {
      return;
    }
    // EmbedManager.onHumanMessage への接続は、EmbedManager のライフサイクルが
    // 確定する後続の全体結線で行う。US-12 時点では検知のみ。
    logger.debug({ channelId: message.channelId }, '人間メッセージ検知 (messageCreate)');
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, 'Discord client error');
  });

  await client.login(token);
  return client;
}
