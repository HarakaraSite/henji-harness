---
concept: deno-self-revising-agent-harness
topic: run-typescript
date: 2026-09-27
status: validating
decision: technical-path-supported-product-adoption-undecided
environment: Deno 2.9.7 on macOS arm64
---

# Henji Harness `run_typescript`構想・統合評価

## 結論

Henji Harnessのcompile済みDeno実行ファイルは、実行時に組み立てたTypeScriptを内部のWorkerで
実行できる。外部のDeno CLIや一時`.ts` fileを必要とせず、JSON入出力、permission縮小、timeout、
size上限、structured errorをHarness側で管理する技術経路も確認できた。

この経路は、Agentが特別な理由なく`python3`で書いている小さな使い捨て処理の代替候補になる。
狙うのはJSON/CSV、文字列、集計、検証、軽量な変換などであり、Python自体の禁止や全面代替ではない。
Python固有library、既存Python資産、画像・音声・機械学習などが必要なら、Pythonを使うのが妥当である。

一方、Deno WorkerはprocessやVMに相当するresource sandboxではない。Worker内のOOMはHenji本体を
含むDeno process全体を終了させた。workspace directory permissionは既存symlink経由のroot外readを
防げず、hostname network permissionはDNS解決後IPを固定しない。したがって、同一process Workerを
敵対的code用sandbox、完全なworkspace境界、memory-safe isolationとして扱ってはならない。

現時点の判断は次のとおりである。

- 小さな`pure` code execution Toolとしての技術経路は支持する。
- 標準Toolとして保守する製品価値は未検証であり、採用は決めない。
- Python fallbackとshellは残す。
- ai-devは大規模変更中で利用者が変更を許可していないため、planning、実装、provider A/Bは保留する。

## 1. 解決したいこと

Agentは一時的な計算やデータ変換のため、shellから次のようなcodeを頻繁に実行する。

```sh
python3 - <<'PY'
import json
# 一回限りの集計や変換
PY
```

この方法自体は有効だが、Harnessから見ると次が毎回ばらつく。

- Pythonやlibraryがその環境に存在するか
- shell quotingやheredocが正しいか
- 一時fileを作るか、どこへ残るか
- codeがfilesystem、network、environment、subprocessのどこへ触れるか
- stdout/stderrをAgentがどう解釈するか
- timeout、input/output上限、error分類をどう揃えるか

`run_typescript`の目的は、Pythonと競争することではない。頻出する小さなcode executionを
Henji自身が所有し、入出力と実行条件を一定にすることである。

```text
Agent
  ↓ code + JSON input + profile request
Henji policy
  ↓ 許可・縮小・拒否
Harness-owned wrapper
  ↓ input / timeout / protocol / output / cleanup
Deno Worker または隔離backend
  ↓
structured Tool Result
```

## 2. 置き換える範囲と置き換えない範囲

### 主な対象

- JSON / JSON Lines / CSVの集計や変換
- 配列のfilter、sort、grouping、重複・欠損検査
- 文字列処理、正規表現、format変換
- 小さな計算やvalidation
- 複数Tool Resultの突き合わせ
- boundedなHTTP responseの加工
- 中間fileを必要としない一時program

### Pythonまたは既存手段を使う範囲

- pandas、NumPy、SciPyなどPython固有libraryが必要
- 画像、音声、機械学習などPython ecosystemが明確に適する
- repositoryに既存のPython moduleやtoolchainがある
- Pythonでしか提供されていないSDKを使う
- notebook的な反復分析をする
- git、rg、compiler、test runner、OS固有CLIを使う
- 長時間・大量memory・大量diskを必要とする

したがって、Tool選択は原則として次の順序になる。

```text
1. 目的に合う専用Tool
2. run_typescript                  小さな計算・変換・検査
3. shell                           git、test、CLI、OS操作
4. shellからPython等の外部runtime  固有library・既存資産が必要な場合
```

これは禁止順位ではない。後段が目的に適するなら、無理に`run_typescript`へ置き換えない。

## 3. 最小Tool案

最初に検討するのは`pure` profileだけである。Agentにはraw permissionを選ばせない。

```json
{
  "code": "export default (input) => input.values.reduce((a, b) => a + b, 0)",
  "input": { "values": [10, 20, 12] },
  "profile": "pure"
}
```

