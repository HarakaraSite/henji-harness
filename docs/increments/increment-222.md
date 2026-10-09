# Increment 222: 表示用本文上限の暫定拡張

## 要件と範囲

利用者指示（2026-10-09）: 表示制限をまず直し、完全な修正は後回しにして、表示上限を十倍にする。
共通の表示用本文上限を2,048から20,480 UTF-8 bytesへ変更する。通常表示・保存Sessionの再表示で、
この範囲の回答、thinking、assistant noteを末尾まで読めることを確認する。

原観測は[通常利用メモS38](../experience/normal-use-inbox.md)。
Session `17c48f73-7d8d-4965-b5e9-2445cbe76c62`の第6・7ターンの最終回答は3,187／7,011 bytesで、
保存全文が完全でも、通常TUIでは第3項／比較表の途中で省略された。

現行経路はsemantic履歴→`history_adapter.ts`の`boundedText`→conversation entity→TUI。
表示用textだけの上限であり、モデルへの入力予算や保存全文の上限ではない。
同じ定数を使うtool引数・結果・進捗、task等にも十倍の上限が適用される。

## 作業と確認

1. 共通定数を20,480へ変更する。既存の大きい本文detail確認は、新上限を超える本文で同じ動作を確認する。
2. focused test、関連type check、format、lintと差分確認を行う。
3. 実Sessionのコピーを隔離XDGで読出し、production Core/TUIをtmuxで開いて、保存済み回答と
   20KB以下のthinkingの表示用本文が全文と一致し、通常TUIで回答の末尾まで読めることを確認する。
   実provider callは行わない。

重複保持・コピー・逐次取得と通常表示を整理する完全な修正はS38に残す。
20,480 bytesを超える本文の表示省略は残る。構想・architecture・roadmap、実config／実DB、
常用binaryへの配置は当初の変更範囲に含めず、後続の明示指示で実施した（下記）。

## 結果

2026-10-09にlocal実装・確認が完了。上限を共通定数一箇所で20,480へ変更した。
既存の大きいtask／tool引数のdetail確認は、新上限を超えるfixtureへ変更し、同じ全文readbackを確認した。

- focused test: conversation page／detailとhistory streamの4件が成功。
- CLI entryの関連type check、変更TS二ファイルのformat／lint、`git diff --check`が成功。
- 自己review: 通常snapshot・保存page replayが同じ定数を通り、assistant progress／note、thinking、
  tool等へ一貫して適用されることを確認した。モデル入力と保存全文は変更していない。
- 公式builderでcandidateを`.tools/increment-222/hjh`へcompileし、isolated XDGとtmuxで実行した。
  検証時点でSessionは第8ターンまで進んでいたため、第6・7ターンは過去pageとしてAPIから再読した。
  第6・7ターンの回答3,187／7,011 bytesは省略なく保存全文と一致した。
  旧上限より長く新上限以下のthinking 16件にも表示省略markerがなく、assistant note 15件が存在した。
  noteはこの観測だけでは旧上限を超える本文の実例まで確認したとは扱わない。
- 保存Sessionのコピーをcompiled production TUIで開き、第8ターンの最終回答9,371 bytesが
  通常表示で末尾まで読め、当該省略markerがないことを確認した。実provider／localhost model callとも0件。
- 隔離確認の初期準備はコピー先directory/file modeとAPI prefixを修正した。さらに最新pageにない第6・7ターンを
  過去pageから読むよう確認scriptを修正し、上記の照合を完了した。product sourceの追加変更はない。

証跡は`.tools/increment-222/verification.json`、`tui-reopened.txt`、`verify-tui.py`、`compile.log`。
候補buildは`b3ac4ac19c7cdad177a651a7181c330e98c45c72bac952fb8ed38d9d5893f119`、
build入力は`b085bcf5`＋今回のlocal source変更。
20,480 bytesを超える必要本文の省略と、完全な取得・保持・表示方式の改善はS38に残る。

## 常用配置

利用者の「配置して　配置後の確認は省略」により、2026-10-09に検証済みcandidateを
`dist/hjh`と`/home/agent/.local/bin/hjh`へatomicに配置した。
旧binaryは`.tools/increment-222-deployment/hjh.dist.previous`と`hjh.local.previous`へ退避した。
配置後の起動・表示・readback確認は利用者指示に従い省略した。配置前の確認結果は上記の通り。
既存Core/TUIは再起動せず、新しいCore/TUI起動から適用する。追加provider callは0。
配置時点では未commitだった。後続のcommit/push指示に合わせ、この変更と配置記録も対象とした。
配置操作の記録は`.tools/increment-222-deployment/deployment.json`と
[配置記録](../operations/native-0.11.0-deployment.md#increment-222の表示上限十倍化配置--2026-10-09)。
