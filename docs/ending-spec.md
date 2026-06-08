# 終了演出仕様

## 概要
最終休憩終了時の演出は二段構成。
予告音(10秒) → タイマー終了 → 終了音(3秒余韻、音源は4秒) → VC全員強制退出 →
新Embed投稿 → 待機状態 (idle) に戻る。

botプロセスは終了しない (常駐維持)。

## タイミング設計

「設定したタイマー時間」(最終休憩T分) を基準点とする。

```
T-10秒    countdownフェーズ突入
          countdown_warning.mp3 再生開始 (10秒)
          Embedを "⏰ もうすぐ終了" に切替

T-0秒     設定時間ちょうど = ended フェーズ突入
          finish.mp3 再生開始 (音源は4秒、3秒で disconnect するため最後まで聞こえない)
          Embed削除 → お疲れさま投稿

T+3秒     VC全員強制退出
          bot即時退出 (カウントダウン経由しない・finish.mp3 はここで途切れる)
          新しい作業スタート用Embed投稿
          idle に戻る
```

### ポイント
- 設定時間ちょうどに「タイマー終了」する
- VC退出は3秒の余韻後 (finish.mp3 の音源は4秒だが運用判断で3秒に短縮、最後の1秒は切れる)
- ユーザー視点: 設定通りの時間で休憩は終わり、3秒余韻、退出

## 第一段階: 予告 (T-10秒)

タイマー残り10秒の時点で countdown フェーズに突入:

```
1. countdown_warning.mp3 再生開始 (10秒、1回のみ)
2. 「ご参加ありがとう」投稿を削除 (終了予告音の再生直後)
3. Embedを切替 (内容のみedit、メッセージ削除しない):
   - 円形画像の中央を "まもなく / 終了" (2行) に
4. デバウンスタイマーをクリア (この間は自動削除&再投稿OFF)
5. 5秒ごとのEmbed定期edit更新も停止
```

## 第二段階: 終了 (T-0秒、設定時間ちょうど)

予告音源が鳴り終わるのと同時にタイマー終了:

```
1. finish.mp3 再生開始 (音源は 4 秒、disconnect で途中で切れる)
2. 既存Embed削除
3. "お疲れさまでした 👋" を通常メッセージとして投稿
   (SuppressNotifications 付けない、ちゃんと通知音を鳴らす)
   投稿の messageId を保持し、投稿から 15 秒後の「フォローアップ」を setTimeout で予約する
   (FAREWELL_DELETE_DELAY_MS = 15_000)。フォローアップ = お疲れさま削除 → 新スタート
   Embed 投稿。予約は終了演出フローをブロックしない。
4. 余韻待機 (3秒、ENDING_DELAY_MS = 3_000)
5. VC内の全GuildMemberに対して voice.disconnect()
6. bot即時退出 (カウントダウン経由しない)
   - voiceConnection.destroy()
   - emptyVcTimeoutTimer をキャンセル
7. 歓迎投稿 (welcomeMessageId・「ご参加ありがとうございます〜」) の削除
   - countdown 突入時 (終了予告音の再生直後) に削除する設計。ここでは countdown を
     経ず onEnded へ来る経路 (空 VC 早期退出) の保険として再度削除を試みる (済みなら no-op)
8. SessionState をリセット (timer.reset / currentPhase=idle)。idle へ復帰
   - 新スタート用Embedはここでは投稿しない (step 3 のフォローアップで投稿する)
--- ここから 15 秒後 (フォローアップ) ---
9. お疲れさま投稿を削除 (best-effort)
10. その直後に新しい作業スタート用Embedを投稿 (SuppressNotifications)
    - 15秒の間に新セッションが始まっていたら (currentPhase!=='idle') スタート投稿はスキップ
```

お疲れさまを 15 秒見せてから新スタート Embed に切り替える。新セッション開始 (onTimerStart)
や `/pomo stop` (onIdle) が 15 秒以内に起きた場合はフォローアップ予約を解除し、各処理側で
お疲れさまの本文掃除・スタート Embed 投稿を行う。

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

VC自動退室仕様 (@docs/voice-spec.md) の「30秒経過」によるトリガーで、
タイマー実行中だった場合の処理:

