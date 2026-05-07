# Product Backlog

## Sprint 1: コア基盤

### US-1: モノレポ足場の構築
pnpm workspace, ESLint, Prettier, Vitest, tsconfig.

### US-2: 共有型・WSスキーマ定義
packages/shared に zod で TimerConfig, TimerPhase, 
TimerSnapshot, WSメッセージ型を定義。
詳細は @docs/spec.md の「共有型定義」参照。

### US-3: タイマーコアのTDD実装
apps/bot/src/timer/ にDiscord非依存のPomodoroTimer。
Date.now()ベース、EventEmitter、全フェーズ遷移。
countdownフェーズ突入(残り10秒)とended遷移を含む。

## Sprint 2: Discord連携と通信

### US-4: Discord bot 起動と VC参加・退出の最小実装
intents設定、ログイン、joinVoiceChannel、退出処理。

### US-5: WebSocketサーバー実装 (bot側)
ws パッケージで localhost:8787。
Client→Server / Server→Client メッセージのルーティング。

### US-6: WebSocketクライアント・自動再接続 (web側)
指数バックオフ、reconnect。

## Sprint 3: Embed表示ロジック

### US-7: タイマーEmbedの初回投稿と5秒ごとedit更新
EmbedBuilder、MessageFlags.SuppressNotifications。
詳細は @docs/embed-spec.md 参照。

### US-8: デバウンス+maxWaitクラスのTDD実装
Discord非依存。setTimeoutベース。
Vitestで vi.useFakeTimers を使った網羅テスト。

### US-9: 人間メッセージ検知とEmbed自動削除&再投稿の統合
messageCreate イベント、channelIdフィルタ、
EmbedManager クラスでの統合。

### US-10: フェーズ切替時のEmbed強制リセット
work↔break, work→finalBreak の各切替で
デバウンスタイマークリア + 削除&再投稿。

## Sprint 4: 音声機能

### US-11: 音声再生基盤の整備
@discordjs/voice の AudioPlayer 初期化。
ffmpeg依存解決、最小再生確認。

### US-12: 音源ファイルの準備とライセンス管理
apps/bot/assets/sounds/ に5種類配置。
LICENSE.md 作成。詳細は @docs/audio-spec.md 参照。

### US-13: 各フェーズ切替タイミングでの通知音再生統合

### US-14: 終了予告演出
countdown_warning.mp3 を残り10秒で1回再生。
Embed表示を "もうすぐ終了" に切替。
5秒ごとのedit更新を停止。

## Sprint 5: UI と仕上げ

### US-15: Web UI - 設定フォーム
作業/休憩/セット数/最終休憩 + zodバリデーション。

### US-16: Web UI - タイマー進行状況表示
WS経由で snapshot 受信、リアルタイム表示。

### US-17: 終了処理の完全実装
finish.mp3 再生 → お疲れさま投稿 → 4秒余韻 
→ VC全員強制退出 → bot終了。
詳細は @docs/ending-spec.md 参照。

### US-18: 起動スクリプト・READMEの整備
pnpm dev:all、環境構築手順、Discord bot招待手順。
