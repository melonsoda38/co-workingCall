import { type ZodTypeAny, z } from 'zod';

/** 検証結果。失敗時は "path: message" 形式の issues を返す。 */
export type ValidationResult<T> = { ok: true; data: T } | { ok: false; issues: string[] };

/**
 * zod スキーマで検証する共通ヘルパ。env と config が同じ仕組みで使う。
 * 例外は投げず ValidationResult を返すので、呼び出し側が待機/終了を選べる。
 */
export function validate<S extends ZodTypeAny>(
  schema: S,
  input: unknown,
): ValidationResult<z.infer<S>> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data as z.infer<S> };
  }
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, issues };
}