```
30秒カウントダウン満了 (人間ゼロが30秒継続)
   ↓
タイマー実行中なら通常の終了演出を発動:
   - finish.mp3 再生
   - Embed削除
   - "お疲れさまでした 👋" 投稿
     (聞く人はいないが、ログとしては残る)
   - 3秒待機
   - VC全員強制退出 (もう誰もいないが念のため実行)
   - bot即時退出
   - 新Embed投稿
   - idle に戻る
```

実装上は、通常の ended 処理と同じ関数を呼べばよい。

## 「続行」による継続 (US-続行)

最終休憩中に「続行」ボタンを押すと、最終休憩終了時に終了演出をせず**継続ループ**へ移行する。

### タイミングと分岐

```
[finalBreak] 最終休憩中 → Embed の上に太字「続ける場合:」(画像の外) + Embed 下に「続行」ボタン
   ├ 続行を押す → EmbedManager.registerContinueUser でユーザ ID を記録し #continuing=true
   ↓
[countdown] (最終休憩 残り10秒)
   ├ #continuing=true なら countdown 演出を抑制 (終了予告音なし・「まもなく終了」に切替えない)
   │  → 最終休憩 Embed と続行ボタンを残り10秒も維持し、追加の続行押下を受け付ける
   └ #continuing=false なら通常どおり countdown 演出
   ↓
[ended] 最終休憩終了
   ├ #continuing=true かつ未移行 → #enterContinue (継続移行):
   │   1. 続行を押していない人間のみ強制退出 (押した人は残す = kickHumansExcept)
   │   2. finish.mp3 / お疲れさま / bot退出 / 新スタート Embed は**やらない**
   │   3. 開始時の作業/休憩秒で継続タイマー開始 (timer.startContinuous)
   │      → 「作業→休憩→…」を無限ループ (countdown/ended は発火しない)
   │      → 移行音は鳴らない (finalBreak→work の遷移音は定義上 null)
   └ それ以外 → 通常の終了演出 (§第二段階)
```

### 継続ループの終了

継続ループはセット数では終わらない。終了するのは次の 2 経路のみ:

1. **VC が 0 人**: 既存の「空 VC 30 秒」→終了演出フロー (triggerEndingFlow) で実終了する。
   継続移行済み (#continuousActive=true) のため、ended 分岐は通常の終了演出を実行する。
2. **23時間キャップ**: セッション開始 (timer 開始) から 23 時間後に強制終了する
   (CONTINUE_MAX_SESSION_MS)。続行でタイマーが翌日まで続き新セッションを開始できなく
   なるのを防ぐ安全装置。発火時は通常の終了演出に加え、お疲れさまの代わりに
   「次の作業通話のため、23時間でタイマーを自動終了しました。…」(TIMEOUT_CONTENT) を投稿する。

### 表示

- 継続ループ中の Timer 画像は、セット数 (例 2/4) の代わりに「累計の実施セット数」
  (元セッションのセット数 baseSets + 継続サイクル数) を「N回目」で表示する
  (例: 元 4 セット → 継続初回は「作業中 5回目」)。TimerSnapshot.continuous=true の経路で、
  currentSet = baseSets + cycle。
- 23時間キャップ用の固定 23時間は、本番運用では十分長く、通常セッションでは到達しない。

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

- finish.mp3 の再生は非同期、3秒待機は setTimeout で明示的に (ENDING_DELAY_MS)
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
   ├ "お疲れさまでした" 投稿 (通常通知) ※ messageId 保持・投稿15秒後のフォローアップを予約
   ├ 3秒待機 (ENDING_DELAY_MS)
   ├ VC全員強制退出
   ├ bot即時退出
   ├ "ご参加ありがとう" 削除 (countdown 時に削除済み・保険で再削除)
   └ SessionState リセット → idle 復帰 (スタート Embed はまだ出さない)
   ↓ 投稿15秒後 (フォローアップ)
   ├ "お疲れさまでした" 削除
   └ 新スタート用Embed投稿 (お疲れさま削除後に出す)
   ↓
[idle] 待機状態に戻る
```
