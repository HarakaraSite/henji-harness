# Increment 219: Coreの5分周期nativeメモリ返却

状態: local実装・隔離測定・照合済み（2026-10-09）。利用者指示で実装・test・測定記録をcommit済み。
利用者の完了判断、常用配置、pushは未実施。

## 要件と範囲

利用者の「暫定5分でメモリ解放の仕組みを加えて」に基づく。
1ターンが長時間続く場合も、Coreが5分ごとにallocator内の解放済みページをOSへ返す。
現在ターン、context、Worker、履歴は保持し、Session切替やターン終了で周期をリセットしない。
Core終了時にtimerとnative libraryを閉じる。

根拠は218第11.19〜11.20節。待機中と実行中に`malloc_trim(0)`のページ返却を確認した。
間隔5分は利用者が選んだ暫定値であり、最適値ではない。 測定済みのLinux
x86_64/glibc環境を対象にする。他platformのnative返却は今回対象外で、 既存の通常実行経路を維持する。

## 実経路と実装計画

通常CLI/TUI/runからのCore起動は`core_discovery.spawnCore`→`serve_cli.main`→ CoreService/Data/HTTP
server→Session/Agent Worker。Core processの起動/終了はserve CLIが所有する。 周期処理はserve
CLIから一つだけ起動し、同じ終了経路のfinallyで解放する。
ApplicationService/Agent/各Sessionにtimerを増やさない。

native runtime helperは300,000msのunref timerからglibcの`malloc_trim(0)`を呼ぶ。
compileに必要なlibc限定FFI許可を追加する。既存source起動は`-A`を使用している。
診断ログ/測定履歴は通常実装へ追加しない。強制V8 GC、Worker再起動、頻度自動調整は対象外。

## 検証と計測

- 周期と終了時cleanupをfocused testで確認し、変更箇所のtype/format/lint、diff checkを実施する。
- 利用者が選んだ「約6分×2ターン＋短い確認会話」を一回実行する。compiled production Core/TUI、
  隔離XDG/SQLite、localhost provider、同じSession/Agent Workerを継続する。実providerは0。
- 長いターンは各200回の小さいfile read→OK。各responseに約1.8秒待機を入れ、6分程度にする。
  現在ターンを既存context予算内で保持し、必要な状態を捨てない。前回200ターンの大量負荷によるwarmupは行わない。
- productionの5分周期を変更せず、二回ともターン実行中に発火したこと、全tool引数/結果/final、
  全requestのwire/context/予算、同じWorkerでの次の会話、正常終了を照合する。
- Core/TUI RSS/PSSと各context heap、実行中最大、最後30秒待機後を記録する。 Core processのuser/system
  CPU時間とminor/major page fault、trim単独のCore thread CPU時間も採る。
  同じ時間の対照runは追加せず、全体CPU増分をtrim単独へ帰属しない。
- 開始前の有効空きから従来と同じCore＋TUI RSS停止上限を記録する。

構想/architecture/roadmapの変更、実DB/config操作、常用配置、commit/pushは含めない。
必要なarchitecture/roadmapへの反映案は結果と分けて本書へ記載し、別途承認を得てから反映する。

## 結果

詳細は[5分周期trim測定報告書](../research/increment-219-five-minute-memory-2026-10-09.md)。 証跡は
`.tools/increment-219-five-minute-memory-20261009/`。

### 実装と確認

`v0/agent/runtime/native_memory_trim.ts`を追加し、`serve_cli.main`のCore起動後に一つだけ開始、
finallyで停止する。300,000msのunref timerがglibcの解放済みページを返す。
`scripts/build_henji.ts`にlibc限定FFI許可を追加した。AgentのTypeScript実行にFFI権限は追加していない。
通常実装に計測機構は置かず、診断コピーで実際の同じtimer呼出しを観測した。

周期・unref・終了時cleanupと既存Core起動/終了経路のfocused test 4/4、 既存build provenance test
2/2、変更箇所のtype/format/lint、diff checkが通った。 通常production
binaryと診断binaryのcompileも成功した。full gateは実施していない。

### 一回の測定結果

同じSession/Agent Workerを保ち、長い2ターン（368.081秒、371.961秒）と短い確認会話を完了した。
全3ターン/404 localhost request、canonical 808messageのtool引数/結果/final OK、
全requestのwire/context/予算を照合した。実provider 0、強制GCなし。 通常candidate
284file、診断16fileは測定前後でhash不変。正常shutdown exit 0。

| Core timer起動から | 実行状態        | RSS直前→直後 MiB | 返却 MiB | 呼出し経過 ms | Core thread CPU増分 ms |
| ------------------ | --------------- | ---------------- | -------- | ------------- | ---------------------- |
| 300.003秒          | 1ターン目の途中 | 198.76 → 197.45  | 1.32     | 0.333         | 0（変化未検出）        |
| 600.004秒          | 2ターン目の途中 | 259.06 → 223.16  | 35.90    | 5.712         | 3.115（system）        |

CPUカウンタ差0は負担ゼロを示さない。直接CPU区間はCore threadの呼出し前後のみで、
他threadや後続ページ再確保の負担を含まない。使用中native
byteはほぼ変わらず、live状態を維持している。

| 時点                    | Core RSS/PSS MiB |
| ----------------------- | ---------------- |
| Core起動後・Session前   | 87.40 / 81.25    |
| Session開始後・TUI前    | 89.66 / 83.40    |
| TUI接続後・最初の会話前 | 90.02 / 66.34    |
| 1ターン完了             | 248.86 / 220.03  |
| 2ターン完了             | 257.21 / 228.35  |
| 短い確認会話＋30秒待機  | 260.18 / 231.32  |

TUI接続による共有ページのPSS配分変化はCore内のlive状態削減とは扱わない。 全体のCore
RSS/PSS観測最大は262.88/234.02 MiB、TUIは93.71/70.10 MiB。 開始前有効空き13,557.48
MiB、停止上限Core＋TUI RSS 6,656 MiB、合算最大356.25 MiBで未到達。
各contextのheapと境界観測最大、各ターンCPU/page faultは報告書に記録した。
モデル送信messages最大87,513 byteで5 MiB上限には達していない。

設定provider待機は各361.8秒、これを除く処理経過は6.281秒と10.161秒。 Core
process全threadのuser/system CPUは各9.80/2.83秒、12.56/2.79秒。
観測や通常処理を含むため全体値をtrimの負担へ帰属しない。

5分周期の発火と実行継続、少量/多量の空きページ返却を確認した。
返却後も後続処理でRSSは再び増え、最後30秒では2ターン終了時より高い。
一定量の返却やメモリ増加の停止を保証する方式とは扱わない。
対照runは追加せず、5分を最適間隔とは判断していない。
人工的なprovider待機主体の負荷であり、CPU連続占有、複数Session、10時間耐久は未確認。

## Product正本への反映案（別途承認待ち）

- architecture: Coreのserve起動/終了経路が単一のunref timerとnative libraryを所有すること、 Linux
  x86_64/glibcのprocess全体の解放済みページを暫定5分周期で返すことを追記する。
  Session/Agentのlive状態やturn境界に依存せず、Worker再起動とは別の責務である。
- roadmap: 上記実装と単一Session/Workerでの長い2ターン測定済みを記録する。
  最適間隔、CPU連続占有・複数Session・長時間耐久、他platformは確認済み範囲へ含めない。

構想に意味上の変更はない。architecture/roadmap本体は変更していない。
