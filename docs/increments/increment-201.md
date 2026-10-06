# Increment 201 — 読み取り専用のinspection tool（git_inspect新設・search entries拡張）

状態: local実装・検証・常用config rootへの外部tool配置まで完了（2026-10-06）。commit/push、
公式build、常用配置（binary）、実provider callは未実施。

## 利用者が必要とする動作と根拠

利用者指示（2026-10-06）: 「git_inspectでいいと思うけど、親も使うことを前提にしてね」「Aで
searchの拡張も行いたい」。背景は[Increment 200](increment-200.md)でreviewerから`bash`を外したことと、
保存Session `2bc2699f`の分析でreview子のbash用途が「rg/grep 15・ls 4・find 3・wc 3・git 1」に
集中していたこと。gitの差分・履歴と、file type/size/時刻の確認を、shellなしでread-onlyに行える
ようにする。

根拠: この会話の利用者指示、[Increment 200](increment-200.md)のreviewer変更、
[通常利用メモ](../experience/normal-use-inbox.md)のA30・A33の設計メモ、
`external-tools/search/`の既存実装パターン。

## 1. git_inspect（新設・外部tool）

設計の要は**自由引数を受けない**こと。`op`のenumと固定argvでtool側が組み立てるため、modelは
`rebase`・`-c`・`--output`等の任意git操作を表現できない。未知fieldと未対応opは`ToolInputError`。

| 項目 | 内容 |
| --- | --- |
| 場所 | `external-tools/git_inspect/{tool.json,settings.ts,index.ts}`（revision 1、external定義） |
| op | `status`（`--porcelain=v1 --branch`）、`diff`（worktree／`staged`でindex／`rev`指定）、`log`（`--oneline`）、`show`（`rev`必須） |
| 引数 | `paths`（workspace相対のみ、`/`始まりと`..`を拒否）、`rev`（`HEAD`・`HEAD~N`・7–40桁hex）、`staged`、`stat`、`context`（diffのみ、0–10、既定3）、`offset`/`limit` |
| 固定flag | `--no-pager --no-color`、diff/showは`--no-ext-diff --no-textconv`（repo設定のdiff driver・textconvからコマンドが走る経路を閉じる） |
| env | `PATH`/`LANG`/`LC_ALL`（settings.tsで編集可）、`GIT_PAGER=cat`、`GIT_OPTIONAL_LOCKS=0`（`status`がindexを触らない） |
| 出力 | 行window（`offset`/`limit`、`totalLines`・`hasMore`・`nextOffset`）。`log`はoffset/limitがcommit選択。stdoutは最大8 MiB、stderrは64 KiBで打ち切り、`stderr`は非空時のみ返す |
| 失敗の区別 | git実行fileがPATHに無い→`could not find git in its PATH`、非repo→`the workspace is not a git repository`、その他はexit codeとstderr1行 |
| 親・generic | 同梱default agent（`v0/agent/configuration/default-agent.json`）へ追加（genericも同じ構成） |
| reviewer | `agents/reviewer.json`（revision 3）へ追加し、instructionを`git_inspect`言及付きへ更新 |

## 2. search entries拡張

`mode: "entries"`を追加（既存modeの挙動は変更しない）。

- `path`直下（`depth`既定1、最大16）のentryを、`path`・`type`（file・directory・symlink・other）・
  `bytes`（fileのみ）・`modifiedAt`（mtimeがある場合）で返す。`glob`は既存と同じ規則でpathを絞る
- symlinkはsymlinkとして報告し、symlinked directoryはfollowしない（cycle回避）。`count`以外と同じ
  `offset`/`limit`/`total`/`hasMore`/`nextOffset`のenvelopeを使う
- `depth`はentries専用（他modeではエラー）。entriesは`pattern`を要求しない
- grep/rgのprocessは使わない（Deno列挙）。revisionを`local-3`へ更新

## 変更しないもの

tool本体（read/write/edit/bash/bash_output/run_typescript）の入出力、既存search modeの結果形式、
保存data、TUI表示、Agent JSONの既定（default/genericの既存tool選択は維持し`git_inspect`を追加のみ）。

## 配布と配置

- package: `scripts/package_henji.ts`の`toolNames`へ`git_inspect`を追加、`scripts/install_henji.sh`の
  登録loopへ追加（folder copyは既存を保持、`tool activate`は毎回）
- 2026-10-06に常用config rootへ反映: `tools/git_inspect`のcopy、`tools.json`へ`git_inspect`binding追加、
  `tools/search`のindex.ts・tool.json・settings.ts更新、`agents/reviewer.json`（revision 3）更新。
  backupは`.tools/increment-201/`（`tools.json.prev`、`search-prev/`、`reviewer.json.prev`）
- 検証: `henji agent inspect --name reviewer`でtools `git_inspect`(external,1)・`read`・`search`(local-3)・
  `skill`、rejections `[]`。`henji tool list`でgit_inspectのfolder登録を確認
- 親（同梱default agent）の利用は**binary再build後**から有効（同梱Agent JSONは埋め込みのため）

## 検証と結果

- `tests/v0/increment_201_inspection_tools_test.ts`（provider-free Worker、実git repoと実Workerを使用）:
  status・diff・stat・staged・paths絞り込み・log（offset/limit）・show（行window）・不正op/不正rev/
  絶対path/staged誤用の拒否・entries（type/bytes/modifiedAt・depth・glob・paging・file scope拒否・
  depth誤用拒否）・git不在・非repoの各errorを確認。さらに**検査前後で`.git/index`のバイト、`git status`、
  `HEAD`が不変**であることをassert（read-onlyの実証）
- 関連: `increment_127`（reviewer tools更新）・`increment_186`・`increment_181`・`increment_110`・
  `current_code`・`agent_worker_foundation`を含む8ファイルで**74件pass**
- `deno check`・`deno fmt --check`・`deno lint`・`git diff --check` pass
- provider-free headless Workerのreadback（`.tools/increment-201/parent-guideline-readback.txt`）:
  default agentのguideline 19行に`git_inspect`と新しい`search`の案内を確認、requestCount 0
- 未確認: 実providerでのtool選択（親がbashよりgit_inspectを選ぶか）、実reviewでの使い勝手、
  submoduleを含むrepoの差分表示

## 承認境界・次の一手

local実装・検証・外部tool配置は利用者指示の範囲で実施済み。commit/push、公式build、常用配置（binary）、
実provider call、構想・architecture・roadmapの変更は未実施であり、利用者の指示を必要とする。
