# Embed表示・自動再投稿仕様

## Embed設計

1つのEmbedテンプレートを全フェーズで使い回し、内容だけ更新する。

### 含める情報
- タイトル: "🍅 ポモドーロタイマー"
- フェーズ表示:
  - "🔥 作業中 (N/M)"  N=現在何セット目、M=総セット数
  - "☕ 休憩中 (N/M)"  N番目の作業後の休憩
  - "🌙 最終休憩"
  - "⏰ もうすぐ終了" (countdownフェーズ)
- 残り時間: "MM:SS" (countdownフェーズでは数字非表示、"──"等)
- 進捗バー: 現フェーズの進行度
- 設定サマリ (フッター等): "作業X分 / 休憩Y分 / Mセット / 最終休憩Z分"

### 通知抑制
全Embed投稿は MessageFlags.SuppressNotifications を**必ず**付ける。
唯一の例外: 終了時の「お疲れさまでした」通知のみ通常送信。

## 各フェーズの動作

| フェーズ    | Embed更新   | 自動削除&再投稿       | 切替時挙動         |
| ---------- | ----------- | -------------------- | ------------------ |
| work       | 5秒ごとedit | ON (debounce+maxWait)| Embed強制リセット   |
| break      | 5秒ごとedit | ON (debounce+maxWait)| Embed強制リセット   |
| finalBreak | 5秒ごとedit | ON (debounce+maxWait)| Embed強制リセット   |
| countdown  | 切替時1回edit | OFF                | "もうすぐ終了"表示 |
| ended      | -           | -                    | 削除→終了通知→4秒余韻→全員退出 |

## 自動削除&再投稿仕様 (デバウンス + 最大待機時間)

### トリガー
- messageCreate イベント
- 対象: 設定したVC内蔵テキストチャンネル
- 除外: msg.author.bot === true のメッセージ
- 除外: countdown / ended フェーズ中

### タイマー設定
- デバウンス時間: 60秒
- 最大待機時間: 180秒 (firstTriggerAt から起算)

### 動作 (lodash debounce with maxWait と同等)
1. 人間メッセージ検知
2. 一連のバーストの最初なら maxWait 180秒タイマー起動
3. debounce 60秒タイマーを起動 (既存があればリセット)
4. debounce 60秒経過 OR maxWait 180秒経過のいずれかで実行
5. 実行 = 旧Embed削除 → 新Embed最下部投稿 (SuppressNotifications)
6. 実行後、両タイマーと firstTriggerAt をクリア

### 実行中の重複防止
- isReposting フラグで再エントリ防止
- 実行中に来たトリガーは再エントリ後の次サイクルで処理

### タイマークリアのタイミング
以下の場合に両タイマーを clearTimeout し、状態を完全リセット:
- タイマー全体停止 (stop コマンド)
- フェーズ切替時 (work↔break, work→finalBreak)
- countdownフェーズ突入時

## フェーズ切替時のEmbedリセット処理

work↔break, work→finalBreak の切替時の動作:

1. 通知音SE再生 (詳細は @docs/audio-spec.md)
2. 旧Embedを削除
3. 新Embedを最下部に投稿 (SuppressNotifications)
4. デバウンス&maxWaitタイマーをクリア
5. 新フェーズ用のEmbed内容で更新を継続

### 意図
maxWait最大180秒を待たずに、切替直後すぐにタイマーを最下部で
見えるようにするため。

## EmbedManager クラス設計指針

```typescript
class EmbedManager {
  private currentMessageId: string | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private firstTriggerAt: number | null = null;
  private isReposting: boolean = false;

  // タイマー側のtickイベントから5秒ごと呼ばれる
  async onTick(snapshot: TimerSnapshot): Promise

  // フェーズ切替時に呼ばれる
  async onPhaseChanged(from: TimerPhase, to: TimerPhase, snapshot: TimerSnapshot): Promise

  // messageCreate イベントから呼ばれる
  onHumanMessage(): void

  // 内部: 削除&再投稿の実体
  private async repostEmbed(snapshot: TimerSnapshot): Promise

  // 内部: タイマークリア
  private clearTimers(): void
}
```

## 重要な技術仕様

- メッセージ検知は messageCreate イベント、対象channelId限定
- msg.author.bot === true は無視
- デバウンスタイマーで setInterval を使用しない (setTimeout + clearTimeout のみ)
- 5秒ごとのEmbed定期更新は別の setInterval (これは継続的更新用なのでOK)
