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
sudo apt install -y libsodium-dev ffmpeg
```

## プロジェクトのデプロイ

### 1. リポジトリのクローン
```
cd ~
git clone https://github.com/<your-account>/co-workingCall.git
cd co-workingCall
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
  ユーザー名@pomodoro-bot.local:~/co-workingCall/apps/bot/assets/sounds/
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
config.json が自動生成される。

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
WorkingDirectory=%h/co-workingCall
# Node のフルバージョンパスを直接書かない (nvm の patch 更新で壊れるため)。
# ランチャが nvm ロード + Node 22 選択 + バージョン検証まで行う。
ExecStart=%h/co-workingCall/scripts/start-bot.sh
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
cd ~/co-workingCall
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
- bot の招待権限を確認。以下 7 つの権限が必要:
  - View Channels / Send Messages / Manage Messages / Connect / Speak / **Move Members** / Embed Links
  - 特に **Move Members は終了時の VC 全員強制退出に必須**。
    欠けていると warn ログのみで黙って失敗する (best-effort のためタイマー自体は終了する)
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
