# 音声通知仕様

## 概要

VC参加中のbotから音声ファイルを再生して通知する。
通知音はすべてSE(短い効果音)で、人間音声・言語は使わない。

## 音源ファイル

### 配置と管理
- ディレクトリ: `apps/bot/assets/sounds/`
- 形式: .mp3 または .ogg
- リポジトリに同梱必須 (.gitignore で除外しない)
- ライセンス情報を `apps/bot/assets/sounds/LICENSE.md` に必ず記載

### 推奨取得元 (CCライセンス確認必須)
- 効果音ラボ (https://soundeffect-lab.info/)
- Pixabay (https://pixabay.com/sound-effects/)

### ファイル一覧

| ファイル名              | 用途                  | 長さ目安 | 性質              |
| ---------------------- | --------------------- | -------- | ----------------- |
| work_end.mp3           | 作業→休憩切替         | 1〜2秒    | やや高めのベル音    |
| break_end.mp3          | 休憩→作業切替         | 1〜2秒    | やや低めのチャイム音 |
| final_start.mp3        | 作業→最終休憩切替     | 1〜2秒    | 専用音            |
| countdown_warning.mp3  | 終了予告音           | 10秒     | 終わりが近いことを知らせる |
| finish.mp3             | 終了音               | 4秒      | 終了感のあるメロディ |

## 実装方針

### 初期化
- bot 起動時に @discordjs/voice の AudioPlayer を初期化
- VC参加時に connection.subscribe(player)

### 再生
- 切替/カウントダウン/終了時に player.play(createAudioResource(...))
- 多重再生は避ける (前の音が終わるまで待つか、上書き)

### 実装定数
音源を差し替える場合はこの定数を必ず更新する:
- COUNTDOWN_WARNING_DURATION_SEC = 10
- FINISH_DURATION_SEC = 4

## 依存パッケージ

- @discordjs/voice
- @discordjs/opus または opusscript (音声エンコード)
- ffmpeg-static (またはシステムffmpeg)
- libsodium-wrappers または tweetnacl (音声暗号化)

### Linux固有のセットアップ
```bash
# Ubuntu/Debian
sudo apt install libsodium-dev ffmpeg
# Arch
sudo pacman -S libsodium ffmpeg
```

## AudioPlayer クラス設計指針

```typescript
class SoundPlayer {
  private player: AudioPlayer;
  private connection: VoiceConnection | null;

  init(connection: VoiceConnection): void

  // フェーズ切替系
  async playWorkEnd(): Promise
  async playBreakEnd(): Promise
  async playFinalStart(): Promise

  // 終了演出系
  async playCountdownWarning(): Promise
  async playFinish(): Promise

  // 内部: 共通再生
  private async play(filename: string): Promise
}
```