`profile`は権限の付与ではなく要求である。Henji policyが許可、より狭いprofileへの変更、拒否を
決定する。Agentから`read: true`や`net: true`のようなpermission指定は受け取らない。

実験用の最小contract候補は次である。

- codeはdefault-exportしたsync/async function
- input/outputはJSON互換
- input/outputは各64 KiB以下
- Workerは`permissions: "none"`
- read、write、net、env、run、sys、ffi、remote/local importなし
- finite wall timeout
- load、execute、permission、serialize、protocol、timeout、worker failureを分類
- 最初の有効resultだけを受理し、WorkerとBlob URLをcleanup
- raw Deno errorをそのまま返さず、Harness policy reasonとstageを返す

TypeScriptは実行時に型構文を除去して実行する。自動的なtype checkを意味しない。type checkを
追加する価値は、起動時間とAgent codeの失敗検出を比較して別に判断する。

## 4. 確認できたこと

### 4.1 動的TypeScript実行

Deno 2.9.7 / macOS arm64で、親programがruntimeに生成した型構文付きTypeScriptをBlob module
Workerとして実行し、`[10, 20, 12]`から`42`を返した。同じ親programを`deno compile`した単一
実行ファイルでも成功した。sourceを退避し、Deno CLIを含まないPATHから起動しても成功した。

この結果は、Henji executableだけを配布し、その内部でAgent生成TypeScriptを実行できることを
支持する。

### 4.2 `pure` permission・protocol・timeout

親runtimeにはread、env、loopback net、subprocess権限を実際に与えた上で、Workerを
`permissions: "none"`へ縮小した。通常実行とcompile済み実行の双方で14/14 caseが成功した。

- 親が読めるfile、envをWorkerでは拒否
- 親が接続できるnetwork、実行できるcommandをWorkerでは拒否
- normal result
- syntax errorとruntime errorの分類
- direct `postMessage`によるprotocol spoofの拒否
- non-JSON resultの拒否
- 64 KiB input/output上限
- infinite loopの約200 ms timeout
- timeout後に新しいWorkerで正常実行

permission control、bounded JSON contract、wall timeoutは同一process Workerでも実用候補になる。

### 4.3 memory failure boundary

64 MiBのV8 heap上限を設定したWorkerでmemory exhaustionを起こすと、structured Worker errorには
戻らず、Deno process全体が`SIGTRAP`で終了した。外側のsupervisor processは異常終了を観測し、
その後に別の正常probeを実行できた。

つまり、Workerはmemory failureをHenji本体から隔離しない。Henji本体の生存が要件なら、生成codeを
別processへ置き、外側から監視する必要がある。

### 4.4 macOS process resource limit

別processにしたprobeでは、現在のmacOS hostで次を確認した。

| limit | 観測 |
|---|---|
| CPU time 1秒 | `SIGXCPU`、supervisorは生存 |
| file size 1 MiB | 1,048,576 bytesで`SIGXFSZ` |
| open files 64 | 53 handles後に`EMFILE` |
| address space / data | `ulimit -v/-d`は`EINVAL`で設定不能 |
| RSS | 使用したzshに`ulimit -m`なし |

CPU time、file size、open filesは補助制約として使える。ただしCPU timeはwall timeoutではなく、
file sizeはdisk total quotaではない。macOSでmemoryとdisk totalをhard limitするには、V8 heap上限に
加えてcontainer、microVM、専用volumeなど別backendが必要になる。

### 4.5 workspace boundary

Workerへ`read: [workspace]`を与えた場合、`..`とabsolute pathによるroot外readは拒否された。
しかしworkspace内に置いたfile symlinkとdirectory symlinkから、root外の内容を取得できた。

Denoのpermissionは既存symlink経由のread/writeについてtargetではなくsymlinkの配置pathを基準に
判定する。したがって、通常のmutable workspaceへdirectory permissionを与えるだけではfilesystem
tree boundaryにならない。

実装候補は次のいずれかである。

- symlinkを含まず実行中に不変なsnapshot
- Workerを無権限のままにし、Henjiのtrusted read brokerが検査済み内容だけを返す
- 別processへ限定されたOS filesystem viewを与える
- container/microVMのmount boundaryを使う

実行前の`realPath`確認だけでは、mutable workspaceでのTOCTOUを完全には解消しない。

### 4.6 network boundary

