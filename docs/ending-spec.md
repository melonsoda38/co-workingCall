# 終了演出仕様

## 概要
最終休憩終了時の演出は二段構成。
予告音(10秒) → タイマー終了 → 終了音(4秒余韻) → VC全員退出 → bot終了。

## タイミング設計

「設定したタイマー時間」をユーザーが設定した最終休憩時間Tとする。
ユーザーが「最終休憩15分」と設定したら T=15分。

```
T-10秒    countdown フェーズ突入、予告音 countdown_warning.mp3 再生開始
T-0秒     設定時間ちょうど = タイマー終了 = ended フェーズ突入
          finish.mp3 再生開始 + Embed削除 + お疲れさま投稿
T+4秒     finish.mp3 再生終了 = VC全員退出 + bot終了
```

ポイント:
- 設定時間ちょうどに「タイマー終了」する
- VC退出は4秒の余韻後 (finish.mp3を最後まで聞かせるため)
- ユーザーから見ると「設定通りの時間で休憩は終わり、4秒の余韻があって退出」

## 第一段階: 予告 (T-10秒)

タイマー残り10秒の時点で countdown フェーズに突入:

1. countdown_warning.mp3 再生開始 (10秒、1回のみ)
2. Embedを切替:
   - フェーズ表示: "⏰ もうすぐ終了"
   - 残り時間: 数字表示しない (固定文言 or "──")
3. デバウンスタイマーをクリア (この間は自動削除&再投稿OFF)
4. 5秒ごとのEmbed定期edit更新も停止

## 第二段階: 終了 (T-0秒、設定時間ちょうど)

予告音源が鳴り終わるのと同時にタイマー終了:

1. finish.mp3 再生開始 (4秒)
2. 既存Embed削除
3. "お疲れさまでした 👋" を通常メッセージとして投稿
   (SuppressNotifications 付けない、ちゃんと通知)
4. finish.mp3 が鳴り終わるまで待機 (約4秒、余韻)
5. VC内の全GuildMemberに対して voice.disconnect()
6. botもVCから退出 (voice connection の destroy())
7. process.exit(0)

## 強制退出の実装

```typescript
// VC内の全メンバーを切断
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

## 注意点

- ユーザーが大規模VC (10人以上) で使う場合、disconnectのレート制限に注意
  → 順次 await + 小休止を入れる
- bot自身のVC接続切断は、メンバー全員退出後に行う
- process.exit() の前にWebSocketサーバーやpinoのフラッシュも忘れない
