import { GatewayIntentBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createClient } from './client.js';

describe('createClient', () => {
  it('メンション注入対策: allowedMentions を全無効 (parse:[]) にする', () => {
    const client = createClient();
    // 入室挨拶はユーザー制御の表示名を本文に含むため、Client 既定で全メンションを無効化しておく。
    expect(client.options.allowedMentions).toEqual({ parse: [] });
    void client.destroy();
  });

  it('intents は非特権の 3 種のみ (MessageContent/GuildMembers は使わない)', () => {
    const client = createClient();
    const intents = client.options.intents;
    expect(intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
    expect(intents.has(GatewayIntentBits.GuildVoiceStates)).toBe(true);
    expect(intents.has(GatewayIntentBits.MessageContent)).toBe(false);
    expect(intents.has(GatewayIntentBits.GuildMembers)).toBe(false);
    void client.destroy();
  });
});