Workerへ一つのhost・portだけを許可したnetwork spikeでは、通常実行とcompile済み実行の双方で
主matrix 7/7、DNS補助matrix 2/2が成功した。

- 許可host・portへのrequestは成功
- 同一IPの別portを拒否
- `127.0.0.1`を許可した場合の`localhost`要求を拒否
- redirect先が非許可port/hostnameなら拒否
- `127.1`や整数IPv4表記はURL parserがcanonical IPへ正規化
- `localhost` permissionは名前解決先へ接続できるが、同じ先のliteral IPは別hostとして拒否

host・port allowlistとredirectごとの再検査は利用できる。一方、hostname permissionはDNS解決後IPを
固定せず、private address除外やDNS rebinding対策を提供しない。IP-level policyが必要ならtrusted
HTTP broker、名前解決とaddress pinning、OS egress policyを使う。

filesystem readとnetworkを同時に与えるprofileは、読み取った情報を外部送信できるcapabilityである。
個別permissionの単純和として自動許可しない。

### 4.7 cross-target

Deno 2.9.7が公式対応する6 targetについて、同じdynamic TypeScript Worker probeのartifactを
macOS arm64から生成できた。

| target | 確認状態 |
|---|---|
| macOS ARM64 | native実行で`42`を確認 |
| macOS x86_64 | Rosetta実行で`42`を確認 |
| Linux x86_64 / ARM64 | ELF artifact生成のみ |
| Windows x86_64 / ARM64 | PE32+ artifact生成のみ |

cross-compile成功はtarget OS上のruntime成功を意味しない。Linux・Windowsをsupportedと表示するには、
各実機でdynamic Worker、permission、timeout、OOM時のprocess boundaryを再確認する必要がある。

## 5. 検証結果が否定した考え

| 考え | 結果 |
|---|---|
| Worker permissionとtimeoutがあれば完全なsandboxになる | OOMがDeno process全体を終了させるため否定 |
| `read: [workspace]`でworkspace treeへ閉じ込められる | 既存symlinkからroot外を読めるため否定 |
| hostname allowlistで接続先IPまで固定できる | DNS解決後addressを固定しないため否定 |
| cross-compileできればそのplatformをsupportedと呼べる | target実機runがないため否定 |
| Pythonを原則禁止すればよい | 固有library・既存資産にはPythonが妥当なため不採用 |
| 技術的に動けば標準Toolとして採用できる | Agent利用価値と保守負担が未検証のため不採用 |

失敗した境界は構想を無効にするものではない。`pure`な小処理、別process、broker、OS/VM backendを
同じ強度のものとして扱わず、用途ごとに分ける根拠になる。

## 6. 現時点で妥当な構成

### Level 1: bounded `pure` Worker

用途は小さな計算、変換、検査に限る。

- same-process Worker
- `permissions: "none"`
- JSON input/output上限
- finite wall timeout
- structured error
- controlled taskでmemory exhaustionをthreat modelへ含めない

起動が軽く、最初の価値検証に適する。ただしHenji本体のmemory-safe isolationではない。

### Level 2: supervised process

Henji本体の生存が必要な場合に使う。

- generated codeを別processで実行
- V8 heap上限
- supervisor wall timeout
- macOSで利用できるCPU time、file size、open-files limit
- abnormal exit後の新規process回復

memory OOMのfailure unitをHenji本体から分離できるが、native memoryやdisk totalの完全な制限には
ならない。

### Level 3: OS / container / microVM backend

敵対的code、hard memory/disk limit、強いfilesystem/network boundaryが必要な場合に使う。

- mount/filesystem view
- memory/CPU/disk quota
- egress policy
- process treeとartifact回収
- backend失敗時のrecovery

このLevelは最初の`pure` Tool価値検証には必須ではない。必要なthreat modelが現れた時点で分ける。

## 7. 代替案との比較

