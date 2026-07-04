/**
 * 「続行」継続セッションの状態と 23時間キャップを保持する (US-続行)。
 * EmbedManager から切り出し、続行フラグ・残留ユーザ集合・継続用の作業/休憩秒・
 * セッション開始からの強制終了キャップを 1 箇所に閉じ込める。挙動は EmbedManager 内蔵時と同一。
 */
export class ContinueSessionState {
  /** 「続行」が押されたか (最終休憩中に 1 人でも押せば true)。 */
  #continuing = false;
  /** 継続ループへ移行済みか。移行後の ended (VC 0 人 / 23時間) は実終了させる。 */
  #continuousActive = false;
  /** 「続行」を押したユーザ ID 集合。移行時にこの集合以外を強制退出する。 */
  readonly #userIds = new Set<string>();
  /** 継続ループで使う作業/休憩秒。セッション開始時 (begin) に確保する。 */
  #workSec = 0;
  #breakSec = 0;
  /** 元セッションの実施セット数。継続中の「累計の実施セット数」表示の起点に使う。 */
  #baseSets = 0;
  /** セッション開始からの 23時間キャップ用タイマー。 */
  #cap23hTimer: NodeJS.Timeout | null = null;
  readonly #capMs: number;
  readonly #onCap: () => void;

  /**
   * @param capMs セッション開始から強制終了までの時間 (23時間)。
   * @param onCap キャップ発火時のコールバック (EmbedManager の 23時間終了処理)。
   */
  constructor(params: { capMs: number; onCap: () => void }) {
    this.#capMs = params.capMs;
    this.#onCap = params.onCap;
  }

  get continuousActive(): boolean {
    return this.#continuousActive;
  }
  /** 移行時にこの集合以外を強制退出する (読み取り専用ビュー)。 */
  get userIds(): ReadonlySet<string> {
    return this.#userIds;
  }
  get workSec(): number {
    return this.#workSec;
  }
  get breakSec(): number {
    return this.#breakSec;
  }
  get baseSets(): number {
    return this.#baseSets;
  }

  /**
   * 「続行」押下を登録する (最終休憩表示中かの判定は呼び出し側)。
   * @returns 登録後の残留ユーザ数。
   */
  register(userId: string): number {
    this.#continuing = true;
    this.#userIds.add(userId);
    return this.#userIds.size;
  }

  /**
   * セッション開始: 継続用の作業/休憩秒・baseSets を確保し、23時間キャップを arm する。
   * 既存の続行状態・キャップはクリアしてから張り直す。
   */
  begin(params: { workSec: number; breakSec: number; baseSets: number }): void {
    this.reset();
    this.#workSec = params.workSec;
    this.#breakSec = params.breakSec;
    this.#baseSets = params.baseSets;
    this.#armCap();
  }

  /** ended で継続移行すべきか (続行が押されていて未移行)。reason 判定は呼び出し側。 */
  shouldContinue(): boolean {
    return this.#continuing && !this.#continuousActive;
  }

  /** 継続ループへ移行済みにする (以後の ended は実終了)。 */
  markContinuousActive(): void {
    this.#continuousActive = true;
  }

  /** 続行状態と 23時間キャップを初期化する (セッション開始・終了・idle で呼ぶ)。 */
  reset(): void {
    this.#continuing = false;
    this.#continuousActive = false;
    this.#userIds.clear();
    this.#clearCap();
  }

  #armCap(): void {
    this.#clearCap();
    this.#cap23hTimer = setTimeout(() => {
      this.#cap23hTimer = null;
      this.#onCap();
    }, this.#capMs);
  }

  #clearCap(): void {
    if (this.#cap23hTimer !== null) {
      clearTimeout(this.#cap23hTimer);
      this.#cap23hTimer = null;
    }
  }
}
