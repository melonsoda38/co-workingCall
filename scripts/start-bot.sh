#!/usr/bin/env bash
#
# bot 起動ランチャ (シェル状態・バージョンマネージャの不調に依存しない堅牢版)
#
# 目的:
#   nvm の default エイリアス不整合などで `nvm.sh` のソースが非ゼロを返しても、
#   また systemd のような非ログインシェルからでも、確実に Node 22 系で bot を起動する。
#
# 使い方:
#   scripts/start-bot.sh
#   systemd の ExecStart からも直接指定可能 (deployment.md 参照)。

set -euo pipefail

# スクリプト自身の位置からリポジトリルートを解決 (実行時の cwd に依存しない)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# nvm があればロードして Node 22 系を選択する。
# nvm.sh のソースは default エイリアス不整合時に非ゼロを返すため `|| true` で握りつぶし、
# `&&` 連結による短絡を避ける。use の失敗時は default にフォールバックする。
export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
if [ -s "${NVM_DIR}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh" || true
  nvm use 22 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
fi

# 解決された node のメジャーバージョンを検証し、要件未満なら明確に失敗させる
# (engine-strict の難解なエラーや、Node18 での DAVE 無効化による無音を未然に防ぐ)。
NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  echo "起動失敗: node が見つかりません。nvm で Node 22 を導入してください" >&2
  exit 1
fi
NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "起動失敗: Node 22 以上が必要ですが現在 $(node -v) です (${NODE_BIN})" >&2
  exit 1
fi

cd "${REPO_ROOT}"
# corepack 経由で packageManager 固定の pnpm を使う。exec で PID を引き継ぐ (systemd 管理向け)。
exec corepack pnpm --filter bot start
