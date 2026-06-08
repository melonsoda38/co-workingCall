# コマンド・インタラクション仕様

## 概要
このbotがユーザーに提供する操作インターフェースの仕様。
- スラッシュコマンド: /pomo init (初期セットアップ + bot 入室)、/pomo stop (タイマー強制停止・テスト用)、/pomo admin-role (許可ロール管理)
- Embedボタン: 通常運用の操作
- Modal: 設定変更

## スラッシュコマンド

### コマンドの可視性
`/pomo` は `setDefaultMemberPermissions(ManageGuild)` を指定し、コマンド一覧に
**「サーバー管理」権限を持つメンバーにのみ表示**する。一般メンバーの一覧には出ない。
- 可視性は Discord 仕様上トップレベルの `/pomo` 単位でかかる (サブコマンド個別の
  可視制御は不可)。`/pomo` 系は全て管理操作なので一括で隠して問題ない。
- `pomo-admin` 等のロールに見せたい場合は、そのロールに「サーバー管理」権限を付与する。
- 実行可否はこの可視性とは独立に、各ハンドラのロール判定で別途担保する (二重防御)。

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

[bot を VC に入室させる] (旧 /pomo join 相当・US-22 で init に統合)
  稼働中セッションがあれば VoiceManager.ensureConnected() を呼ぶ
  ├ 既に接続済み → no-op (冪等)
  ├ 未接続 → join + SoundPlayer.init で VC 入室
  └ 接続失敗 → ephemeral でエラー通知 (init 自体の config 保存は成功扱い)
  セッションが無い場合 (初回 init、まだ setupVoiceFeature が走っていない)
  は bot 再起動が必要な旨を案内

[完了応答]
  "セットアップ完了しました (bot が VC に入室済み)" (ephemeral)
  ├ session 無 → "セットアップ完了しました。bot を再起動すると VC 自動入退室が有効化されます"
  └ VC 接続失敗 → "セットアップ完了しましたが VC への接続に失敗しました..."
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

### /pomo stop (テスト用)
動作中のタイマーを強制停止し、bot を VC から退出させてスタート Embed に戻す。
- 実行場所: VC内蔵テキスト欄でのみ (それ以外は /pomo init と同じエラー文言で拒否)
- 権限: adminRoleName (pomo-admin) ロール
- 動作: timer.stop() → VoiceManager.forceDisconnect() (VC退出) → EmbedManager.onIdle()
- タイマー設定 (config.json) は保持する (リセットしない)
- 成功時は確認メッセージを出さない (deferReply → deleteReply の無言確認)
- 退出後に bot を再入室させたい場合は **/pomo init を再実行**する (旧 /pomo join は廃止)

### /pomo admin-role add / remove / list
コマンド実行を許可する追加ロールを GUI のロール選択で管理する。
- 実行場所: VC内蔵テキスト欄でのみ。権限: 現在の許可ロールのいずれか
- 許可ロール = 基準ロール `adminRoleName` (既定 pomo-admin、常に許可・外せない) +
  追加ロール `adminRoleNames` (config.json)
- `add role:@ロール` … 追加許可ロールに足す / `remove role:@ロール` … 外す /
  `list` … 現在の許可ロール一覧を表示
- ロールは「名前」で保存 (現行の名前一致方式に合わせる。ロール改名時は再登録が必要)
- 変更は config.json 保存に加え、稼働中セッションへも即反映 (再起動不要)

## Embedボタン

### 作業スタート用Embedのボタン

#### [▶ タイマー開始] (Primary、緑)
- custom_id: 'pomo_start'
- スタイル: Primary
- ラベル: "タイマー開始"
- 絵文字: ▶
- 権限: `/pomo` と同じ許可ロール (基準ロール `adminRoleName` + 追加ロール `adminRoleNames`)。
  Discord はボタンをロール別に非表示にできないため、ボタンは全員に見えるが
  押下時にロール判定して権限がなければ弾く方式。

押下時の動作:
```
[実行者が許可ロールを持つかチェック]
  ├ No  → ephemeral "この操作には <許可ロール> のいずれかのロールが必要です" → 終了
  └ Yes → 次へ

[実行者がVC内にいるかチェック]
  ├ No  → ephemeral "VCに参加してから押してください" → 終了
  └ Yes → 次へ

[二重起動チェック]
  ├ timer.phase !== 'idle' または 終了演出進行中 (embedManager.isEnding)
  │    → ephemeral "すでにタイマーが動作中です" → 終了
  └ それ以外 → 次へ
  ※ 自然 ended は演出中 phase='ended'、空VC経由は timer.stop 済みで 'idle' になるため、
    phase だけでなく isEnding も見て一貫して弾く。

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
- 権限: ▶開始と同じ許可ロール。押下時に判定し、権限がなければモーダルを開かず弾く。

押下時の動作:
```
[実行者が許可ロールを持つかチェック]
  ├ No  → ephemeral "この操作には <許可ロール> のいずれかのロールが必要です" → 終了
  └ Yes → タイマー設定モーダルを表示
