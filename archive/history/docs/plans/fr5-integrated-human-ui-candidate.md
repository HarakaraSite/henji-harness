# FR5 integrated human UI candidate

## 目的

実際のproduction TUI本体を、README、内部文書、F1 helpに先に頼らず、日常利用できる候補として
人が判断する。機械テストや旧fake fixtureを、人の判断の代わりにしない。

## 現在地

- 対象revisionは`adc0e50`。
- Gate 1ではproduction TUIで3 turn、planner一回、tool実行、終了、再開、履歴表示まで成功した。
- 旧fake fixtureによる画面確認は、入力内容と表示結果が対応せず、今後の受入には使わない。
- F1 helpは旧確認後に日本語のtask-oriented表示へ変更済みで、現行表示の分かりやすさは未評価。

## 計画

1. providerを使わない事前確認を行う。
   - 保持済みworkspace `/tmp/henji-gate1-general-agent-production-acceptance-retry-1`
   - session `61297b14-c023-4c25-8cc6-f4db61b42e4f`
   - installed `henji`とcurrent launcherの一致、sessionの存在、変更前状態だけを読む。
2. 次の一回のHuman Gateを行う。

   ```text
   cd /tmp/henji-gate1-general-agent-production-acceptance-retry-1
   henji --continue
   ```

3. まずF1を開かず、5〜10分で本体だけを確認する。
   - 起動直後に、何を入力できる画面か、現在作業中か入力待ちか、どのsession/turnかを理解できる。
   - logから過去の依頼、planner、tool、結果、finalの流れを追え、現在の結論を見つけられる。
   - 入力欄とstatus/footerから、送信、複数行入力、過去表示、履歴、終了に必要な操作を見つけられる。
   - 未送信の短いdraftを置いたまま過去表示へ移動し、戻った後もdraftが残る。
   - draftを消し、Ctrl-Tの履歴を読み、Escで作業画面へ戻れる。
   - 必要な場合だけCtrl-Gでcurrent sessionを識別し、切り替えずEscで戻る。
   - 空入力Ctrl-Dで正常終了し、terminalが戻る。
4. 本体評価の後だけF1を開く。F1は本体の合否を覆さず、迷った操作を短時間で補えるかだけを
   副次的に確認する。
5. 終了後、session/evidenceの増加や変更、lock残留がないことを読む。
6. ユーザーが`合格`、`不合格`、`判定不能`のいずれかを返す。本体が使いにくい場合、F1が
   詳しくても`合格`にしない。

## Human Gateの境界

- task送信0、context生成0、provider request 0、費用USD 0。
- credentialを読まない。workspace file、canonical session、context、provider evidenceを変更しない。
- 非空draftでEnterしない。Ctrl-Kで生成を確定しない。sessionを切り替えない。
- retry、fallback、旧fake fixture、新しいprovider taskは行わない。

## 判定後

- `合格`: FR5完了。結果とhandoffを記録する。
- `不合格`: 分からなかった表示・操作・期待との差だけを記録し、その場では修正しない。観測事実から別の最小実装計画を作る。
- `判定不能`: 原因を保持して停止し、fake fixtureやprovider実行へ切り替えない。

不合格後の候補は、観測箇所に応じて`v0/tui/render.ts`、`layout.ts`、`state.ts`、
`controller.ts`へ限定する。既存の表示情報で足りない場合だけpresentation adapter/contractを対象にする。
provider、core semantics、session schema、dependency、Pi/Zot parityは変更しない。

## 実装が必要になった場合の確認

変更した表示・操作に対応する最小のfocused test、type check、format、lint、`git diff --check`、
functional reviewだけを先に行う。安定候補になった場合だけownerが`v0:gate`を一回実行する。
