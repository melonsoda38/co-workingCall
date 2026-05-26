# 全体仕様

## 概要
Discord VC用ポモドーロタイマーbot。Pi 5 (Ubuntu Server) で24時間常駐。
Discord内のEmbedボタンとモーダルだけで操作する。
人間ユーザーのVC入退室に連動してbotも自動入退室する。
最終休憩終了時はVC全員強制退出後、新Embedを投稿して待機状態に戻る。

## システム構成

```
[開発PC (Linux)] ─ git push ─► [GitHub] ◄─ git pull ─ [Pi 5 (Ubuntu Server)]
                                                              │
                                                              │ Discord接続
                                                              ▼
                                                      [Discord サーバー]
                                                         🔊 作業通話VC
                                                         🤖 bot (常駐)
                                                         👤 参加者
                                                              ▲
                                                              │ /pomo init (初回)
                                                              │ ボタン操作・モーダル
                                                      [ユーザー (PC/スマホ)]
```

## bot ライフサイクル

```
Pi起動 → systemd が bot 起動
   ↓
設定検証
  ├ config無効 → ログのみ → idle (Embed投稿なし)
  └ config有効 → 設定VCへ作業スタート用Embed投稿 → idle
   ↓
[ユーザーVC入室] → bot自動入室 (入室メッセージ送信)
   ↓
[開始ボタン] → スタートEmbed削除 → タイマーEmbed投稿
   → タイマー実行 (work → break → ... → finalBreak → countdown)
   ↓
[タイマー終了 (ended)]
  finish.mp3 → Embed削除 → お疲れさま投稿 → 3秒待機
  → VC全員強制退出 → bot即時退出 (CD無し) → スタートEmbed投稿 → idle
   ↓
[人間ゼロ30秒継続] → bot自動退出 (タイマー中なら停止 + 終了処理 → 退出)
```

**重要**: タイマー終了時に process.exit() しない (Pi稼働中ずっと常駐)
VC接続管理は人間ユーザー数連動 (タイマー状態と独立)

## フェーズ遷移

```
idle → work(1) → break(1) → ... → work(N) → finalBreak → countdown → ended → idle
```

| フェーズ    | 動作                                              |
| ---------- | ------------------------------------------------ |
| idle       | スタートEmbed投稿状態、タイマー開始待ち            |
| work       | 作業時間、タイマーEmbed常時表示、再投稿ON         |
| break      | 休憩時間、タイマーEmbed常時表示、再投稿ON         |
| finalBreak | 最終休憩、タイマーEmbed常時表示、再投稿ON         |
| countdown  | 残り10秒の予告、再投稿OFF、Embed切替表示          |
| ended      | 終了処理 → idle に戻る                            |

## 共有型定義 (packages/shared)

zodスキーマで定義し z.infer で型を導出する。

### TimerConfig (タイマー1回分の設定)
```
workSec       : number (60〜3600)
breakSec      : number (60〜1800)
sets          : number (1〜20)
finalBreakSec : number (60〜1800)
```

### TimerPhase
```
'idle' | 'work' | 'break' | 'finalBreak' | 'countdown' | 'ended'
```

### TimerSnapshot (タイマー状態のスナップショット)
```
phase        : TimerPhase
remainingMs  : number
currentSet   : number
totalSets    : number
startedAt    : number | null
```

### BotConfig (永続化設定、config.json)
```
default: { workSec, breakSec, sets, finalBreakSec },
guildId         : string,
voiceChannelId  : string,
adminRoleName   : string  // /pomo init 実行権限 (デフォルト 'pomo-admin')
```
初回起動時は config.json が存在しないので待機状態。
/pomo init 実行時に生成される。

### SessionState (メモリ上、リセット対象)
セッション終了時にリセットする項目:
- タイマー: timer, currentTimerEmbedMessageId, currentStartEmbedMessageId
- デバウンス: isReposting, debounceTimer, maxWaitTimer, firstTriggerAt
- VC: voiceConnection, emptyVcTimeoutTimer (30秒カウントダウン)
- エラー: lastError, errorCount

## 環境変数 (.env)
- DISCORD_TOKEN: string (必須)
- CONFIG_PATH: string (デフォルト './config.json')
- LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error' (デフォルト 'info')

## エラー時の動作
- 起動時設定検証エラー → ログのみ、idle待機 → /pomo init で復旧
- VC接続失敗 → ログ、idleに戻す
- メッセージ送信失敗 → ログのみ、リトライしない
- 音源再生失敗 → ログ、その回スキップして処理続行
- 致命的エラー → ログ、systemdが自動再起動

検証項目: config.json存在 → guildId有効 → voiceChannelId有効
       → bot権限 (View/Send/Connect/Speak/Manage Messages/Embed Links/Move Members)

## レート制限への配慮
- discord.jsが自動でRESTレート制限を処理
- カウントダウンは音源1回再生方式 (毎秒API叩かない設計)
- 大規模VC全員退出は順次実行 + 小休止
- 429発生時はpinoでログ記録

## ディレクトリ構成

```
project-root/
├── CLAUDE.md
├── docs/                # 設計書
├── apps/
│   └── bot/
│       ├── src/
│       │   ├── index.ts
│       │   ├── timer/         # タイマーコア
│       │   ├── discord/       # Discord接続
│       │   ├── commands/      # スラッシュコマンド
│       │   ├── audio/         # 音声再生
│       │   ├── voice/         # VC自動入退室
│       │   ├── embed/         # Embed管理
│       │   ├── config/        # 設定読み書き
│       │   └── messages.ts    # メッセージ定数
│       ├── assets/
│       │   └── sounds/
│       │       └── LICENSE.md
│       ├── .env
│       └── config.json        # 自動生成
└── packages/
    └── shared/                # 共有型定義
```
