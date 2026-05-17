# Product Backlog

## Sprint 1: コア基盤

### US-1: モノレポ足場の構築
pnpm workspace で apps/bot, packages/shared を作成。
ESLint flat config、Prettier、Vitest、tsconfig.base.json。
.gitignore に .env, node_modules, dist, *.log を含める。
apps/bot/assets/sounds/*.mp3 は含める (!パターン)。

### US-2: 共有型・スキーマ定義
packages/shared に zod で定義:
- TimerConfig, TimerPhase, TimerSnapshot
- BotConfig (config.json用)
- SessionState (型のみ、ランタイム値はbot側で管理)
詳細は @docs/spec.md 参照。

### US-3: タイマーコアのTDD実装
apps/bot/src/timer/ にDiscord非依存のPomodoroTimer。
Date.now()ベース、EventEmitter、全フェーズ遷移。
countdownフェーズ突入 (残り10秒) と ended 遷移を含む。
Vitest で vi.useFakeTimers を使ったテスト。

## Sprint 2: Discord接続と設定管理

### US-4: Discord bot 起動と最小ログイン
intents設定、ログイン、READY イベント受信。
まだVC接続もスラッシュコマンドも実装しない。

### US-5: 設定読み書きとバリデーション
apps/bot/src/config/ で config.json の読み書き。
zodで検証、無効なら待機状態。
DISCORD_TOKEN 等の環境変数も同じ仕組みでバリデーション。

### US-6: /pomo init スラッシュコマンド実装
登録 + ハンドラ。
実行場所チェック、ロールベース権限、bot権限チェック。
config.json 更新 + スタート用Embed投稿。
詳細は @docs/commands-spec.md 参照。

## Sprint 3: Embed管理

### US-7: 作業スタート用Embedの実装
EmbedBuilder で構築、MessageFlags.SuppressNotifications。
custom_id 'pomo_start', 'pomo_settings_open' のボタン付与。

### US-8: 作業中タイマー用Embedの実装
5秒ごとのedit更新、フェーズ表示、進捗バー。
設定ボタンは disabled。

### US-9: デバウンス+maxWaitクラスのTDD実装
Discord非依存、setTimeoutベース、Vitestテスト。
詳細は @docs/embed-spec.md 参照。

### US-10: 人間メッセージ検知とEmbed自動削除&再投稿の統合
messageCreate イベント、channelIdフィルタ、
EmbedManager クラスでの統合。

### US-11: フェーズ切替時のEmbed強制リセット
work↔break, work→finalBreak の各切替で
デバウンスタイマークリア + 削除&再投稿 + 通知音。

### US-12: タイマー設定モーダルの実装
ボタン押下時にモーダル表示、送信時にzodバリデーション、
config.json更新、スタート用Embed内容更新。

## Sprint 4: VC自動入退室と音声

### US-13: 音声再生基盤の整備
@discordjs/voice の AudioPlayer 初期化。
ffmpeg/libsodium依存解決、最小再生確認。

### US-14: 音源ファイルの準備とライセンス管理
apps/bot/assets/sounds/ に5種類配置:
work_end.mp3, break_end.mp3, final_start.mp3,
countdown_warning.mp3, finish.mp3。
LICENSE.md 作成。詳細は @docs/audio-spec.md 参照。

### US-15: 各フェーズ切替タイミングでの通知音再生統合

### US-16: VC自動入退室の実装
voiceStateUpdate イベント監視、人間メンバー数判定、
0→1+ で自動入室、1+→0 で1分カウントダウン → 退出。
詳細は @docs/voice-spec.md 参照。

### US-17: 入室メッセージの実装
bot入室時にVC内蔵テキスト欄にメッセージ送信。
内容は apps/bot/src/messages.ts に定数として配置。

## Sprint 5: 終了演出と仕上げ

### US-18: 終了予告演出の実装
countdown フェーズ突入時に countdown_warning.mp3 再生 +
Embed表示を "もうすぐ終了" に切替。
5秒ごとedit更新を停止。

### US-19: 終了処理の完全実装
finish.mp3 → Embed削除 → お疲れさま投稿 → 4秒待機
→ VC全員強制退出 → bot即時退出 (CD経由しない)
→ SessionState リセット → 新Embed投稿 → idle。
詳細は @docs/ending-spec.md 参照。

### US-20: VC人間ゼロ起因の終了パターン対応
1分カウントダウン満了時、タイマー実行中なら
通常の終了演出を発動する流れの実装。

### US-21: pino ロギングの整備
全箇所のログを pino に統一、レベル分け、
systemd journal で確認可能に。

### US-22: 起動スクリプトとREADME
pnpm scripts の整理、READMEに開発・デプロイ手順を記載。

## Sprint 6: Pi デプロイと運用

### US-23: Raspberry Pi 5 セットアップ
Ubuntu Server 64-bit インストール、SSH 設定、
Node.js 20 + pnpm のインストール。
詳細は @docs/deployment.md 参照。

### US-24: systemd ユーザーサービス化
Pi上で systemd ユーザーサービスとして登録。
自動起動・自動再起動の確認。

### US-25: 本番運用テスト
実際に作業会で動かしてみて、問題があれば調整。
