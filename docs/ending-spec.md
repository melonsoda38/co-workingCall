# 終了演出仕様

## 概要
最終休憩終了時の演出は二段構成。
予告音(10秒) → タイマー終了 → 終了音(4秒余韻) → VC全員強制退出 →
新Embed投稿 → 待機状態 (idle) に戻る。

botプロセスは終了しない (常駐維持)。

## タイミング設計

「設定したタイマー時間」(最終休憩T分) を基準点とする。

```
T-10秒    countdownフェーズ突入
          countdown_warning.mp3 再生開始 (10秒)
          Embedを "⏰ もうすぐ終了" に切替

T-0秒     設定時間ちょうど = ended フェーズ突入
          finish.mp3 再生開始 (4秒)
          Embed削除 → お疲れさま投稿

T+4秒     finish.mp3 再生終了
          VC全員強制退出
          bot即時退出 (カウントダウン経由しない)
          新しい作業スタート用Embed投稿
          idle に戻る
```

### ポイント
- 設定時間ちょうどに「タイマー終了」する
- VC退出は4秒の余韻後 (finish.mp3を最後まで聞かせる)
- ユーザー視点: 設定通りの時間で休憩は終わり、4秒余韻、退出

## 第一段階: 予告 (T-10秒)

タイマー残り10秒の時点で countdown フェーズに突入:

```
1. countdown_warning.mp3 再生開始 (10秒、1回のみ)
2. Embedを切替 (内容のみedit、メッセージ削除しない):
   - フェーズ表示: "⏰ もうすぐ終了"
   - 残り時間: "──" 等の固定文言
3. デバウンスタイマーをクリア (この間は自動削除&再投稿OFF)
4. 5秒ごとのEmbed定期edit更新も停止
```

## 第二段階: 終了 (T-0秒、設定時間ちょうど)

予告音源が鳴り終わるのと同時にタイマー終了:

```
1. finish.mp3 再生開始 (4秒)
2. 既存Embed削除
3. "お疲れさまでした 👋" を通常メッセージとして投稿
   (SuppressNotifications 付けない、ちゃんと通知音を鳴らす)
4. finish.mp3 が鳴り終わるまで待機 (約4秒、余韻)
5. VC内の全GuildMemberに対して voice.disconnect()
6. bot即時退出 (カウントダウン経由しない)
   - voiceConnection.destroy()
   - emptyVcTimeoutTimer をキャンセル
7. SessionState をリセット (詳細は後述)
8. 新しい作業スタート用Embedを投稿 (SuppressNotifications)
9. idle に戻る (process.exit しない)
```

## 強制退出の実装

```
const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
if (channel?.isVoiceBased()) {
  for (const [, member] of channel.members) {
    if (!member.user.bot) {
      try {
        await member.voice.disconnect();
      } catch (e) {
        logger.warn({ err: e, userId: member.id }, '退出失敗');
      }
    }
  }
}
```

人間メンバーを順次切断。bot自身は最後に明示的に切断する。

## VC内ユーザーゼロ起因の終了 (タイマー実行中)

VC自動退室仕様 (@docs/voice-spec.md) の「1分経過」によるトリガーで、
タイマー実行中だった場合の処理:

```
1分カウントダウン満了 (人間ゼロが1分継続)
   ↓
タイマー実行中なら通常の終了演出を発動:
   - finish.mp3 再生
   - Embed削除
   - "お疲れさまでした 👋" 投稿
     (聞く人はいないが、ログとしては残る)
   - 4秒待機
   - VC全員強制退出 (もう誰もいないが念のため実行)
   - bot即時退出
   - 新Embed投稿
   - idle に戻る
```

実装上は、通常の ended 処理と同じ関数を呼べばよい。

## SessionState のリセット項目

ended処理の最後で以下をクリア:

### タイマー関連
- timer (TimerSnapshot)
- currentTimerEmbedMessageId
- timerInterval (5秒ごと更新の interval)

### デバウンス関連
- isReposting フラグ → false
- debounceTimer → clearTimeout してnull
- maxWaitTimer → clearTimeout してnull
- firstTriggerAt → null

### VC関連
- voiceConnection → destroy()してnull
- emptyVcTimeoutTimer → clearTimeout してnull

### 音源関連
- AudioPlayer.stop()
- AudioPlayer.removeAllListeners()
- 再生中のAudioResourceは自然にガベージコレクション

### エラー関連
- lastError → null
- errorCount → 0
- failedAudioFiles → クリア (Set)

### 保持するもの (リセットしない)
- BotConfig.default の設定値 (config.json)
- guildId, voiceChannelId
- adminRoleName
- 過去のEmbed投稿履歴 (Discord側に残る)

## 実装上の注意

- finish.mp3 の再生は非同期、4秒待機は setTimeout で明示的に
- 待機中に何らかのエラーが起きても、最終的に必ず idle に戻すこと
- 強制退出は順次 await + 必要なら小休止 (大規模VCでのレート制限対策)
- process.exit() を絶対に呼ばない
- ended処理が二重に発動しないよう、isEnding フラグで重複防止

## 終了フローの全体図

```
[finalBreak] 残り10秒検知
   ↓
[countdown] 突入
   ├ countdown_warning.mp3 再生開始
   ├ Embed切替 ("もうすぐ終了")
   └ デバウンス停止、定期edit停止
   ↓ 10秒経過
[ended] 突入
   ├ finish.mp3 再生開始
   ├ Embed削除
   ├ "お疲れさまでした" 投稿 (通常通知)
   ├ 4秒待機
   ├ VC全員強制退出
   ├ bot即時退出
   ├ SessionState リセット
   └ 新スタート用Embed投稿
   ↓
[idle] 待機状態に戻る
```
