import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotConfig } from '@co-working-call/shared';
import { loadConfig, saveConfig } from './config-store.js';

const validConfig: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 600 },
  guildId: '123',
  voiceChannelId: '456',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
  volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
  autoStart: { time: null, label: '自動スタート' },
};

describe('config-store', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cwc-config-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ファイルが無ければ missing', async () => {
    const r = await loadConfig(join(dir, 'nope.json'));
    expect(r.status).toBe('missing');
  });

  it('JSON 構文エラーは invalid', async () => {
    const p = join(dir, 'broken.json');
    await writeFile(p, '{ not json', 'utf8');
    const r = await loadConfig(p);
    expect(r.status).toBe('invalid');
  });

  it('スキーマ不一致は invalid (issues 付き)', async () => {
    const p = join(dir, 'bad.json');
    await writeFile(p, JSON.stringify({ ...validConfig, guildId: '' }), 'utf8');
    const r = await loadConfig(p);
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') {
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });

  it('saveConfig → loadConfig でラウンドトリップする', async () => {
    const p = join(dir, 'config.json');
    await saveConfig(p, validConfig);
    const r = await loadConfig(p);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.config).toEqual(validConfig);
    }
  });

  it('adminRoleName 省略でも既定値 pomo-admin で補完される', async () => {
    const p = join(dir, 'config2.json');
    const withoutRole = {
      default: validConfig.default,
      guildId: validConfig.guildId,
      voiceChannelId: validConfig.voiceChannelId,
    };
    await writeFile(p, JSON.stringify(withoutRole), 'utf8');
    const r = await loadConfig(p);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.config.adminRoleName).toBe('pomo-admin');
    }
  });

  it('volumes 省略でも全音 0dB で補完される (後方互換)', async () => {
    const p = join(dir, 'config3.json');
    const withoutVolumes = {
      default: validConfig.default,
      guildId: validConfig.guildId,
      voiceChannelId: validConfig.voiceChannelId,
      adminRoleName: 'pomo-admin',
      adminRoleNames: [],
    };
    await writeFile(p, JSON.stringify(withoutVolumes), 'utf8');
    const r = await loadConfig(p);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.config.volumes).toEqual({
        workEnd: 0,
        breakEnd: 0,
        finalStart: 0,
        countdownWarning: 0,
        finish: 0,
      });
    }
  });
});
