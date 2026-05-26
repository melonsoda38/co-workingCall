import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageFlags, ModalBuilder } from 'discord.js';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '@co-working-call/shared';
import type { VoiceSession } from '../voice/session-registry.js';
import {
  SETTINGS_MODAL_ID,
  buildSettingsModal,
  handleSettingsModalSubmit,
  parseSettingsModalInput,
  WORK_MIN_ID,
  BREAK_MIN_ID,
  SETS_ID,
  FINAL_MIN_ID,
} from './settings-modal.js';

describe('parseSettingsModalInput', () => {
  it('有効な分入力を秒に換算して返す', () => {
    const r = parseSettingsModalInput({
      workMin: '25',
      breakMin: '5',
      sets: '4',
      finalMin: '15',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.timer).toEqual({ workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 });
    }
  });

  it('境界値 (最小・最大) を受理する', () => {
    expect(
      parseSettingsModalInput({ workMin: '1', breakMin: '1', sets: '1', finalMin: '1' }).ok,
    ).toBe(true);
    // 最大はすべて 999。
    expect(
      parseSettingsModalInput({ workMin: '999', breakMin: '999', sets: '999', finalMin: '999' }).ok,
    ).toBe(true);
  });

  it('範囲外はフィールド別エラー文言を返す', () => {
    const r = parseSettingsModalInput({
      workMin: '0',
      breakMin: '1000',
      sets: '1000',
      finalMin: '0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('作業時間は1〜999分の整数で入力してください');
      expect(r.errors).toContain('休憩時間は1〜999分の整数で入力してください');
      expect(r.errors).toContain('セット数は1〜999の整数で入力してください');
      expect(r.errors).toContain('最終休憩は1〜999分の整数で入力してください');
    }
  });

  it('非整数・空・非数値を拒否する', () => {
    expect(
      parseSettingsModalInput({ workMin: '2.5', breakMin: '5', sets: '4', finalMin: '15' }).ok,
    ).toBe(false);
    expect(
      parseSettingsModalInput({ workMin: '', breakMin: '5', sets: '4', finalMin: '15' }).ok,
    ).toBe(false);
    expect(
      parseSettingsModalInput({ workMin: 'abc', breakMin: '5', sets: '4', finalMin: '15' }).ok,
    ).toBe(false);
  });
});

describe('buildSettingsModal', () => {
  it('custom_id とタイトル・4フィールドを持つ', () => {
    const modal = buildSettingsModal({
      workSec: 1500,
      breakSec: 300,
      sets: 4,
      finalBreakSec: 900,
    });
    expect(modal).toBeInstanceOf(ModalBuilder);
    const json = modal.toJSON();
    expect(json.custom_id).toBe(SETTINGS_MODAL_ID);
    expect(json.title).toBe('🍅 タイマー設定');
    expect(json.components).toHaveLength(4);
  });
});

describe('handleSettingsModalSubmit (Start Embed 投稿し直し結線)', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  let dir: string;
  let configPath: string;
  const initialConfig: BotConfig = {
    default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
    guildId: 'g',
    voiceChannelId: 'vc',
    adminRoleName: 'pomo-admin',
    adminRoleNames: [],
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cowork-settings-'));
    configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(initialConfig), 'utf-8');
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  interface ReplyOptions {
    content: string;
    flags: number;
  }

  function makeInteraction(fields: {
    workMin: string;
    breakMin: string;
    sets: string;
    finalMin: string;
  }) {
    const reply = vi.fn<(options: ReplyOptions) => Promise<void>>(() => Promise.resolve());
    const deleteReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const fieldsMap: Record<string, string> = {
      [WORK_MIN_ID]: fields.workMin,
      [BREAK_MIN_ID]: fields.breakMin,
      [SETS_ID]: fields.sets,
      [FINAL_MIN_ID]: fields.finalMin,
    };
    return {
      fields: {
        getTextInputValue: (id: string): string => fieldsMap[id] ?? '',
      },
      reply,
      deleteReply,
      deferred: false,
      replied: false,
    };
  }

  function makeSession(repostImpl: (config: BotConfig) => Promise<void> = () => Promise.resolve()) {
    const repostStartEmbed = vi.fn(repostImpl);
    const session = {
      embedManager: { repostStartEmbed },
    } as unknown as VoiceSession;
    return { session, repostStartEmbed };
  }

  it('検証成功時: reply 後に repostStartEmbed を最新 config で呼ぶ', async () => {
    const interaction = makeInteraction({
      workMin: '30',
      breakMin: '7',
      sets: '3',
      finalMin: '20',
    });
    const { session, repostStartEmbed } = makeSession();

    // discord.js の ModalSubmitInteraction 完全実装は不要 (handleSettingsModalSubmit が
    // 使うのは fields/reply のみ)。型は as 経由でゆるく流す。
    await handleSettingsModalSubmit(
      interaction as unknown as Parameters<typeof handleSettingsModalSubmit>[0],
      session,
      configPath,
      logger,
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: '設定を保存しました ✅',
      flags: MessageFlags.Ephemeral,
    });
    expect(repostStartEmbed).toHaveBeenCalledTimes(1);
    const passed = repostStartEmbed.mock.calls[0]?.[0];
    expect(passed?.default).toEqual({
      workSec: 1800,
      breakSec: 420,
      sets: 3,
      finalBreakSec: 1200,
    });
    // config.json も実際に上書きされている (再投稿に渡される config と整合)。
    const saved = JSON.parse(await readFile(configPath, 'utf-8')) as BotConfig;
    expect(saved.default).toEqual(passed?.default);
  });

  it('検証失敗時: repostStartEmbed は呼ばず エラー文言を ephemeral で返す', async () => {
    const interaction = makeInteraction({
      workMin: '0', // 範囲外
      breakMin: '5',
      sets: '4',
      finalMin: '15',
    });
    const { session, repostStartEmbed } = makeSession();

    await handleSettingsModalSubmit(
      interaction as unknown as Parameters<typeof handleSettingsModalSubmit>[0],
      session,
      configPath,
      logger,
    );

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const replyCall = interaction.reply.mock.calls[0]?.[0];
    expect(replyCall?.content).toContain('作業時間は1〜999分の整数で入力してください');
    expect(repostStartEmbed).not.toHaveBeenCalled();
    // config.json は変更されない。
    const saved = JSON.parse(await readFile(configPath, 'utf-8')) as BotConfig;
    expect(saved.default).toEqual(initialConfig.default);
  });

  it('session 未注入 (READY 前) でも config 保存とユーザー応答は成功する', async () => {
    const interaction = makeInteraction({
      workMin: '25',
      breakMin: '5',
      sets: '4',
      finalMin: '15',
    });

    await handleSettingsModalSubmit(
      interaction as unknown as Parameters<typeof handleSettingsModalSubmit>[0],
      undefined,
      configPath,
      logger,
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: '設定を保存しました ✅',
      flags: MessageFlags.Ephemeral,
    });
    const saved = JSON.parse(await readFile(configPath, 'utf-8')) as BotConfig;
    expect(saved.default).toEqual({ workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 });
  });

  it('repostStartEmbed が reject しても例外を伝播させず warn ログのみ (best-effort)', async () => {
    const interaction = makeInteraction({
      workMin: '25',
      breakMin: '5',
      sets: '4',
      finalMin: '15',
    });
    const { session, repostStartEmbed } = makeSession(() =>
      Promise.reject(new Error('discord api down')),
    );

    await expect(
      handleSettingsModalSubmit(
        interaction as unknown as Parameters<typeof handleSettingsModalSubmit>[0],
        session,
        configPath,
        logger,
      ),
    ).resolves.toBeUndefined();

    expect(repostStartEmbed).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: '設定を保存しました ✅',
      flags: MessageFlags.Ephemeral,
    });
    // logger.warn が呼ばれている (引数の詳細までは緩く検証)。
    expect(logger.warn).toHaveBeenCalled();
  });
});
