import { ModalBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_MODAL_ID,
  buildSettingsModal,
  parseSettingsModalInput,
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
    expect(
      parseSettingsModalInput({ workMin: '60', breakMin: '30', sets: '20', finalMin: '30' }).ok,
    ).toBe(true);
  });

  it('範囲外はフィールド別エラー文言を返す', () => {
    const r = parseSettingsModalInput({
      workMin: '0',
      breakMin: '31',
      sets: '21',
      finalMin: '0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('作業時間は1〜60分の整数で入力してください');
      expect(r.errors).toContain('休憩時間は1〜30分の整数で入力してください');
      expect(r.errors).toContain('セット数は1〜20の整数で入力してください');
      expect(r.errors).toContain('最終休憩は1〜30分の整数で入力してください');
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
