# Increment 169 — provider failureへのrecall案内

更新日: 2026-10-03

ステータス:
**local実装・検証済み。170とともに常用配置済み。commit/pushは170とともに承認済み。完了承認は未実施。**

## 要件・経路

利用者はprovider由来と思われる一時的なfailureへの対処を当面recallとし、エラーメッセージに
軽い案内を出す方針を採用した。「認証エラーなど、別の対処が明確なものには付けない程度の
分け方」を承認している。recallの可否や復旧成功を保証する表示にはしない。

task実行 → Coreのexecution/diagnostic保存 → SessionSnapshotのexecution一覧 →
RemoteSystemNotices.merge → system行 → rendererの経路を確認した。既存の診断codeで
response_error・transport_error・provider_timeoutのfailed行に`· try /recall`を付ける。
例は`system> FAILED · provider response invalid · try /recall`。

missing_credential等の別対処が明確な診断には付けない。HTTPエラーの表示用diagnosticにはstatusが
なく認証エラーを区別できないため、http_error全体を対象外にする。HTTP分類のAPI拡張は行わない。
FAILEDだけの既存failure色を維持し、案内はneutralで表示する。snapshot再取得・TUI再接続でも
同じ保存executionから表示を導出する。

自動再試行は未採用候補[A27](../experience/normal-use-inbox.md)のままとする。raw常設保存、
recall判定用の新状態・API、構想・architecture・roadmap変更は本incrementに含めない。

## 検証計画

既存system notice testで案内対象、credential/HTTPへの非表示、再取得・再接続、neutralの案内を
確認する。focused testの型検査、format、lint、diff checkを行う。full gateは要求しない。
隔離HOME/XDGとtmuxのcompiled production Core/TUIで、localhostの模擬providerにより応答不正と HTTP
401を起こし、表示を確認する。外部providerへのrequestは0、実config・Sessionは変更しない。
証拠は`.tools/increment-169/`へ置く。

## 結果

RemoteSystemNoticesのfailed execution表示だけを変更し、対象3分類へ`try /recall`を付けた。 focused
system notice testは8件pass。実行時の型検査、format、lint、diff checkもpassした。
通常利用メモのA27は自動再試行の未採用候補として維持する。

公式henji:compileで`.tools/increment-169/henji`を作成し、隔離HOME/XDG/workspaceの140×40 tmuxで
compiled production Core/TUIを確認した。localhostの模擬providerへの2 requestにより、 HTTP
200のSSEが`[DONE]`前に終了した場合は`FAILED · provider response invalid · try /recall`、 HTTP
401の場合は`FAILED · provider request failed`となることを確認した。案内はneutral、FAILEDは
既存redで表示された。`/recall`でRECALL PREPAREDを確認し、clear後に認証エラーの確認へ進めた。 TUI
detach・新processで再接続しても、案内の有無が保存executionから復元された。
外部providerへのrequestは0、実config・Session・credential・稼働Coreは変更していない。
確認用Core・tmux・模擬providerは終了済み。

初回の確認用dummy credentialはfile modeが既存の読取条件に合わずcredential unavailableとなった。
確認用fileを0600に修正した。次の確認ではslash候補確定後の実行Enterが必要だったため、
操作scriptを修正して再確認した。これらの確認環境・操作修正によるproduction source変更はない。

証拠は`.tools/increment-169/verification.json`、incomplete/auth/reconnectのANSI captureとsnapshot、
recall-ansi.txt、recall-context.json、verify_tui.py。build IDは
`401e843546533f61d8dc9d2e477fb82d21bd1572c7c110dbb9c9bdf25ccf8906`（local source変更を含む）。
この確認時点では常用binaryはIncrement 168の配置のままだった。

## 常用配置（2026-10-03）

利用者の「常用配置して」により、169の変更を含む170の検証済みbuild `94fd1fe9…`を常用配置した。
配置と配置先Core/TUIの確認結果は[Increment 170](increment-170.md#常用配置2026-10-03)を参照する。
commit/pushは170とともに承認済み。完了承認は未実施。
