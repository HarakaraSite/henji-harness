# Increment 200 — 専用toolをbashより優先し、出力の扱いを指定する案内

状態: local実装・非破壊的検証まで完了（2026-10-06）。commit/push、公式build、常用配置、
実provider callは未実施。変更はinstruction文言のみで、toolの入出力・保存data・設定・TUI表示を変えない。

## 利用者が必要とする動作と根拠

利用者指示（2026-10-06）:「agentがtool> bashを使いがちだから　read,write,edit,search,run_typescriptを
優先して欲しいんだけどな」。同じ会話で、安易なパイプ連結を望まないこと、集計はfile経由で行うこと、
打ち切られた末尾は`bash_output`で読めることを確認し、「Increment
200と合わせて、インストラクションの見直しをしようか」を受けて、
tool選択（第1段）に加えて出力の扱い（第2段）も同じ`promptGuidelines`へ入れた。

通常利用のTUIで`tool> bash`が目立つという観測を受け、Agentがfile閲覧・file変更・workspace検索・
data集計を行う際に、汎用のbashより専用toolを選ぶよう案内を強める。
専用toolの実行能力・contract、bashの実行能力、Agent JSONのtool選択は変更しない。

根拠はこの会話での利用者指示と、保存Sessionのread-only分析（`0cd5c22e`: bash
81%・pipe 81件中head 68・`bash_output` readback 0件、`2bc2699f`:
`> log 2>&1; tail; exit "$result"` 39件で非0 exitも伝播）である。
[Increment 4](../history/increments/increment-4.md)が導入した`promptGuidelines`の集約経路、
[Increment 162](increment-162.md)のguideline文言変更の前例も参照する。

## 現行経路と変更境界

各Toolの`promptGuidelines`（`v0/agent/tools/tools.ts`）→ `Registry.promptGuidelines()` →
`resolveCommonInstructionComposition`（`v0/agent/instructions/compose.ts`）→ `WorkerAgentComposition`の
`systemInstruction`の`## Active tool guidelines` → provider request。
`v0/agent/worker_agent_api.ts`が有効なtoolだけから集約し、`v0/agent/instructions/worker_core_finalizer.ts`が
base instructionと結合する。今回の変更はこの既存の宣言箇所だけに置く。

変更前の案内は、readが`cat`/`sed`よりreadを優先、run_typescriptが集計をrun_typescriptで実行、
bashはshell状態の説明のみ、write/edit/searchは案内なしだった。

## 採用範囲

| 対象 | 変更後 |
| --- | --- |
| bash（`v0/agent/tools/bash_tool.ts`） | 既存のshell状態案内に加え、read/write/edit/search/run_typescriptを優先し、bashはbuild・test・git・process制御などのshell commandに使う案内を追加。さらに、要約目的の安易なpipeを避けて出力をfile化し`run_typescript`へ渡す案内、pipeが目的の場合は`set -o pipefail`を使う案内を追加 |
| bash_output（`v0/agent/tools/bash_output.ts`） | 打ち切られた末尾は`savedStreams.totalBytes`近傍（UTF-8境界）のoffsetで読む案内を追加 |
| read（`v0/agent/tools/file_tools.ts`） | 既存の優先案内を`cat`・`sed`・`head`・`tail`へ広げ、offset/limitで必要なwindowを読む形へ文言更新 |
| write（`v0/agent/tools/file_tools.ts`） | bashのredirection・heredocよりwriteを優先する案内を追加 |
| edit（`v0/agent/tools/file_tools.ts`） | bashのsed・awk・perlよりeditを優先する案内を追加 |
| run_typescript（`v0/agent/tools/run_typescript.ts`） | 既存の集計案内を「bashではなくrun_typescriptで実行」へ明確化し、他commandの出力はfile経由で読む案内を追加 |
| search（`external-tools/search/index.ts`） | bashのfind・grep・rgよりsearchを優先する案内を追加 |
| web_search（`external-tools/web_search/main.ts`） | `contents`を意図して指定する案内を追加（highlights推奨、`text`は`maxCharacters`で上限、長文は`web_fetch`の`save_to`） |

変更しないもの: toolのname・description・input schema・実行処理、`Registry`の集約・並び順、
instruction componentの構成、保存data、TUI表示、bundled defaultとgenericのAgent JSON。
新しい状態・設定・保存先は増やさない。

