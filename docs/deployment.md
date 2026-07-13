# デプロイ手順

## 概要
Raspberry Pi 5 (8GB) + Ubuntu Server 64-bit にbotをデプロイし、
systemd ユーザーサービスとして24時間常時稼働させる。

## ハードウェア準備

### 必要なもの
- Raspberry Pi 5 (8GB)
- 公式 Active Cooler (発熱対策、必須)
- 公式 27W USB-C 電源
- ファン付きケース
- microSDカード 64GB (SanDisk High Endurance 等、高耐久品推奨)
- LANケーブル (Wi-Fi より安定)

## 初期セットアップ

### 1. Ubuntu Server のインストール
1. メインPCで Raspberry Pi Imager をダウンロード
2. microSD をPCに接続
3. Imager で「Other general-purpose OS」→「Ubuntu Server 24.04 LTS (64-bit)」を選択
4. カスタム設定で以下を事前設定:
   - ホスト名: pomodoro-bot
   - ユーザー名・パスワード
   - Wi-Fi または LAN 設定
   - SSH 有効化、公開鍵を登録
5. 書き込み → microSD を Pi に差し、電源接続

### 2. SSH 接続
```
ssh ユーザー名@pomodoro-bot.local
```

### 3. システム更新
```
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential
```

### 4. Node.js 22 + pnpm のインストール
```
# nvm のインストール
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc

# Node.js 22 のインストール (DAVE 必須化により @discordjs/voice は Node>=22.12 が必要)
nvm install 22
nvm use 22
# default を必ず実在バージョンに固定する。
# lts/* など未導入バージョンを指していると nvm.sh のソースが非ゼロを返し、
# `. nvm.sh && nvm use ...` の && 連結が短絡して system Node に落ちる事故が起きる。
nvm alias default 22

# pnpm は corepack で有効化する (packageManager 固定版が使われる。npm -g では入れない)
corepack enable
```

### 5. 必須システムパッケージ
```
sudo apt install -y libsodium-dev ffmpeg fonts-noto-cjk
```

- `libsodium-dev` / `ffmpeg`: `@discordjs/voice` の音声処理に必要
- `fonts-noto-cjk`: タイマー Embed の円形画像で日本語を描画するために必要。
  未インストールだと `@napi-rs/canvas` が `sans-serif` (DejaVu Sans) にフォールバックし、
  「作業中」「休憩中」「まもなく」「終了」「分」等の日本語が豆腐 (□) になる。
  インストール後は bot を再起動して `GlobalFonts.has('Noto Sans CJK JP')` の判定を
  更新する必要がある (`timer-image.ts` でモジュール読み込み時に一度だけ判定するため)。

## サーバに導入する時

Discord Developer Portal の OAuth2 → URL Generator でbotの招待URLを生成する。
このbotは VC 入室・音声再生・メッセージ管理・VC 全員退出を行うため、
**Guild Install (サーバーへの追加)** で導入する。User Install では Bot Permissions を
持てず VC 入室・常駐ができないため動作しない。

### 必要な SCOPES (2つ)

- **`bot`**: botをサーバーメンバーとして参加させる
- **`applications.commands`**: `/pomo` 系スラッシュコマンドを登録・表示する
  - これが欠けると、botはオンラインになるがコマンド登録 API が `Missing Access (50001)`
    で弾かれ、`/pomo` がコマンド一覧に一切表示されない

### 必要な BOT PERMISSIONS (8つ)

| 権限 (英語UI表記) | 用途 |
| ----------------- | ---- |
| **View Channels** | チャンネル参照 |
| **Send Messages** | スタート/タイマー Embed・お疲れさま投稿 |
| **Embed Links** | Embed (円形画像 UI) の表示 |
| **Attach Files** | **タイマー Embed の円形画像 PNG をアップロードするために必須** |
| **Manage Messages** | 過去 Embed・案内文の自動削除/再投稿 |
| **Connect** | VC への入室 |
| **Speak** | フェーズ切替音・終了演出の再生 |
| **Move Members** | **終了時の VC 全員強制退出に必須** |

- **Attach Files が欠けると、Start Embed は出るが ▶開始 後のタイマー Embed が投稿されない**。
  タイマー Embed は PNG 画像を添付投稿するため、削除だけ走り投稿が `Missing Permissions (50013)`
  で失敗する (Start Embed は添付なしで投稿できるため症状が分かりにくい)。
- **Move Members が欠けると終了時の全員退出が黙って失敗する** (warn ログのみ・タイマーは終了)。
- `permissions` 合計値は **274877967360** (上記8権限の合計)。

### 招待URLの形 (確認用)

```
https://discord.com/api/oauth2/authorize?client_id=<APPLICATION_ID>&permissions=274877967360&scope=bot+applications.commands
```

- `scope=bot+applications.commands` の **両方** が入っていること
- `permissions=274877967360` になっていること
- `<APPLICATION_ID>` は自分のアプリ ID に置換する

