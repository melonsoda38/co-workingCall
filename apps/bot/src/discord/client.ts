import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { Logger } from 'pino';
import { handlePomoInit, registerCommands } from '../commands/index.js';

/**
 * Discord Client を生成する。
 * intents は Guilds (interaction/channel 種別) と GuildMessages (messageCreate 検知, US-10)。
 * 人間メッセージは「存在検知」のみで内容は読まないため MessageContent は不要。
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
}

/**
 * Discord にログインし READY を待つ。
 * READY 時に参加ギルドへスラッシュコマンドを登録し、
 * /pomo init を interactionCreate で処理する。
 */
export async function startBot(token: string, logger: Logger, configPath: string): Promise<Client> {
  const client = createClient();

  client.once(Events.ClientReady, (ready) => {
    logger.info({ tag: ready.user.tag, id: ready.user.id }, 'Discord bot READY');
    void registerCommands(ready, token, logger);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    if (interaction.commandName === 'pomo' && interaction.options.getSubcommand(false) === 'init') {
      void handlePomoInit(interaction, configPath, logger);
    }
  });

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) {
      return;
    }
    // EmbedManager.onHumanMessage への接続は、タイマー開始フロー (US-12) で
    // EmbedManager のライフサイクルが確定してから配線する。US-10 では検知のみ。
    logger.debug({ channelId: message.channelId }, '人間メッセージ検知 (messageCreate)');
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, 'Discord client error');
  });

  await client.login(token);
  return client;
}