配置への影響: bash・bash_output・read・write・edit・run_typescriptはbinaryへ埋め込まれるため反映には
再build・再配置が要る。search・web_searchは外部tool
folderであり、常用環境（`/home/agent/.config/henji-harness/tools/search`等）のcopyは現行sourceと同一だが、
反映にはfolderの更新（`--replace-tools`等の既存配置経路）が要る。
reviewerのAgent
JSONはconfig rootのfileであり、repoの`agents/reviewer.json`を常用環境へ反映すれば新しいWorker起動から
有効になる（binary再buildは不要）。2026-10-06に常用環境
`/home/agent/.config/henji-harness/agents/reviewer.json`へ反映し、`henji agent inspect --name reviewer`で
revision 2・tools `read`・`search`（external、rejectionsなし）・`skill`を確認した。
直前の配置は`.tools/increment-200/reviewer.json.prev`に保存した（sha256
`67d9209c…`、反映後は`545f2fd3…`）。binary側（guideline文言）と外部tool folderの更新は未実施。

## reviewer用Agentのtool構成とinstruction（A32の採用）

利用者指示（2026-10-06）:「reviewerにはbashを与えないようにしたい」。通常利用メモA32の観測
（review子6実行でbashはrg/grep 15・ls 4・find 3・wc 3・git 1に集中し、runner死亡時は同一`ls`を125回
再試行して128 step limitで停止）を受け、reviewのinspectionからshell依存を外す。

| 対象 | 変更後 |
| --- | --- |
| `agents/reviewer.json`（revision 2） | `tools`を`bash`・`bash_output`を除いた`read`・`search`・`skill`へ変更 |
| 同instruction | 「Use read and search to inspect the workspace: no shell is available, so verify from the workspace files and say when something could only be checked by running a command.」を含む文言へ変更（「Do not edit the workspace.」は維持） |

意図と帰結: reviewはworkspace fileの閲覧と検索で行い、コマンド実行を伴わない。
`git diff`等の出力が必要なreviewでは、親側が対象・材料をtaskへ渡す必要がある（reviewer自身は取得しない）。
`bash_output`はbashの保持出力専用のため同時に除外した。`skill`は維持する。

## 検証と結果

- 変更したproduct挙動に対応するfocused test:
  - `tests/v0/current_code_test.ts`の「active tool guidelines compose only where their tools are
    materialized」を、guidelineの集合・tool名順・各文言が1回だけ現れること、Reviewer compositionへ
    含まれないことを期待するよう更新し、16件pass。
  - `tests/v0/agent_worker_foundation_test.ts`の「headless Worker model receives each active tool
    guideline once」を、8 toolのguideline行と5つの優先文言の存在を確認するよう更新しpass。
    このtestはprovider-free headless Workerの実経路でmodel-visible instructionを取得する。
- 併せて`tests/v0/increment_16_instruction_components_test.ts`、`tests/v0/increment_186_search_test.ts`、
  `tests/v0/increment_181_configuration_test.ts`を実行し12件pass。
- reviewer変更のfocused test: `tests/v0/increment_127_external_agents_test.ts`を、reviewerの`tools`が
  `read`・`search`・`skill`であること、compositionに`bash`・`bash_output`が含まれないことへ更新し、
  6件pass。加えてprovider-free headless Workerでreviewerのinstructionをreadbackし、
  `no shell is available`、readとsearchのguideline行があり、`- bash:`・`- bash_output:`の行が無いことを確認した
  （同じtest内で実行）。
- `deno check`・`deno fmt --check`・`deno lint`・`git diff --check`はpass。
- provider-free headless Workerで最終instructionをreadbackし、enabled toolのguideline 18行
  （bash 4・bash_output 2・edit・read・run_typescript 3・search・web_fetch 2・web_search 3・write）と
  新しい文言を確認した。requestCount=0で実provider callは0。probeと出力はgit管理外の
  `.tools/increment-200/guideline_probe.ts`、`.tools/increment-200/guideline-readback.txt`にある。
- 未確認: modelが実際にbashの使用を減らすか、pipeを避けるかは、通常利用（実provider call）での観測が必要である。
  本incrementでは実provider callを行っていない。reviewer変更も、次のreview起動で実際にread/search中心に
  なるかは未確認（B12の再発時はreviewerがshell非依存になるため影響を受けない）。
- 今回の分析で分かった限界: 既存bash guidelineの「cdしない・相対path」は保存Session
  `0cd5c22e`で98%違反されており、案内だけでは遵守を保証しない。配置後に同じ観測で効果を測る。

## 承認境界・次の一手

利用者指示（round 1: 優先tool案内、round 2: パイプ・出力の扱い、round 3: reviewerからbashを外す）の
範囲でlocal実装・検証・常用config rootへのreviewer反映まで実施済み。commit/push、公式build、
常用配置（binary）、外部tool folder（search・web_search）の更新、実provider call、
構想・architecture・roadmapの変更は未実施であり、いずれも利用者の指示を必要とする。

未採用候補として通常利用メモへ残したもの: A30（tool間の結果連鎖）、A31（workspace外の読取・書込境界）、
A6（web_searchの取得サイズ）。`process runner ended before command status`の障害観測は同メモのB12にあり、
利用者判断で別途調査とする。A32（review用Agentのtool構成とinstruction）は本incrementへ採用・移設した。
