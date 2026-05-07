# 全体仕様

## 概要
Discordのボイスチャンネルで使うポモドーロ風タイマーbot。
タイマーはVC内蔵テキスト欄にEmbedで常時表示する。
全フェーズで人間メッセージを検知し、デバウンス&最大待機時間で
Embedを自動削除&再投稿することで最下部に保つ。
フェーズ切替時は通知音(SE)を再生し、Embedを最下部にリセットする。
最終休憩終了時は予告音→終了音→VC全員強制退出→bot終了。

## システム構成

```
┌─ ユーザーのLinux PC ───────────────────────┐
│                                            │
│  ブラウザ (http://localhost:5173)           │
│   └ apps/web (React、設定UI/状態表示)       │
│            ↕ WebSocket                     │
│  Node.jsプロセス                            │
│   └ apps/bot (タイマー・Discord接続・WS)    │
└────────────────────────────────────────────┘
           ↕ Discord Gateway / Voice
       Discord サーバー
        - 🔊 作業通話VC
        - 🤖 bot
        - 👤 参加者
```

## 通信方式
- localhost WebSocket (ws://localhost:8787)
- タイマーの正本はbotプロセスのメモリ
- WebはbotにWSコマンドを送って状態取得・操作するだけ
- Web側は状態を持たない (リロードしてもbot側状態から復元可能)

## フェーズ遷移
idle → work(1) → break(1) → work(2) → ... → work(N) 
  → finalBreak → countdown(残り10秒) → ended

| フェーズ    | 動作                                       |
| ---------- | ----------------------------------------- |
| idle       | タイマー停止状態                            |
| work       | 作業時間。Embed常時表示、再投稿ON          |
| break      | 休憩時間。Embed常時表示、再投稿ON          |
| finalBreak | 最終休憩。Embed常時表示、再投稿ON          |
| countdown  | 残り10秒の予告。再投稿OFF、Embed切替表示    |
| ended      | 終了処理 (削除→通知→余韻→退出)             |

## 共有型定義 (packages/shared)

zodスキーマで定義し、z.inferで型を導出する。

### TimerConfig
- workSec: number (60〜3600)
- breakSec: number (60〜1800)
- sets: number (1〜20)
- finalBreakSec: number (60〜1800)
- guildId: string
- voiceChannelId: string

### TimerPhase
'idle' | 'work' | 'break' | 'finalBreak' | 'countdown' | 'ended'

### TimerSnapshot
- phase: TimerPhase
- remainingMs: number
- currentSet: number
- totalSets: number
- startedAt: number | null

### WSメッセージ (discriminated union, 'type'で判別)
Client→Server:
- { type: 'start', config: TimerConfig }
- { type: 'stop' }
- { type: 'getSnapshot' }

Server→Client:
- { type: 'snapshot', snapshot: TimerSnapshot }
- { type: 'phaseChanged', from: TimerPhase, to: TimerPhase, snapshot: TimerSnapshot }
- { type: 'ended' }
- { type: 'error', message: string }

## 環境変数 (apps/bot/.env)
zodでバリデーション:
- DISCORD_TOKEN: string (必須)
- GUILD_ID: string (必須)
- VOICE_CHANNEL_ID: string (必須)
- WS_PORT: number (デフォルト 8787)

## レート制限への配慮
- discord.jsはRESTレート制限を内部で自動処理するため通常は意識不要
- カウントダウンは音源1回再生方式なので毎秒APIを叩かない設計
- 大規模VC（10人超）での全員退出は順次実行+小休止を入れる
- レート制限エラー(429)が発生した場合はpinoでログ記録
