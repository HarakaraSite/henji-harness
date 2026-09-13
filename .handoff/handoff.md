# Handoff

## Records

### 次Incrementの選定

- 状態: Increment 40〜43完了後の整合性確認をIncrement 44として実施し、SQLiteを唯一のdurable history経路へ
  統一した。旧filesystem Session/evidence/diagnostic/artifact実装、到達不能なruntime分岐・legacy notice・export、
  旧storeだけを確認するtestを削除し、現行testをSQLite経路と通常`v0:test`へ統合した。VMユーザー共通toolとして
  `~/.local/bin/deno`へDeno 2.9.6を導入し、現行taskとbuild/publish手順からsibling repositoryのDeno絶対pathを
  除いた。Deno 2.9.6によるfocused確認、standalone compile、authoritative `v0:gate`全272 testは成功した。
  続くrelease準備でREADMEを現在の利用開始に必要な約4.3 KBへ整理し、自己改訂workflowが未実装であること、0.xの
  破壊的変更注意、Quick Start、現在の主要機能、JSR library/native binary境界を明記した。JSRのexact pin例は
  `deno add --save-exact`へ修正し、同じpackage説明をJSR module docへ反映した。次versionは0.1.1で、development
  headerも一致する。`publish.include`を現行module graphへ合わせ、型・format・lint、source `--version`、README整理後を
  含むdirty working tree上のJSR dry-runが成功した。実装・release準備差分は未commitで、installed `henji`は置換していない。
- 次: 利用者がrelease固有追加testの要否を決めた後、0.1.1 release candidateのfull gate、commit、pushへ進む。
- 正本: `docs/increments/increment-44.md`、`README.md`、`mod.ts`、`jsr.json`、
  `docs/operations/jsr-publish.md`、`docs/experience/normal-use-inbox.md`。
- 注意: working treeにはIncrement 44より前の通常利用候補とIncrement 43完了確認の文書差分もあるため破棄しない。
  既存SQLite・旧JSON dataは変更・削除していない。architecture・roadmap・構想の変更、installed binary置換、commit、
  push、tag、publish、releaseは実施していない。実publishはclean worktreeから行う。