### 導入後の注意
- /pomoコマンド実行のために最初はpomo-adminロールを付与する。その後pomo-admin以外のロールへ実行権限を付与するためのコマンドがある。
- Server SettingのIntegrationからbotにpomo-adminロールを付ける
- 招待後 (またはスコープ追加後) は bot を再起動して `registerCommands` を走らせる。
  スラッシュコマンドは起動時に参加中の全ギルドへ登録されるため、
  **プロセス稼働中に新サーバーへ招待しただけではコマンドが登録されない**。
- **複数サーバーで同時運用できる**。設定は guild ごとに別ファイル
  (`<configDir>/<guildId>.json`) で保持し、起動時に全 guild のセッションを構築する。
  新サーバーを追加するときは、そのサーバーで `/pomo init` を実行し、bot を再起動すれば
  既存サーバーの設定はそのまま各サーバーが独立に稼働する (旧サーバー設定を上書きしない)。
- Discord の仕様上、1 つの bot アカウントは **1 サーバーにつき同時 1 VC 接続まで**。
  同一サーバー内で複数 VC を同時稼働させることはできない (別 VC で `/pomo init` すると
  警告ログを出す)。異なるサーバーであれば各 1 VC ずつ同時稼働できる。
- Privileged Gateway Intents は不要 (`Guilds`/`GuildMessages`/`GuildVoiceStates` は
  すべて非特権。Message Content Intent も使わない)。招待に必要な Scope/Permission は
  上記のまま (機能追加による追加要件なし)。

## プロジェクトのデプロイ

### 1. リポジトリのクローン
```
cd ~
git clone https://github.com/<your-account>/co-workingCall.git co-workingCall-limited
cd co-workingCall-limited
pnpm install
```

### 2. 環境変数の設定
```
cd apps/bot
cp .env.example .env
nano .env
```

`.env` に以下を記入:
```
DISCORD_TOKEN=実際のトークン
CONFIG_PATH=./config.json
LOG_LEVEL=info
```

- 設定は guild ごとに `<CONFIG_PATH の拡張子除去名>.guilds/<guildId>.json` に保存される
  (例: `CONFIG_PATH=./config.json` なら `./config.guilds/<guildId>.json`、テストの
  `config.staging.json` なら `./config.staging.guilds/<guildId>.json`)。本番とテストの
  guild 設定が別ディレクトリに分かれる。
  1 つの guild ファイルは複数 VC 設定を同居できる構造だが、現状は各 guild 1 VC で運用する。
- 旧バージョンの単一 `config.json` は、起動時に自動で `config.guilds/<guildId>.json` へ
  移行され、元ファイルは `config.json.migrated` に退避される (手動作業は不要)。

#### 本番/テストの env 自動切り替え (NODE_ENV)

bot は起動時に `NODE_ENV` を見て読み込む env ファイルを切り替える
(`apps/bot/src/load-env.ts`)。

| NODE_ENV | 読む env ファイル | 用途 |
| --- | --- | --- |
| `production` | `apps/bot/.env` | 本番 (この Pi) |
| それ以外/未設定 | `apps/bot/.env.staging` | ローカルのテスト版 app |

- **本番 (この Pi) では `NODE_ENV=production` を設定する。** 後述の systemd
  サービスファイルの `[Service]` に `Environment=NODE_ENV=production` を 1 行
  追記する。これにより `start` 実行時に既存の `.env` が読まれる。
  **`.env` 自体は変更不要。**
- ローカル開発機では `apps/bot/package.json` の `dev` が `NODE_ENV=staging` を
  設定済みのため、`pnpm --filter bot dev` で自動的に `.env.staging` を読む。
  `.env.staging` は `.env.staging.example` をコピーして作る (テスト版 app の
  Token と `CONFIG_PATH=./config.staging.json`)。
- 安全側設計: NODE_ENV が未設定でも staging 扱いになるため、設定漏れで誤って
  本番 Token を使うことはない。本番だけ明示的に `production` を設定する。

### 3. 音源ファイルの配置
音源 mp3 5 ファイルはリポジトリに含まれない (`.gitignore` 対象。公開リポジトリでの再配布禁止のため)。
別途用意した以下 5 ファイルを `apps/bot/assets/sounds/` に手動配置する:

- `work_end.mp3`
- `break_end.mp3`
- `final_start.mp3`
- `countdown_warning.mp3`
- `finish.mp3`

メインPCから Pi へ scp で配置する例:
```
scp work_end.mp3 break_end.mp3 final_start.mp3 countdown_warning.mp3 finish.mp3 \
  ユーザー名@pomodoro-bot.local:~/co-workingCall-limited/apps/bot/assets/sounds/
```

配置しなくても bot は起動するが、フェーズ切替音・終了予告音・終了音が一切鳴らない
(ログには `音源ファイルが見つからないため再生をスキップします` の warn が記録される)。
ライセンス・クレジット要件は [apps/bot/assets/sounds/LICENSE.md](../apps/bot/assets/sounds/LICENSE.md) を参照。

