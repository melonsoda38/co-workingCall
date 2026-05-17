import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { Logger } from 'pino';

/**
 * Discord Client を生成する。
 * US-4 は最小ログインのみのため intents は Guilds だけ。
 * VC (GuildVoiceStates) やメッセージ (GuildMessages/MessageContent) は
 * 必要になる US (US-10/US-16 等) で追加する。
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
  });
}

/**
 * Discord にログインし READY を待つ。
 * VC 接続・スラッシュコマンドは US-4 では実装しない。
 */
export async function startBot(token: string, logger: Logger): Promise<Client> {
  const client = createClient();

  client.once(Events.ClientReady, (ready) => {
    logger.info({ tag: ready.user.tag, id: ready.user.id }, 'Discord bot READY');
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, 'Discord client error');
  });

  await client.login(token);
  return client;
}
