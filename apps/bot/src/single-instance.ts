import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import type { Logger } from 'pino';

/** 既定の pidfile パス (cwd 相対。本番は apps/bot で実行されるため apps/bot/bot.pid となる)。 */
export const DEFAULT_PID_FILE_PATH = './bot.pid';

const isErrnoException = (err: unknown): err is NodeJS.ErrnoException =>
  err instanceof Error && 'code' in err;

/**
 * 指定 PID が稼働中かを Linux/macOS の signal 0 で判定する。
 * - ESRCH: プロセスなし → false
 * - EPERM: プロセス存在するが権限不足 → 安全側で true 扱い
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrnoException(err)) {
      if (err.code === 'ESRCH') return false;
      if (err.code === 'EPERM') return true;
    }
    return false;
  }
}

export interface SingleInstanceDeps {
  /** pidfile のパス。 */
  pidFilePath: string;
  logger: Logger;
  /** 現在の PID (テスト差し替え用、既定 process.pid)。 */
  currentPid?: number;
  /** PID が生きているか判定する関数 (テスト差し替え用、既定 isProcessAlive)。 */
  isAlive?: (pid: number) => boolean;
}

/**
 * acquireSingleInstance の戻り値。取得成功時は release を呼ぶことで pidfile を削除できる。
 * 呼び出し側で process.on('exit') / SIGTERM / SIGINT から release を呼ぶ想定。
 */
export type AcquireResult = { acquired: true; release: () => void } | { acquired: false };

/**
 * pidfile による単一インスタンスロック (多重起動防止)。
 * 同じトークンの bot が同時に複数稼働すると、両方が同じ voiceStateUpdate / interaction を
 * 処理して Embed 投稿が重複する事故になる (実際に dev で発生)。起動時にここで弾く。
 *
 * 実装:
 * - openSync('wx') の O_CREAT|O_EXCL で「存在しなければ作成」をアトミックに実行し、
 *   同時起動同士の race を回避する。
 * - 既存 pidfile があれば中の PID にシグナル 0 を送って生死を判定:
 *   - 生きていれば fatal ログを残し acquired:false を返す
 *   - 死んでいる/中身が不正なら stale 扱いで削除して 1 回だけリトライする
 * - 取得成功時は release 関数を返す。SIGKILL や OOM で release が呼ばれず pidfile が残った
 *   場合は次回起動時の stale 判定で回収する。
 */
export function acquireSingleInstance(deps: SingleInstanceDeps): AcquireResult {
  const { pidFilePath, logger } = deps;
  const currentPid = deps.currentPid ?? process.pid;
  const isAlive = deps.isAlive ?? isProcessAlive;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(pidFilePath, 'wx');
      try {
        writeSync(fd, String(currentPid));
      } finally {
        closeSync(fd);
      }
      logger.info({ pidFilePath, pid: currentPid }, 'pidfile を取得しました');
      return {
        acquired: true,
        release: () => {
          try {
            unlinkSync(pidFilePath);
          } catch {
            // best-effort: 既に削除済みは無視
          }
        },
      };
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'EEXIST') {
        throw err;
      }
      // 既存 pidfile がある → 中の PID の生死を確認
      let existing: string;
      try {
        existing = readFileSync(pidFilePath, 'utf8').trim();
      } catch (readErr) {
        logger.fatal({ err: readErr, pidFilePath }, 'pidfile の読み込みに失敗しました');
        return { acquired: false };
      }
      const existingPid = Number.parseInt(existing, 10);
      if (Number.isInteger(existingPid) && existingPid > 0 && isAlive(existingPid)) {
        logger.fatal(
          { existingPid, pidFilePath },
          'bot は既に起動中です。既存プロセスを停止してから再起動してください',
        );
        return { acquired: false };
      }
      logger.warn(
        { stalePid: existing, pidFilePath },
        '既存 pidfile を発見しましたが該当 PID は停止済み。stale として削除します',
      );
      try {
        unlinkSync(pidFilePath);
      } catch (unlinkErr) {
        logger.warn({ err: unlinkErr, pidFilePath }, 'stale pidfile の削除に失敗');
        return { acquired: false };
      }
    }
  }
  return { acquired: false };
}