```

### 作業中タイマー用Embedのボタン

作業/休憩フェーズの作業中タイマー Embed は表示専用 (ボタンなし)。

例外として **最終休憩 (finalBreak) フェーズのみ**「続行」ボタンを置く (US-続行)。

#### [続行] (Success、緑) ※ 最終休憩のみ

- 表示位置: 最終休憩の Timer Embed の footer に設定サマリへ続けて「続ける場合:」を
  表示し、その直下 (Embed の下) に「続行」ボタンを 1 つ置く。
  「続ける場合:」はテキスト、ボタンは「続行」ラベルのみ。
- 権限: ▶開始と違い**管理ロール限定にしない**。対象 VC の参加者なら誰でも押せる
  (続行は「自分が残るか」の個人選択のため)。
- 押下時:
  - 実行者が対象 VC にいなければ ephemeral "VCに参加してから押してください"
  - 受理されたら ephemeral "続行を受け付けました。このまま VC に残って作業を続けられます"
  - 受付終了 (最終休憩以外・既に継続移行済み・終了処理中) なら ephemeral
    "続行の受付は終了しました"
- 効果 (詳細は ending-spec.md §続行):
  - 最終休憩終了時に 1 人でも続行を押していれば、終了演出をせず**継続ループ**へ移行する。
  - 継続ループは開始時の作業/休憩時間で「作業→休憩→…」を無限に繰り返す
    (セット数による終了はしない)。継続中の画像はセット数の代わりに「N回目」を表示。
  - 続行を**押していない**人は最終休憩終了時に強制退出する。押した人は VC に残る。
  - 終了は VC が 0 人になったとき (通常の空 VC 自動終了) か、セッション開始から
    23 時間経過の強制終了のいずれか。23 時間強制終了時は「次の作業通話のため〜」を投稿。

## タイマー設定モーダル

### 構成

```
タイトル: "🍅 タイマー設定"

フィールド1: 作業時間（分）
  type: TextInput, style: Short, required: true
  placeholder: "50", min_length: 1, max_length: 3

フィールド2: 休憩時間（分）
  type: TextInput, style: Short, required: true
  placeholder: "10", min_length: 1, max_length: 3

フィールド3: セット数
  type: TextInput, style: Short, required: true
  placeholder: "2", min_length: 1, max_length: 3

フィールド4: 最終休憩（分）
  type: TextInput, style: Short, required: true
  placeholder: "15", min_length: 1, max_length: 3
```

### 送信時の処理

```
[バリデーション (zod)]
  各値を Number() で変換、整数チェック、範囲チェック:
    workSec (= workMin * 60): 60〜59940 (= 1〜999分)
    breakSec: 60〜59940 (= 1〜999分)
    sets: 1〜999
    finalBreakSec: 60〜59940 (= 1〜999分)
  ├ NG → ephemeral でエラー返却
  │       "作業時間は1〜999分の整数で入力してください" 等
  └ OK → 次へ

[config.json 更新]
  default.workSec, default.breakSec, default.sets,
  default.finalBreakSec を更新

[完了応答]
  ephemeral "設定を保存しました ✅"

[スタート用Embed投稿し直し]
  既存スタート用Embedを delete → 最新設定で再 post
  (チャンネル最下部に最新版が来る / Embedは常に1つの原則は維持)
  スタート用Embedが無い (タイマー稼働中等) 場合は no-op
  失敗は best-effort: warn ログのみ・ユーザー応答は成功扱いのまま
```

### エラーメッセージ
| フィールド | 範囲外 | メッセージ |
|---|---|---|
| 作業時間 | <1 or >999 | "作業時間は1〜999分の整数で入力してください" |
| 休憩時間 | <1 or >999 | "休憩時間は1〜999分の整数で入力してください" |
| セット数 | <1 or >999 | "セット数は1〜999の整数で入力してください" |
| 最終休憩 | <1 or >999 | "最終休憩は1〜999分の整数で入力してください" |

## インタラクション応答のタイムアウト
- Discord API は 3秒以内の応答を要求
- 処理が長い場合は deferReply() / deferUpdate() を最初に呼ぶ
- その後 editReply() / followUp() で最終応答

## custom_id 一覧

| custom_id | 用途 |
|---|---|
| pomo_start | 作業スタート用Embedの開始ボタン |
| pomo_settings_open | 作業スタート用Embedの設定ボタン |
| pomo_settings_modal | 設定モーダル本体 (送信識別用) |
| pomo_continue | 最終休憩 Embed の続行ボタン (US-続行) |

custom_id は変更すると過去のインタラクションが動かなくなるので注意。
