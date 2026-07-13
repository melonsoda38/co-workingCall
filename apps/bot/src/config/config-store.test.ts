import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotConfig } from '@co-working-call/shared';
import {
  guildConfigPath,
  loadAllGuildConfigs,
  loadGuildConfigFile,
  loadVcConfig,
  migrateLegacyConfig,
  resolveConfigDir,
  saveVcConfig,
} from './config-store.js';

const makeConfig = (
  guildId: string,
  voiceChannelId: string,
  overrides: Partial<BotConfig> = {},
): BotConfig => ({
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 600 },
  guildId,
  voiceChannelId,
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
  volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
  autoStart: { time: null, label: '自動スタート' },
  ...overrides,
});

describe('config-store (per-guild)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cwc-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('guild ファイルが無ければ missing', async () => {
    expect((await loadGuildConfigFile(dir, '1001')).status).toBe('missing');
    expect((await loadVcConfig(dir, '1001', 'vc1')).status).toBe('missing');
  });

  it('JSON 構文エラーは invalid', async () => {
    await writeFile(guildConfigPath(dir, '1001'), '{ not json', 'utf8');
    expect((await loadGuildConfigFile(dir, '1001')).status).toBe('invalid');
  });

  it('スキーマ不一致は invalid (issues 付き)', async () => {
    await writeFile(guildConfigPath(dir, '1001'), JSON.stringify({ guildId: '', vcs: [] }), 'utf8');
    const r = await loadGuildConfigFile(dir, '1001');
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') {
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });

  it('saveVcConfig → loadVcConfig でラウンドトリップする', async () => {
    const config = makeConfig('1001', 'vc1');
    await saveVcConfig(dir, config);
    const r = await loadVcConfig(dir, '1001', 'vc1');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.config).toEqual(config);
    }
  });

  it('同一 guild の別 VC を保存すると同一ファイルに同居する', async () => {
    await saveVcConfig(dir, makeConfig('1001', 'vc1'));
    await saveVcConfig(dir, makeConfig('1001', 'vc2'));
    const file = await loadGuildConfigFile(dir, '1001');
    expect(file.status).toBe('ok');
    if (file.status === 'ok') {
      expect(file.file.vcs.map((v) => v.voiceChannelId)).toEqual(['vc1', 'vc2']);
    }
    // それぞれ独立に取り出せる
    expect((await loadVcConfig(dir, '1001', 'vc1')).status).toBe('ok');
    expect((await loadVcConfig(dir, '1001', 'vc2')).status).toBe('ok');
  });

  it('同一 VC を再保存すると差し替えられ重複しない・guild レベル項目も更新される', async () => {
    await saveVcConfig(dir, makeConfig('1001', 'vc1'));
    await saveVcConfig(
      dir,
      makeConfig('1001', 'vc1', { adminRoleName: 'newadmin', adminRoleNames: ['staff'] }),
    );
    const file = await loadGuildConfigFile(dir, '1001');
    if (file.status === 'ok') {
      expect(file.file.vcs).toHaveLength(1);
      expect(file.file.adminRoleName).toBe('newadmin');
      expect(file.file.adminRoleNames).toEqual(['staff']);
    }
  });

  it('loadAllGuildConfigs は複数 guild / 複数 VC を全て平坦化して返す', async () => {
    await saveVcConfig(dir, makeConfig('1001', 'vc1'));
    await saveVcConfig(dir, makeConfig('1001', 'vc2'));
    await saveVcConfig(dir, makeConfig('1002', 'vc3'));
    const all = await loadAllGuildConfigs(dir);
    const pairs = all.map((a) => `${a.guildId}:${a.config.voiceChannelId}`).sort();
    expect(pairs).toEqual(['1001:vc1', '1001:vc2', '1002:vc3']);
  });

  it('loadAllGuildConfigs はディレクトリ不在なら空配列', async () => {
    expect(await loadAllGuildConfigs(join(dir, 'nope'))).toEqual([]);
  });

  it('loadAllGuildConfigs は不正ファイル (JSON壊れ/非snowflake名) をスキップして有効分だけ返す', async () => {
    await saveVcConfig(dir, makeConfig('1001', 'vc1'));
    // 数字 stem だが JSON 壊れ → invalid でスキップ。
    await writeFile(guildConfigPath(dir, '9999'), '{ not json', 'utf8');
    // 非 snowflake 名 (path traversal 対策で対象外) → スキップ。
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
    await writeFile(join(dir, '..evil.json'), '{ not json', 'utf8');
    const all = await loadAllGuildConfigs(dir);
    expect(all).toHaveLength(1);
    expect(all[0]?.guildId).toBe('1001');
  });

  it('guildConfigPath は非 snowflake の guildId を拒否する (path traversal 対策)', () => {
    expect(() => guildConfigPath(dir, '../etc/passwd')).toThrow();
    expect(() => guildConfigPath(dir, 'a/b')).toThrow();
    expect(() => guildConfigPath(dir, '')).toThrow();
    expect(() => guildConfigPath(dir, '123')).not.toThrow();
  });

  it('migrateLegacyConfig は旧 config.json を per-guild へ移行し .migrated へ退避する', async () => {
    const legacyPath = join(dir, 'config.json');
    const configDir = join(dir, 'guilds');
    await writeFile(legacyPath, JSON.stringify(makeConfig('1001', 'vc1')), 'utf8');

    const migrated = await migrateLegacyConfig(legacyPath, configDir);
    expect(migrated).toBe(true);
    expect((await loadVcConfig(configDir, '1001', 'vc1')).status).toBe('ok');
    // 旧ファイルは .migrated へ退避
    await expect(stat(legacyPath)).rejects.toThrow();
    await expect(stat(`${legacyPath}.migrated`)).resolves.toBeDefined();
  });

  it('migrateLegacyConfig は旧ファイル不在なら false (何もしない)', async () => {
    expect(await migrateLegacyConfig(join(dir, 'nope.json'), join(dir, 'guilds'))).toBe(false);
  });

  it('migrateLegacyConfig は既存 per-guild を上書きしないが旧ファイルは退避する', async () => {
    const legacyPath = join(dir, 'config.json');
    const configDir = join(dir, 'guilds');
    // 既存 per-guild (別 VC)
    await saveVcConfig(configDir, makeConfig('1001', 'vcExisting'));
    await writeFile(legacyPath, JSON.stringify(makeConfig('1001', 'vcLegacy')), 'utf8');

    expect(await migrateLegacyConfig(legacyPath, configDir)).toBe(true);
    const file = await loadGuildConfigFile(configDir, '1001');
    if (file.status === 'ok') {
      // 上書きされず既存のみ
      expect(file.file.vcs.map((v) => v.voiceChannelId)).toEqual(['vcExisting']);
    }
    await expect(stat(`${legacyPath}.migrated`)).resolves.toBeDefined();
  });

  it('resolveConfigDir は CONFIG_PATH 名を基に <stem>.guilds を返す (本番/テスト分離)', () => {
    expect(resolveConfigDir('/data/config.json')).toBe(join('/data', 'config.guilds'));
    expect(resolveConfigDir('./config.json')).toBe(join('.', 'config.guilds'));
    expect(resolveConfigDir('./config.staging.json')).toBe(join('.', 'config.staging.guilds'));
  });

  it('saveVcConfig は書式付き JSON (末尾改行) で書き込む', async () => {
    await saveVcConfig(dir, makeConfig('1001', 'vc1'));
    const raw = await readFile(guildConfigPath(dir, '1001'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  ');
  });
});
