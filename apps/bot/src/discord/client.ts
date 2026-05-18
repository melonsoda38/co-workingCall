import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { Logger } from 'pino';
import { handlePomoInit, registerCommands } from '../commands/index.js';

/**
 * Discord Client を生成する。
 * US-6 時点でも intents は Guilds のみ (interaction 受信・channel 種別判定に十分)。
 * VC (GuildVoiceStates) / メッセージ (GuildMessages) は必要になる US で追加する。
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
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

  client.on(Events.Error, (err) => {
    logger.error({ err }, 'Discord client error');
  });

  await client.login(token);
  return client;
}