### 4. ビルド
```
pnpm -r build
```

### 5. 動作確認
```
./scripts/start-bot.sh
```
`scripts/start-bot.sh` は nvm をロードして Node 22 系を選択し (シェル状態や
nvm の終了コードに依存しない)、Node が 22 未満なら明確なエラーで停止してから
`corepack pnpm --filter bot start` を実行する堅牢なランチャ。
エラーなく bot が Discord にログインできるか確認し、Ctrl+C で停止。

### 6. /pomo init で初期化
Discord 上で対象 VC を開き、**VC の内蔵テキスト欄**で `/pomo init` を実行
(Discord の「サーバー管理」権限 + `pomo-admin` ロールが必要)。
そのサーバーの設定ファイル `guilds/<guildId>.json` が自動生成される。
複数サーバーで使う場合は、各サーバーで `/pomo init` を実行してから bot を再起動すると、
全サーバーが独立に稼働する。

## systemd ユーザーサービス化

### 1. サービスファイル作成
```
mkdir -p ~/.config/systemd/user
nano ~/.config/systemd/user/pomodoro-bot.service
```

内容:
```
[Unit]
Description=Discord Pomodoro Timer Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/co-workingCall-limited
# 本番であることを示す。これにより bot は .env.staging ではなく既存の .env を読む。
# (未設定だと staging 扱いになり .env.staging を探して起動に失敗する)
Environment=NODE_ENV=production
# Node のフルバージョンパスを直接書かない (nvm の patch 更新で壊れるため)。
# ランチャが nvm ロード + Node 22 選択 + バージョン検証まで行う。
ExecStart=%h/co-workingCall-limited/scripts/start-bot.sh
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

### 2. サービス有効化と起動
```
systemctl --user daemon-reload
systemctl --user enable pomodoro-bot.service
systemctl --user start pomodoro-bot.service
```

### 3. ユーザー lingering の有効化
ログアウト後もサービスが動くように:
```
sudo loginctl enable-linger ユーザー名
```

### 4. 動作確認
```
systemctl --user status pomodoro-bot.service
journalctl --user -u pomodoro-bot.service -f
```
最後のコマンドでログがリアルタイムで見られる。

## 運用コマンド

### 状態確認
```
systemctl --user status pomodoro-bot.service
```

### ログを見る
```
journalctl --user -u pomodoro-bot.service -f      # リアルタイム
journalctl --user -u pomodoro-bot.service -n 100  # 直近100行
```

### 停止/再起動
```
systemctl --user stop pomodoro-bot.service
systemctl --user restart pomodoro-bot.service
```

### コード更新
```
cd ~/co-workingCall-limited
git pull
pnpm install
pnpm -r build
systemctl --user restart pomodoro-bot.service
```

## トラブルシューティング

### bot が Discord にログインできない
- `.env` の DISCORD_TOKEN を確認
- Discord Developer Portal の Privileged Intent は **不要** 。
  本 bot は通常 intent の `Guilds` / `GuildMessages` / `GuildVoiceStates` のみで動作し、
  メッセージ本文は読まないため `Message Content Intent` は要らない
  (有効化していても動作はする)

### VCに入室できない / 終了時に全員退出できない
- bot の招待権限を確認。以下 8 つの権限が必要:
  - View Channels / Send Messages / Embed Links / **Attach Files** / Manage Messages / Connect / Speak / **Move Members**
  - 特に **Move Members は終了時の VC 全員強制退出に必須**。
    欠けていると warn ログのみで黙って失敗する (best-effort のためタイマー自体は終了する)
  - **Attach Files が欠けると ▶開始 後のタイマー Embed (PNG 画像) 投稿が失敗する**
    (Start Embed は出るが Timer Embed が出ない症状になる)
  - `/pomo init` 実行時に不足があれば ephemeral でエラー表示される
- @discordjs/voice の依存 (libsodium, ffmpeg) のインストール確認

### サービスが起動しない
- `journalctl --user -u pomodoro-bot.service -n 50` でログ確認
- WorkingDirectory のパス、ExecStart の `scripts/start-bot.sh` が存在し実行権限が
  あるか確認 (`ls -l scripts/start-bot.sh`、なければ `chmod +x scripts/start-bot.sh`)
- ランチャが「Node 22 以上が必要」で停止する場合は `nvm install 22` と
  `nvm alias default 22` を実行 (default が未導入版を指していると起動が不安定になる)

## セキュリティ

- .env はリポジトリにコミットしない
- DISCORD_TOKEN が流出した場合は即 Developer Portal で再生成
- SSH は公開鍵認証のみ、パスワード認証は無効化推奨
- ufw でファイアウォール設定 (SSH ポート22のみ開放、他は閉じる)

```
sudo ufw allow ssh
sudo ufw enable
sudo ufw status
```
