# コマンド・インタラクション仕様

## 概要
このbotがユーザーに提供する操作インターフェースの仕様。
- スラッシュコマンド: /pomo init のみ (初期セットアップ用)
- Embedボタン: 通常運用の操作
- Modal: 設定変更

## スラッシュコマンド

### /pomo init
初期セットアップ・復旧用。
**通常運用では使用しない** (Embedのボタン操作で完結)。

#### 実行条件
- **実行場所**: VC内蔵テキスト欄でのみ実行可能
  通常のテキストチャンネルで実行されたら拒否
- **権限**: ロールベース
  config.json の adminRoleName (デフォルト 'pomo-admin') を持つメンバーのみ

#### 処理フロー

```
ユーザーが /pomo init 実行
   ↓
[実行場所チェック]
  VC内蔵テキスト欄か?
  ├ Yes → 次へ
  └ No  → エラー応答 "VC内のテキスト欄で実行してください" → 終了

[権限チェック]
  実行者が adminRoleName を持つか?
  ├ Yes → 次へ
  └ No  → エラー応答 "権限がありません" → 終了

[VC権限チェック]
  bot自身がそのVCに対して必要権限を持つか?
  ├ Yes → 次へ
  └ No  → エラー応答 "botにVCアクセス権限がありません" → 終了

[既存Embed削除 (best-effort)]
  config.json に古い voiceChannelId があれば、
  そのVC内のスタート用Embedを削除を試みる
  (失敗してもエラーにしない、ログのみ)

[config.json 更新]
  guildId, voiceChannelId を現在のVCの値に書き込み
  adminRoleName が未設定なら 'pomo-admin' で初期化

[スタート用Embed投稿]
  そのVC内蔵テキスト欄に新しい作業スタート用Embedを投稿

[完了応答]
  "セットアップ完了しました" (ユーザーにのみ見える ephemeral)
```

#### エラーメッセージ
| 状況 | メッセージ |
|---|---|
| 場所がVC外 | "このコマンドはボイスチャンネル内のテキスト欄で実行してください" |
| 権限不足 | "このコマンドの実行には pomo-admin ロールが必要です" |
| bot権限不足 | "botがこのVCにアクセスする権限がありません。管理者に確認してください" |
| その他 | "セットアップに失敗しました。ログを確認してください" |

すべて ephemeral (実行者にのみ表示) で返す。

#### 実行時のDiscord応答
- スラッシュコマンドは 3秒以内に応答必須
- 処理に時間がかかる可能性があるので deferReply() で延長
- 完了したら editReply() で最終応答

## Embedボタン

### 作業スタート用Embedのボタン

#### [▶ タイマー開始] (Primary、緑)
- custom_id: 'pomo_start'
- スタイル: Primary
- ラベル: "タイマー開始"
- 絵文字: ▶

押下時の動作:
```
[実行者がVC内にいるかチェック]
  ├ No  → ephemeral "VCに参加してから押してください" → 終了
  └ Yes → 次へ

[bot自身がVCにいるかチェック]
  ├ No  → bot入室 → 次へ
  └ Yes → 次へ

[タイマー開始処理]
  config.json から TimerConfig 構築
  作業スタート用Embed削除
  作業中タイマー用Embed投稿 (SuppressNotifications)
  PomodoroTimer を start
```

#### [⚙] (Secondary、グレー)
- custom_id: 'pomo_settings_open'
- スタイル: Secondary
- ラベル: なし (空文字)
- 絵文字: ⚙

押下時の動作:
```
タイマー設定モーダルを表示
```

### 作業中タイマー用Embedのボタン

#### [⚙] (Disabled)
- custom_id: 'pomo_settings_open_disabled'
- スタイル: Secondary
- 絵文字: ⚙
- disabled: true (作業中は変更不可)

押下時の動作:
- 押せない (disabled なので)
- ホバー時に「作業中は設定変更できません」と表示
  (Discord クライアントが自動で表示する標準動作)

## タイマー設定モーダル

### 構成

```
タイトル: "🍅 タイマー設定"

フィールド1: 作業時間（分）
  type: TextInput, style: Short, required: true
  placeholder: "25", min_length: 1, max_length: 3

フィールド2: 休憩時間（分）
  type: TextInput, style: Short, required: true
  placeholder: "5", min_length: 1, max_length: 3

フィールド3: セット数
  type: TextInput, style: Short, required: true
  placeholder: "4", min_length: 1, max_length: 2

フィールド4: 最終休憩（分）
  type: TextInput, style: Short, required: true
  placeholder: "15", min_length: 1, max_length: 3
```

### 送信時の処理

```
[バリデーション (zod)]
  各値を Number() で変換、整数チェック、範囲チェック:
    workSec (= workMin * 60): 60〜3600
    breakSec: 60〜1800
    sets: 1〜20
    finalBreakSec: 60〜1800
  ├ NG → ephemeral でエラー返却
  │       "作業時間は1〜60分の整数で入力してください" 等
  └ OK → 次へ

[config.json 更新]
  default.workSec, default.breakSec, default.sets,
  default.finalBreakSec を更新

[スタート用Embed更新]
  現在のスタート用Embedに新設定を反映 (内容のみedit)

[完了応答]
  ephemeral "設定を保存しました ✅"
```

### エラーメッセージ
| フィールド | 範囲外 | メッセージ |
|---|---|---|
| 作業時間 | <1 or >60 | "作業時間は1〜60分の整数で入力してください" |
| 休憩時間 | <1 or >30 | "休憩時間は1〜30分の整数で入力してください" |
| セット数 | <1 or >20 | "セット数は1〜20の整数で入力してください" |
| 最終休憩 | <1 or >30 | "最終休憩は1〜30分の整数で入力してください" |

## インタラクション応答のタイムアウト
- Discord API は 3秒以内の応答を要求
- 処理が長い場合は deferReply() / deferUpdate() を最初に呼ぶ
- その後 editReply() / followUp() で最終応答

## custom_id 一覧

| custom_id | 用途 |
|---|---|
| pomo_start | 作業スタート用Embedの開始ボタン |
| pomo_settings_open | 作業スタート用Embedの設定ボタン |
| pomo_settings_open_disabled | 作業中タイマー用Embedの設定ボタン (無効) |
| pomo_settings_modal | 設定モーダル本体 (送信識別用) |

custom_id は変更すると過去のインタラクションが動かなくなるので注意。
