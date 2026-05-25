# Embed管理仕様

## 概要
このbotは3種類のDiscord UIを使ってユーザーと対話する。
それぞれの設計、ライフサイクル、ボタン構成を定義する。

## 3種類のDiscord UI

### 1. 作業スタート用Embed
タイマー開始前 (idle状態) に表示。
タイマー開始のトリガーとなる。

含める情報:
- タイトル: "🍅 ポモドーロタイマー"
- 説明: "ボタンを押して作業を始めましょう"
- 現在の設定表示: "作業X分 / 休憩Y分 / Mセット / 最終休憩Z分"

ボタン:
- [▶ タイマー開始]  ← Primary (緑)、大きな主役
- [⚙]              ← Secondary (グレー)、絵文字のみ、控えめ

### 2. 作業中タイマー用Embed
タイマー実行中 (work, break, finalBreak, countdown) に表示。
5秒ごとに残り時間を更新、フェーズ切替時にリセット投稿。

含める情報:
- タイトル: "🍅 ポモドーロタイマー"
- フェーズ表示:
  - "🔥 作業中 (N/M)" / "☕ 休憩中 (N/M)" /
    "🌙 最終休憩" / "⏰ もうすぐ終了"
- 残り時間: "MM:SS" (countdownでは "──" 等の固定表示)
- 進捗バー
- 設定サマリ (フッター)

ボタン: なし (表示専用。設定アイコンは廃止)

### 3. タイマー設定モーダル
設定ボタン押下時に開く。Discord標準のModal Component。
ユーザーが押した瞬間にだけ表示され、そのユーザーにしか見えない。

フィールド (4項目、すべてテキスト入力):
- 作業時間（分）: 数値、デフォルト 25
- 休憩時間（分）: 数値、デフォルト 5
- セット数:       数値、デフォルト 4
- 最終休憩（分）: 数値、デフォルト 15

送信時:
- zodで数値・範囲バリデーション
- OK → config.json 更新、作業スタート用Embedも更新
- NG → ユーザーにエラーメッセージで応答

## Embed投稿時の必須フラグ
全Embed投稿は MessageFlags.SuppressNotifications を必ず付ける。
唯一の例外: 終了時の「お疲れさまでした」通知のみ通常送信。

## 各フェーズでのEmbed動作

| フェーズ    | 表示中Embed       | Embed更新     | 自動削除&再投稿 | 切替時挙動  |
| ---------- | ----------------- | ------------- | -------------- | ----------- |
| idle       | スタート用        | -             | -              | -           |
| work       | タイマー用        | 5秒ごとedit   | ON             | 強制リセット |
| break      | タイマー用        | 5秒ごとedit   | ON             | 強制リセット |
| finalBreak | タイマー用        | 5秒ごとedit   | ON             | 強制リセット |
| countdown  | タイマー用 (切替) | 切替時1回edit | OFF            | -           |
| ended      | -                 | -             | -              | 削除→新スタート用投稿 |

## 自動削除&再投稿仕様

### トリガー
- messageCreate イベント
- 対象: 設定したVC内蔵テキストチャンネル
- 除外: msg.author.bot === true
- 除外: countdown / ended / idle フェーズ中

### タイマー設定
- デバウンス時間: 60秒
- 最大待機時間: 180秒 (firstTriggerAt から起算)

### 動作 (lodash debounce with maxWait 相当)
1. 人間メッセージ検知
2. 一連バーストの最初なら maxWait 180秒タイマー起動
3. debounce 60秒タイマー起動 (既存があればリセット)
4. debounce 60秒経過 OR maxWait 180秒経過 のいずれかで実行
5. 実行 = 旧Embed削除 → 新Embed最下部投稿 (SuppressNotifications)
6. 実行後、両タイマーと firstTriggerAt をクリア

### 実行中の重複防止
- isReposting フラグで再エントリ防止
- 実行中に来たトリガーは再エントリ後の次サイクルで処理

### タイマークリアタイミング
- フェーズ切替 (work↔break, work→finalBreak)
- countdown突入時
- ended処理開始時
- VC自動退出時

## フェーズ切替時のEmbedリセット

work↔break, work→finalBreak の切替時:
1. 通知音SE再生 (詳細は @docs/audio-spec.md)
2. 旧Embedを削除
3. 新Embedを最下部に投稿 (SuppressNotifications)
4. デバウンス&maxWaitタイマーをクリア
5. 新フェーズ用のEmbed内容で5秒ごとedit再開

### 意図
maxWait最大180秒を待たずに、切替直後すぐに最下部で見える状態に保つ。

## Embed遷移パターン

```
[idle] スタート用Embed投稿
   │ 開始ボタン押下
   ▼
[work] スタート用Embed削除 → タイマー用Embed投稿
   │ フェーズ切替 (タイマー進行)
   ▼
[break] タイマー用Embed削除 → タイマー用Embed (内容更新) 投稿
   │ ...
   ▼
[finalBreak] 同上
   │ 残り10秒
   ▼
[countdown] タイマー用Embedを "もうすぐ終了" に edit (新規投稿しない)
   │ タイマー終了
   ▼
[ended] 終了処理 (詳細は @docs/ending-spec.md)
   │ 終了完了
   ▼
[idle] スタート用Embed投稿
```

## EmbedManager クラス設計指針

```
class EmbedManager {
  // 状態
  - currentStartEmbedMessageId : string | null
  - currentTimerEmbedMessageId : string | null
  - debounceTimer / maxWaitTimer / firstTriggerAt
  - isReposting : boolean

  // 呼ばれるイベント
  + onIdle()                    // スタート用Embed投稿
  + onTimerStart(config)        // スタート用削除 → タイマー用投稿
  + onTick(snapshot)            // 5秒ごとedit
  + onPhaseChanged(from, to)    // 削除&再投稿、タイマークリア
  + onCountdownEnter()          // countdownへの遷移、editのみ
  + onEnded()                   // 全クリア → スタート用投稿
  + onHumanMessage()            // デバウンス開始

  // 内部
  - repostTimerEmbed()
  - clearTimers()
}
```

## 重要な技術仕様
- メッセージ検知は messageCreate イベント、対象channelId限定
- msg.author.bot === true は無視
- デバウンスタイマーで setInterval を使用しない
  (setTimeout + clearTimeout のみ)
- 5秒ごとのEmbed定期更新は別の setInterval (継続的更新用)
- 各ボタンの custom_id は明確に分ける
  (例: 'pomo_start', 'pomo_settings_open')