| 選択肢 | 利点 | 不足・負担 | 現在の扱い |
|---|---|---|---|
| 現状のshell + Python | すでにAgentが使え、ecosystemが広い | permission・入出力・runtime・artifactが毎回ばらつく | fallbackとして維持 |
| 専用Toolを増やす | contractが最も明確で安全 | 用途ごとに実装・保守が必要 | 目的に合えば第一選択 |
| same-process `run_typescript` | Henji内で完結し、小処理を統一できる | OOMからHenjiを守れない | `pure`価値検証候補 |
| supervised process | Henji本体の生存とlimit観測 | 起動・実装・配布が複雑化 | 必要時の強化候補 |
| container / microVM | 強いresource/filesystem/network境界 | 運用負荷が大きい | 強いthreat model用 |
| 何もしない | 実装・保守費用ゼロ | 使い捨てcodeのばらつきは残る | A/Bで十分なら採用しない |

## 8. 未検証事項

最も重要な未検証事項は、Agentにとっての実用価値である。

- `run_typescript`が存在するとAgentは自然に選ぶか
- shell/Pythonよりcorrectness、tool call数、修正回数が悪化しないか
- shell quotingや一時fileを実際に減らすか
- structured resultが後続reasoningに役立つか
- Tool追加の実装・保守負担に見合うか

このため、固定pure-data task、oracle、current shellとのA/B、観測項目を
[Agent value check planner input](../planner-inputs/run-typescript-agent-value-check.md)へ用意した。

ただしai-devは大規模変更中であり、利用者は現在の変更・配送・provider callを許可していない。
planner inputは保留資料であって実行authorityではない。再開時は古いinputをそのまま配送せず、
ai-devのcurrent architecture、Tool registry、compile/runtime、instructionsを読み直して改訂する。

その他の未検証事項は次である。

- Linux・Windows実機でのruntime behavior
- current ai-dev architectureへの統合方法
- TypeScript type checkを加える費用対効果
- process backendのdistributionとstartup overhead
- macOSでnative/external memoryとdisk totalをhard limitするbackend
- workspace brokerのTOCTOU-resistantな実装
- DNS pinningまたはegress policyが必要になる実利用task

## 9. 現在の判断

| 判断対象 | 現在の判断 |
|---|---|
| compile済みHenji内部でdynamic TypeScriptを実行できるか | できる |
| 小さな使い捨てPython codeの一部を代替できるか | 技術的には可能性が高い |
| Pythonを禁止・全面代替するか | しない |
| `pure` Tool候補を維持するか | 維持する |
| Deno Workerを強いsandboxとして扱うか | 扱わない |
| 標準Toolとして採用するか | Agent A/B前なので未判断 |
| ai-devへ今すぐ実装するか | 大規模変更中のため保留 |

構想の状態は`validating`のままとする。技術成立性は十分に支持されたが、製品採用を決める最後の
根拠であるAgent利用価値が未観測だからである。

## 10. 再開条件

ai-devが安定し、利用者が明示的に再開を許可した場合だけ次へ進む。

1. current ai-devのTool registry、agent loop、compile/runtime、instructions、working treeを確認する。
2. 保留中のAgent value check inputがcurrent architectureと整合するか見直す。
3. 最小`pure` experimental Toolとoffline evidenceの計画だけを作る。
4. planning、implementation、provider A/Bを別々に承認する。
5. A/Bで利用価値が小さければ、技術経路が成立していても標準Toolへ採用しない。

## 11. 証拠

- [原案](2026-09-22-run-typescript-concept-draft.md)
- [技術検証の展開過程](2026-09-22-run-typescript-concept.md)
- [compile済みDeno内のdynamic TypeScript](../spikes/2026-09-22-compiled-dynamic-typescript-worker.md)
- [`pure` permission・timeout・protocol](../spikes/2026-09-22-pure-profile-permission-timeout-protocol.md)
- [Worker OOMとprocess survival](../spikes/2026-09-22-worker-memory-process-survival.md)
- [workspace symlink boundary](../spikes/2026-09-22-workspace-read-symlink-boundary.md)
- [network allowlist boundary](../spikes/2026-09-22-network-allowlist-boundary.md)
- [macOS process resource limits](../spikes/2026-09-22-macos-process-resource-limits.md)
- [Deno cross-target compile](../spikes/2026-09-22-deno-cross-target-compile.md)
- [保留中のAgent value check](../planner-inputs/run-typescript-agent-value-check.md)

公式仕様:

- [Deno compile](https://docs.deno.com/runtime/reference/cli/compile/)
- [Deno permissions](https://docs.deno.com/runtime/reference/permissions/)
- [Deno unstable Worker options](https://docs.deno.com/runtime/reference/cli/unstable_flags/#--unstable-worker-options)
