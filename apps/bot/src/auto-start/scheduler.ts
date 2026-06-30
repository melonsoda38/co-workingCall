import type { Logger } from 'pino';

/** 日本標準時 (JST) は UTC+9 固定 (サマータイム無し)。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * JST の "HH:MM" 壁時計時刻が、now (epoch ms) から見て次に訪れる瞬間の epoch ms を返す純関数。
 * 当日分の時刻がまだ未来ならその当日、既に過ぎていれば翌日を返す。
 *
 * JST は UTC+9 固定なので、now を +9h ずらすと UTC のカレンダー欄がそのまま JST 壁時計になる。
 * そこから当日 JST の y/m/d を取り出し、目標 HH:MM の JST 壁時計を Date.UTC で組んでから
 * -9h して epoch に戻す。DST が無いためこの単純計算で常に正しい。
 */
export function nextJstOccurrenceEpochMs(time: string, nowEpochMs: number): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) {
    throw new Error(`不正な時刻形式です: ${time}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);

  const jstNow = new Date(nowEpochMs + JST_OFFSET_MS);
  const year = jstNow.getUTCFullYear();
  const month = jstNow.getUTCMonth();
  const day = jstNow.getUTCDate();

  let target = Date.UTC(year, month, day, hour, minute, 0, 0) - JST_OFFSET_MS;
  if (target <= nowEpochMs) {
    target += DAY_MS;
  }
  return target;
}

export interface AutoStartSchedulerDeps {
  logger: Logger;
  /** 発火時に実行する処理 (本番では runAutoStart のラッパ)。 */
  onFire: () => Promise<void>;
  /** 現在時刻 (epoch ms)。テスト差し替え用。既定は Date.now。 */
  now?: () => number;
}

/**
 * 指定した JST 時刻に毎日 onFire を呼ぶスケジューラ。
 * setTimeout で次回発火までを待ち、発火後は finally で翌日分を自動再武装する
 * (発火遅延は常に 24h 未満なので setTimeout の 32bit 制限内)。
 * time=null で無効化でき、設定変更時は schedule を呼び直して再武装する。
 */
export class AutoStartScheduler {
  readonly #logger: Logger;
  readonly #onFire: () => Promise<void>;
  readonly #now: () => number;

  #timeout: NodeJS.Timeout | null = null;
  #time: string | null = null;

  constructor(deps: AutoStartSchedulerDeps) {
    this.#logger = deps.logger;
    this.#onFire = deps.onFire;
    this.#now = deps.now ?? ((): number => Date.now());
  }

  /** 現在武装中の時刻 (JST "HH:MM")。null なら無効。 */
  get scheduledTime(): string | null {
    return this.#time;
  }

  /**
   * 自動スタート時刻を設定し直す。既存の予約はクリアする。
   * time=null なら無効化のみ。非 null なら次回 JST 発火まで setTimeout を張る。
   */
  schedule(time: string | null): void {
    this.#clear();
    this.#time = time;
    if (time === null) {
      this.#logger.info('自動スタートは無効です (時刻未設定)');
      return;
    }
    const delay = nextJstOccurrenceEpochMs(time, this.#now()) - this.#now();
    this.#timeout = setTimeout(() => {
      void this.#fire();
    }, delay);
    this.#logger.info({ time, delayMs: delay }, '自動スタートを予約しました (JST)');
  }

  /** 予約を解除する (シャットダウン・テスト用)。 */
  stop(): void {
    this.#clear();
    this.#time = null;
  }

  async #fire(): Promise<void> {
    this.#timeout = null;
    const time = this.#time;
    try {
      await this.#onFire();
    } catch (err) {
      this.#logger.error({ err }, '自動スタートの実行に失敗しました');
    } finally {
      // 同じ時刻で翌日分を再武装する (time が変更/無効化されていなければ)。
      if (this.#time !== null && this.#time === time) {
        this.schedule(this.#time);
      }
    }
  }

  #clear(): void {
    if (this.#timeout !== null) {
      clearTimeout(this.#timeout);
      this.#timeout = null;
    }
  }
}
