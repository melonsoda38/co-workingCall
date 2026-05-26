# co-workingCall

Discord ボイスチャンネル上で動作するポモドーロタイマー bot。
作業/休憩のフェーズ切替を音声と Embed で通知し、最終休憩終了時には終了演出 (予告音・終了音・お疲れさま投稿・VC 全員退出) を行う。

## 主な機能

- VC 内蔵テキスト欄のスタート Embed からタイマー開始
- フェーズ切替時の通知音 (work_end / break_end / final_start)
- 最終休憩残り 10 秒で終了予告音 (countdown_warning)
- 終了時の終了演出 (finish.mp3 + お疲れさま投稿 + 3 秒余韻 + VC 全員強制退出 + bot 退出 + 新スタート Embed → idle)
- VC 自動入退室 (人間ゼロ 1 分で退出。タイマー実行中なら終了演出を発動)
- ロール単位のコマンド実行制限 + `/pomo admin-role` で許可ロールを追加管理
- VC テキスト欄に bot 自身の Embed は常に 1 つだけ保つ (新規投稿時に古い Embed を自動掃除)

仕様の詳細は [docs/](docs/) 配下の各 spec を参照。

## リポジトリ構成

pnpm モノレポ。

```
apps/bot/              Discord bot 本体 (discord.js v14, @discordjs/voice)
packages/shared/       zod スキーマと型定義 (BotConfig, TimerConfig 等)
docs/                  仕様書とデプロイ手順
scripts/               起動ランチャ (Node 22 検証つき)
```

## 必要環境

| 項目          | バージョン             | 備考                                                                        |
| ------------- | ---------------------- | --------------------------------------------------------------------------- |
| Node.js       | **22.12 以上**         | DAVE プロトコル必須化により Node 20 以下は不可 ([詳細](docs/deployment.md)) |
| pnpm          | 9.15.9 (corepack 経由) | `corepack enable` で有効化                                                  |
| ffmpeg        | 任意のバージョン       | apt 等で導入。`@discordjs/voice` の依存                                     |
| libsodium-dev | 任意のバージョン       | apt 等で導入。音声暗号化                                                    |

> nvm を使っているなら `.nvmrc` に `22` が固定されているので `nvm install 22 && nvm alias default 22` でセットアップ可能。default を実在バージョンに固定することで `nvm.sh` のソースが exit 3 を返す既知トラブルを回避できる ([memory: dev-env-node-pnpm](docs/) に運用メモあり)。

## セットアップ

```bash
# 1. リポジトリ取得
git clone <repo-url>
cd co-workingCall

# 2. Node 22 を使う (nvm の場合)
nvm use 22

# 3. corepack で pnpm 有効化 + 依存導入
corepack enable
pnpm install

# 4. 環境変数を設定
cp apps/bot/.env.example apps/bot/.env
# .env を編集して DISCORD_TOKEN を実値に差し替える

# 5. ビルド
pnpm -r build

# 6. 起動 (堅牢ランチャ。Node 22 を検証してから bot を起動)
pnpm start
```

初回は Discord 上で `/pomo init` を VC 内テキスト欄から実行し、`config.json` を生成する必要がある。`/pomo init` は「サーバー管理」権限を持つメンバーから実行可能 (詳細は [docs/commands-spec.md](docs/commands-spec.md))。

## 開発用スクリプト

リポジトリルートで実行する横断スクリプト:

| コマンド            | 説明                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `pnpm start`        | `scripts/start-bot.sh` 経由で bot を起動 (Node 22 検証・nvm 自動ロード) |
| `pnpm -r build`     | 全ワークスペースの `tsc -b` でビルド                                    |
| `pnpm typecheck`    | 全ワークスペースの型チェック                                            |
| `pnpm lint`         | eslint で全ファイル検査                                                 |
| `pnpm format`       | prettier で整形 (上書き)                                                |
| `pnpm format:check` | prettier で差分検査 (CI / コミット前向き)                               |
| `pnpm test`         | vitest 実行 (`--passWithNoTests`)                                       |

各ワークスペース固有のスクリプト:

| コマンド                                         | 場所     | 説明                                                           |
| ------------------------------------------------ | -------- | -------------------------------------------------------------- |
| `pnpm --filter @co-working-call/bot dev`         | apps/bot | `node --watch` で dist 変更を再起動 (別途 `tsc -b -w` 推奨)    |
| `pnpm --filter @co-working-call/bot start`       | apps/bot | dist を直接 `node --env-file=.env` で起動 (堅牢ランチャ非経由) |
| `pnpm --filter @co-working-call/bot smoke:audio` | apps/bot | 音声依存スタック (ffmpeg/opus/libsodium) の疎通確認            |

## ロギング

pino による構造化ログ。本番 (systemd journal) では JSON、対話端末では `pino-pretty` で整形表示される。
共通メタデータ `app: 'co-workingCall'` を持ち、`token` / `DISCORD_TOKEN` / `authorization` は `[REDACTED]` に伏字化される。

ローカルで bot ログを追う場合 (TTY 非経由起動時):

```bash
# 別ターミナルで (apps/bot ディレクトリで実行)
cd apps/bot
tail -f /tmp/cowork-bot.log | npx pino-pretty
```

`LOG_LEVEL` は `.env` で `debug` / `info` / `warn` / `error` を指定可能 (既定 `info`)。

## DoD (Definition of Done)

機能を追加・変更したらコミット前に以下を全て緑にする。

```bash
pnpm -r build          # TypeScript ビルドエラー 0
pnpm lint              # ESLint エラー 0
pnpm format:check      # Prettier 差分 0
pnpm test              # Vitest 全テスト passed
```

## デプロイ

Raspberry Pi 5 + Ubuntu Server + systemd ユーザーサービスでの常時稼働を想定。
詳細手順は [docs/deployment.md](docs/deployment.md) を参照。

## 関連ドキュメント

- [docs/spec.md](docs/spec.md) … 全体仕様
- [docs/audio-spec.md](docs/audio-spec.md) … 音声再生仕様
- [docs/voice-spec.md](docs/voice-spec.md) … VC 自動入退室仕様
- [docs/embed-spec.md](docs/embed-spec.md) … Embed ライフサイクル仕様
- [docs/ending-spec.md](docs/ending-spec.md) … 終了演出仕様
- [docs/commands-spec.md](docs/commands-spec.md) … スラッシュコマンド仕様
- [docs/deployment.md](docs/deployment.md) … デプロイ手順
- [docs/backlog.md](docs/backlog.md) … ユーザーストーリーバックログ

## ライセンス

- 音源ファイル: [apps/bot/assets/sounds/LICENSE.md](apps/bot/assets/sounds/LICENSE.md) を参照 (各音源のクレジット表記が必要)
- コード: Private (公開時に決定)
