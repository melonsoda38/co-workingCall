/**
 * セッション状態 (メモリ上)。docs/spec.md の SessionState。
 * セッション終了時にリセットする項目を表す型で、ランタイム値は bot 側で管理する。
 *
 * タイマー実体・VoiceConnection・タイマーハンドル等のランタイム依存型は
 * shared に持ち込まず、bot 側で具象型を注入する型パラメータとして抽象化する。
 */
export interface SessionState<
  TTimer = unknown,
  TVoiceConnection = unknown,
  TTimerHandle = unknown,
> {
  // タイマー
  timer: TTimer | null;
  currentTimerEmbedMessageId: string | null;
  currentStartEmbedMessageId: string | null;
  // デバウンス (Embed 再投稿)
  isReposting: boolean;
  debounceTimer: TTimerHandle | null;
  maxWaitTimer: TTimerHandle | null;
  firstTriggerAt: number | null;
  // VC
  voiceConnection: TVoiceConnection | null;
  emptyVcTimeoutTimer: TTimerHandle | null;
  // エラー
  lastError: Error | null;
  errorCount: number;
}
