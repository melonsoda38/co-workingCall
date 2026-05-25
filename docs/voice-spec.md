# VC自動入退室仕様

## 概要
botは人間ユーザーのVC入退室に連動して自動でVCに入退室する。
これにより、タイマー開始/終了とは独立した自然な振る舞いになり、
作業会開始時の入退室音問題を回避する。

## 基本ルール

```
VCの人間ユーザー数を監視する

[人間ゼロ → 1人以上 になった瞬間]
  bot自動入室 + 入室メッセージ送信
  1分カウントダウンタイマーがあればキャンセル

[人間1人以上 → ゼロ になった瞬間]
  1分カウントダウンタイマー開始
   ├ 1分以内に人間入室 → カウントダウンキャンセル (botは残留)
   └ 1分経過 → bot退出
                ├ タイマー実行中 → 終了処理を発動してから退出
                └ タイマー停止中 → 即時退出のみ
```

## トリガー

### voiceStateUpdate イベント
discord.js の voiceStateUpdate イベントで検知する。
イベントハンドラの中で:

```
oldState: 変更前の VoiceState
newState: 変更後の VoiceState

判定処理:
1. 対象VC (config.json の voiceChannelId) に関係するイベントか?
   ├ No  → 無視
   └ Yes → 次へ

2. bot自身のイベントか?
   ├ Yes → 無視 (bot自身の入退室は対応しない)
   └ No  → 次へ

3. 該当VCの現在の人間メンバー数を再計算
   (channel.members.filter(m => !m.user.bot).size)

4. メンバー数の状態遷移を判定:
   - 0 → 1+ (人間が初めて入った)
   - 1+ → 0 (人間が全員いなくなった)
   - その他 (0 → 0 / 1+ → 1+) → 何もしない
```

## 状態遷移ごとの処理

### 人間ゼロ → 1人以上
```
1. 1分カウントダウンタイマーが起動中ならキャンセル
2. bot がまだVCに接続していなければ joinVoiceChannel()
3. AudioPlayer を初期化、connection.subscribe(player)
```

### 人間1人以上 → ゼロ
```
1. 1分カウントダウンタイマー起動
   - setTimeout で 60秒後に bot退出処理をスケジュール
2. SessionState.emptyVcTimeoutTimer に Timer 参照を保持
```

### 1分経過時 (カウントダウン満了)
```
1. タイマーの状態を確認:
   - タイマー実行中 (work/break/finalBreak/countdown)
     → ended 処理を発動 (詳細は @docs/ending-spec.md)
     → ended 完了後にbot退出
   - タイマー停止中 (idle)
     → 即時 bot退出
     → 新しい作業スタート用Embed投稿
2. bot退出:
   - voiceConnection.destroy()
   - SessionState.voiceConnection = null
   - AudioPlayer.stop() + removeAllListeners()
   - SessionState のVC関連状態をクリア
```

## 入室メッセージ

入室メッセージは送信しない (運用判断により廃止)。

bot自動入室時・退出時ともにVC内蔵テキスト欄へのメッセージ送信は行わず、静かに入退室する。
(以前は入室時に固定文言を投稿していたが、不要との判断で削除した。)

## タイマー終了処理中の特別扱い

ended フェーズの強制退出時はカウントダウンを経由しない。

通常の退出フロー (人間ゼロ → ゼロ→1分待ち → bot退出) ではなく、
ended処理の中で明示的に bot退出を行う。

```
ended処理:
  ...
  6. VC全員強制退出 (人間が全員いなくなる、人間ゼロ状態に)
     ↓ この時点で voiceStateUpdate イベントが発火
     ↓ 「1分カウントダウン開始」ロジックが動き始める
  7. bot即時退出 (カウントダウンを待たない)
     ↓ ここで emptyVcTimeoutTimer を明示的にキャンセル
  8. 新Embed投稿、idle に戻る
```

ended処理の途中でbotがVC接続を切ることで、その後の voiceStateUpdate
イベントによる重複処理を防ぐ。

## VoiceConnection の管理

### 接続時
```
import { joinVoiceChannel } from '@discordjs/voice';

const connection = joinVoiceChannel({
  channelId: voiceChannelId,
  guildId: guild.id,
  adapterCreator: guild.voiceAdapterCreator,
});
SessionState.voiceConnection = connection;
```

### 切断時
```
if (SessionState.voiceConnection) {
  SessionState.voiceConnection.destroy();
  SessionState.voiceConnection = null;
}
```

destroy() を呼ばないとリスナーが残ったりメモリリークの原因になる。

## エラーハンドリング

### bot入室失敗
- ネットワーク一時断、Discord API一時障害など
- pinoでログ記録
- リトライしない (次の voiceStateUpdate イベントで再試行)

### 入室メッセージ送信失敗
- 権限不足、チャンネル削除など
- pinoでログ記録
- bot接続自体は維持

### カウントダウンタイマーが残ったまま再接続
- voiceStateUpdate で人間1人以上を検知したら、必ず先に
  emptyVcTimeoutTimer をクリアする

## 重要な実装上の注意

- voiceStateUpdate イベントは頻繁に発火する (ミュート切替、deaf切替なども)
  必ず「channelId の変化」「人間メンバー数の変化」を判定すること
- 同じユーザーが連続して入退室を繰り返した場合、カウントダウンの
  キャンセル/再起動が連鎖する。クリーンな実装を心がける
- bot自身が voiceStateUpdate イベントを発火することがある
  (bot入室時など)。bot自身のイベントは無視する判定が必要
