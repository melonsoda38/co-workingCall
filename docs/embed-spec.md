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

更新タイミングは「次の5の倍数秒境界 (残り秒の1の位が0/5)」の **少し手前** に
吸着させる:
post の API 往復遅延 (数百ms〜2s) を吸収し、表示が "59→54→49" のように
半端な値で並ぶのを防ぐ。

実装は自己補正 setTimeout チェイン (毎回 getSnapshot() を読んで次の境界手前を
再計算)。setInterval を使うと再アームごとに微小ドリフトが蓄積するため、長時間
セッションで境界からズレ得る。

安全マージン 50ms: setTimeout は OS タイマー精度 + イベントループ要因で常に
正の方向にジッタを持つ (1〜数十ms)。境界ちょうど (例 remaining=55,000ms) を
狙うと jitter で remaining=54,9xx ms 時点で発火し、Math.floor(54999/1000)=54
で 1 つ前の秒 ("00:54") が表示されてしまう。50ms 手前で発火させると
jitter ∈ [0, 50ms) は境界を越えず "00:55" が安定して表示される。

レイアウト (一目で「残り時間」「今どのフェーズ」「何セット目」が分かる構造):
- タイトル: "🍅 ポモドーロタイマー" (固定)
- 左バー色 (Embed color): フェーズで切替
  - work=赤 (0xE74C3C) / break=緑 (0x2ECC71) / finalBreak=青 (0x3498DB) /
    countdown=黄 (0xF1C40F) / idle・ended=灰 (0x95A5A6)
- 横並び 3 フィールド (inline: true、左から):
  - 残り: 平文 "MM:SS" (countdown は "──")。
    Embed field の value は Markdown 見出し (#, ##) が非対応のため使わない。
  - フェーズ: "🔥 作業中" / "☕ 休憩中" / "🌙 最終休憩" / "⏰ もうすぐ終了"
  - セット: "N/M" (work/break) / "最終" (finalBreak/countdown)
- 進捗バー: inline 行の下に独立 field (inline: false、name は zero-width space で
  非表示化、value はフェーズ内進捗バー ▰▱ 10 分割)
- 設定サマリ: 進捗バーから 1 行分の空行を挟む独立 field (inline: false、
  value 先頭の `<ZWSP>\n` で空行 x1 を作る)。
  内容は "作業X分 / 休憩Y分 / Mセット / 最終休憩Z分"
- description / footer は使わない (description は fields より上に描画され、
  footer は自動セパレータ付きで間隔を制御しにくいため)

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
- OK → config.json 更新 → ephemeral "設定を保存しました ✅" 応答 →
  作業スタート用 Embed を投稿し直す (旧 Embed を delete → 最新設定で再 post、
  チャンネル最下部に最新版が出る)
- スタート用 Embed が存在しない (タイマー稼働中等) 場合は再投稿は no-op
  (config 自体は保存済み・▶開始時の loadConfig で最新値が反映される)
- 再投稿の失敗は best-effort: warn ログのみで保存応答は成功扱いのまま
- NG → ユーザーにエラーメッセージで応答 (config.json は変更されない)

## Embed投稿時の必須フラグ
全Embed投稿は MessageFlags.SuppressNotifications を必ず付ける。
例外: 以下のプレーンテキスト投稿のみ通常送信 (SuppressNotifications なし)。
- 「お疲れさまでした 👋」(終了時、ending-spec §第二段階)
- 「ご参加ありがとうございます〜 / 一緒に作業・勉強よろしくおねがいします。」
  (タイマー開始時、参加者への歓迎)

これらは Embed ではないため purgeOwnEmbeds の対象外。EmbedManager が messageId を
追跡し、終了演出 (onEnded) と onIdle (`/pomo stop`) の双方で明示的に削除する。

## VCテキスト欄は常に Embed 1 つに保つ
新規 Embed 投稿の**直前**に、対象 VC 内蔵テキスト欄から bot 自身が投稿した
Embed 付きメッセージを全て削除する (purgeOwnEmbeds)。これにより以下の追跡漏れを
含めてテキスト欄に bot の Embed は常に 1 つだけ存在する状態を保つ:
- bot 異常終了で `#startEmbedId` / `#timerEmbedId` がリセットされた残骸
- `/pomo init` 連打で同一 VC に積まれた古いスタート Embed
- その他追跡されていない古い Embed

対象: bot 自身が投稿した・Embed を含むメッセージのみ (他 bot/人間や Embed なしの
bot メッセージは触らない)。fetch 上限 100 件、削除は best-effort (個別失敗は warn のみ)。
呼び出し箇所は `EmbedManager` の post を全て `#postFresh` (purge→post) でラップし、
`/pomo init` の直接投稿経路でも明示呼び出しする。

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
