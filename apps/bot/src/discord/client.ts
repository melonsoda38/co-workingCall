import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { Logger } from 'pino';
import {
  SETTINGS_MODAL_ID,
  handlePomoInit,
  handleSettingsButton,
  handleSettingsModalSubmit,
  registerCommands,
} from '../commands/index.js';
import { SETTINGS_BUTTON_ID } from '../embed/index.js';

/**
 * Discord Client を生成する。
 * intents は Guilds (interaction/channel 種別) と GuildMessages (messageCreate 検知)。
 * 人間メッセージは存在検知のみで内容は読まないため MessageContent は不要。
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
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
