import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModalBuilder } from 'discord.js';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '@co-working-call/shared';
import type { VoiceSession } from '../voice/session-registry.js';
import {
  VOLUME_MODAL_ID,
  WORK_END_VOL_ID,
  BREAK_END_VOL_ID,
  FINAL_START_VOL_ID,
  COUNTDOWN_VOL_ID,
  FINISH_VOL_ID,
  buildVolumeModal,
  handleVolumeButton,
  handleVolumeModalSubmit,
  parseVolumeModalInput,
} from './volume-modal.js';

const ZERO = { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 };

describe('parseVolumeModalInput', () => {
  it('有効な dB 入力をそのまま返す', () => {
    const r = parseVolumeModalInput({
      workEnd: '-10',
      breakEnd: '0',
      finalStart: '20',
      countdownWarning: '-50',
      finish: '50',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.volumes).toEqual({
        workEnd: -10,
        breakEnd: 0,
        finalStart: 20,
        countdownWarning: -50,
        finish: 50,
      });
    }
  });

  it('境界値 (-50・50) を受理する', () => {
    expect(
      parseVolumeModalInput({
        workEnd: '-50',
        breakEnd: '50',
        finalStart: '-50',
        countdownWarning: '50',
        finish: '0',
      }).ok,
    ).toBe(true);
  });

  it('範囲外 (-51・51) はフィールド別エラー文言を返す', () => {
    const r = parseVolumeModalInput({
      workEnd: '-51',
      breakEnd: '51',
      finalStart: '0',
      countdownWarning: '0',
      finish: '0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('休憩開始は-50〜50の整数(dB)で入力してください');
      expect(r.errors).toContain('作業開始は-50〜50の整数(dB)で入力してください');
    }
  });

  it('非整数・空・非数値を拒否する', () => {
    expect(parseVolumeModalInput({ ...strAll('0'), workEnd: '2.5' }).ok).toBe(false);
    expect(parseVolumeModalInput({ ...strAll('0'), workEnd: '' }).ok).toBe(false);
    expect(parseVolumeModalInput({ ...strAll('0'), workEnd: 'abc' }).ok).toBe(false);
  });
});

function strAll(v: string) {
  return {
    workEnd: v,
    breakEnd: v,
    finalStart: v,
    countdownWarning: v,
    finish: v,
  };
}

describe('buildVolumeModal', () => {
  it('custom_id とタイトル・5フィールドを持つ', () => {
    const modal = buildVolumeModal(ZERO);
    expect(modal).toBeInstanceOf(ModalBuilder);
    const json = modal.toJSON();
    expect(json.custom_id).toBe(VOLUME_MODAL_ID);
    expect(json.components).toHaveLength(5);
  });
});

describe('handleVolumeModalSubmit', () => {
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
    volumes: ZERO,
    autoStart: { time: null, label: '自動スタート' },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cowork-volume-'));
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

  function makeInteraction(values: Record<string, string>) {
    const reply = vi.fn<(options: ReplyOptions) => Promise<void>>(() => Promise.resolve());
    const deleteReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
    return {
      fields: { getTextInputValue: (id: string): string => values[id] ?? '' },
      reply,
      deleteReply,
      deferred: false,
      replied: false,
    };
  }

  function makeSession() {
    const repostStartEmbed = vi.fn<(config: BotConfig) => Promise<void>>(() => Promise.resolve());
    const session = { embedManager: { repostStartEmbed } } as unknown as VoiceSession;
    return { session, repostStartEmbed };
  }

  it('検証成功時: config.volumes を保存し repostStartEmbed を呼ぶ', async () => {
    const interaction = makeInteraction({
      [WORK_END_VOL_ID]: '-10',
      [BREAK_END_VOL_ID]: '0',
      [FINAL_START_VOL_ID]: '5',
      [COUNTDOWN_VOL_ID]: '-3',
      [FINISH_VOL_ID]: '10',
    });
    const { session, repostStartEmbed } = makeSession();

    await handleVolumeModalSubmit(
      interaction as unknown as Parameters<typeof handleVolumeModalSubmit>[0],
      session,
      configPath,
      logger,
    );

    const expectedVolumes = {
      workEnd: -10,
      breakEnd: 0,
      finalStart: 5,
      countdownWarning: -3,
      finish: 10,
    };
    const saved = JSON.parse(await readFile(configPath, 'utf-8')) as BotConfig;
    expect(saved.volumes).toEqual(expectedVolumes);
    expect(repostStartEmbed).toHaveBeenCalledTimes(1);
    expect(repostStartEmbed.mock.calls[0]?.[0]?.volumes).toEqual(expectedVolumes);
    // 既存のタイマー設定は保持される。
    expect(saved.default).toEqual(initialConfig.default);
  });

  it('検証失敗時: 保存も repost もせずエラー文言を返す', async () => {
    const interaction = makeInteraction({
      [WORK_END_VOL_ID]: '999', // 範囲外
      [BREAK_END_VOL_ID]: '0',
      [FINAL_START_VOL_ID]: '0',
      [COUNTDOWN_VOL_ID]: '0',
      [FINISH_VOL_ID]: '0',
    });
    const { session, repostStartEmbed } = makeSession();

    await handleVolumeModalSubmit(
      interaction as unknown as Parameters<typeof handleVolumeModalSubmit>[0],
      session,
      configPath,
      logger,
    );

    const replyCall = interaction.reply.mock.calls[0]?.[0];
    expect(replyCall?.content).toContain('休憩開始は-50〜50の整数(dB)で入力してください');
    expect(repostStartEmbed).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(configPath, 'utf-8')) as BotConfig;
    expect(saved.volumes).toEqual(ZERO);
  });

  it('repostStartEmbed が reject しても例外を伝播させず warn のみ', async () => {
    const interaction = makeInteraction({
      [WORK_END_VOL_ID]: '0',
      [BREAK_END_VOL_ID]: '0',
      [FINAL_START_VOL_ID]: '0',
      [COUNTDOWN_VOL_ID]: '0',
      [FINISH_VOL_ID]: '0',
    });
    const repostStartEmbed = vi.fn(() => Promise.reject(new Error('discord down')));
    const session = { embedManager: { repostStartEmbed } } as unknown as VoiceSession;

    await expect(
      handleVolumeModalSubmit(
        interaction as unknown as Parameters<typeof handleVolumeModalSubmit>[0],
        session,
        configPath,
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('handleVolumeButton', () => {
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
    volumes: { ...ZERO, workEnd: -8 },
    autoStart: { time: null, label: '自動スタート' },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cowork-volume-btn-'));
    configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(initialConfig), 'utf-8');
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeButtonInteraction(memberRoles: string[] = ['pomo-admin']) {
    const showModal = vi.fn<(modal: ModalBuilder) => Promise<void>>(() => Promise.resolve());
    const reply = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const fetch = vi.fn(() =>
      Promise.resolve({ roles: { cache: memberRoles.map((name) => ({ name })) } }),
    );
    return {
      message: { id: 'start-embed-msg-id' },
      user: { id: 'user-1' },
      guild: { id: 'g', members: { fetch } },
      showModal,
      reply,
    };
  }

  function makeSession() {
    const adoptStartEmbed = vi.fn<(id: string) => void>();
    const session = { embedManager: { adoptStartEmbed } } as unknown as VoiceSession;
    return { session, adoptStartEmbed };
  }

  it('許可ロール保持者: adopt して現在音量でモーダルを表示する', async () => {
    const interaction = makeButtonInteraction();
    const { session, adoptStartEmbed } = makeSession();

    await handleVolumeButton(
      interaction as unknown as Parameters<typeof handleVolumeButton>[0],
      session,
      configPath,
      logger,
    );

    expect(adoptStartEmbed).toHaveBeenCalledWith('start-embed-msg-id');
    expect(interaction.showModal).toHaveBeenCalledTimes(1);
  });

  it('許可ロールを持たない実行者は弾かれモーダルを表示しない', async () => {
    const interaction = makeButtonInteraction(['everyone']);
    const { session, adoptStartEmbed } = makeSession();

    await handleVolumeButton(
      interaction as unknown as Parameters<typeof handleVolumeButton>[0],
      session,
      configPath,
      logger,
    );

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(adoptStartEmbed).not.toHaveBeenCalled();
    expect(interaction.showModal).not.toHaveBeenCalled();
  });
});
