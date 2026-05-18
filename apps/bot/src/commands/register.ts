import { REST, Routes, type Client } from 'discord.js';
import type { Logger } from 'pino';
import { pomoCommand } from './pomo.js';

/**
 * 起動時、bot が参加している全ギルドにスラッシュコマンドを登録する。
 * ギルドコマンドは即時反映され、初回 init 前 (config 未確定) でも利用できる。
 */
export async function registerCommands(
  client: Client<true>,
  token: string,
  logger: Logger,
): Promise<void> {
  const rest = new REST().setToken(token);
  const body = [pomoCommand.toJSON()];
  const guilds = await client.guilds.fetch();

  for (const guildId of guilds.keys()) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body });
      logger.info({ guildId }, 'スラッシュコマンドを登録しました');
    } catch (err) {
      logger.error({ err, guildId }, 'スラッシュコマンド登録に失敗しました');
    }
  }
}
