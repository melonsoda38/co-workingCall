# 音源ファイル ライセンス

このディレクトリには通知音 5 種を配置する。

重要: 音源ファイル本体 (`*.mp3` / `*.ogg`) はライセンス上の再配布制限のため
リポジトリには含めない (.gitignore で除外)。リポジトリは公開設定のため、
効果音ラボ素材の「ファイル単体の再配布」に該当する掲載を避ける目的。
各環境では下記「配置手順」に従って手動でファイルを配置すること。

## ファイル一覧とライセンス

| ファイル              | 用途               | 出典       | ライセンス                     |
| --------------------- | ------------------ | ---------- | ------------------------------ |
| work_end.mp3          | 作業終了の合図     | 効果音ラボ | 利用規約に基づく無料利用       |
| break_end.mp3         | 休憩終了の合図     | 効果音ラボ | 利用規約に基づく無料利用       |
| final_start.mp3       | 最終休憩開始の合図 | OtoLogic   | CC BY 4.0 (クレジット表記必須) |
| countdown_warning.mp3 | 終了10秒前の予告   | OtoLogic   | CC BY 4.0 (クレジット表記必須) |
| finish.mp3            | 全体終了の演出     | 効果音ラボ | 利用規約に基づく無料利用       |

## クレジット表記 (OtoLogic / CC BY 4.0)

OtoLogic 素材は CC BY 4.0 のため帰属表示が必須。以下を表記する。

- 効果音: OtoLogic (https://otologic.jp)

## 出典サイトと規約

- 効果音ラボ: https://soundeffect-lab.info/
  - 商用・非商用問わず無料、クレジット表記不要。
  - 効果音ファイルそのものの再配布は禁止。
  - 利用規約: https://soundeffect-lab.info/agreement/
- OtoLogic: https://otologic.jp/
  - CC BY 4.0。クレジット表記をすれば無料利用・再配布可。
  - 利用規約: https://otologic.jp/free/license.html

## 配置手順

1. 上記出典から 5 種の音源を取得する。
2. このディレクトリ (apps/bot/assets/sounds/) に下記の名前で保存する。
   - work_end.mp3 / break_end.mp3 / final_start.mp3 /
     countdown_warning.mp3 / finish.mp3
3. ファイルが無い場合、再生はスキップされ pino に警告が出るだけで
   bot は停止しない (SoundPlayer の挙動)。

## 音源差し替え時の注意

countdown_warning と finish は長さがフェーズ制御に影響する。差し替える場合は
apps/bot/src/audio/sound-player.ts の以下の定数も必ず更新する。

- COUNTDOWN_WARNING_DURATION_SEC (現在 10)
- FINISH_DURATION_SEC (現在 4)
