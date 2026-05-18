import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validate } from './validate.js';

const Schema = z.object({
  name: z.string().min(1),
  nested: z.object({ age: z.number().int().min(0) }),
});

describe('validate', () => {
  it('成功時は ok:true と data を返す', () => {
    const r = validate(Schema, { name: 'x', nested: { age: 1 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.name).toBe('x');
      expect(r.data.nested.age).toBe(1);
    }
  });

  it('失敗時は ok:false と整形済み issues (path: message) を返す', () => {
    const r = validate(Schema, { name: '', nested: { age: -1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.length).toBe(2);
      expect(r.issues.some((m) => m.startsWith('name:'))).toBe(true);
      expect(r.issues.some((m) => m.startsWith('nested.age:'))).toBe(true);
    }
  });

  it('トップレベルの型不一致もメッセージ化する', () => {
    const r = validate(Schema, 'not-an-object');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });
});
