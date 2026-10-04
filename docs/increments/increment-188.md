# Increment 188 — editの対象ファイル上限を1 MiBへ拡張

状態: 完了（2026-10-04、利用者による完了承認済み）。実装・compiled実経路確認・常用配置済み。
sourceは未commit。

## 必要な動作と根拠

利用者は通常利用メモの編集が64 KiB上限で失敗したと報告した。調査時の同文書は45,787字、 UTF-8で76,018
bytes（74.2 KiB）であり、少数行の挿入でも対象全体の読込みで失敗する。
henjiのdocs配下とrootのREADME・AGENTSでは最大137,650 bytes、64 KiB超が12文書あった。
`_refs`の文書・sourceにも256 KiB超があり、調査したMarkdown・MDXの最大は606,230 bytes、
主要source拡張子で集計した最大は573,282 bytesだった。

利用者の「1mbにしようか、著しく遅いとかなったら再考する」で、editの編集前・編集後の対象全体を 1
MiB（1,048,576 UTF-8 bytes）まで扱う変更を採用した。性能に実利用上の問題が観測された場合に
方式を再検討する。全文読込みとexact replacementは維持し、上限サイズの事前確保は追加しない。 readの64
KiB返却window、writeのcontent、edit各oldText/newTextの64 KiB上限は変更しない。

## 現行経路と対象

Agent JSONでeditを選択 → Workerのbundled tool loaderがcreateEditToolを生成 → modelへschemaと
descriptionを提示 → Registry dispatch → 対象全体のsnapshot読込み → 一意なexact replacement →
編集後bytes生成 → 元fileの再読込み比較 → atomicReplace内で再確認 → sibling temporary fileから rename
→ path・編集件数・byte数をsemantic tool resultへ返す、という現行経路を使う。

変更対象はedit用file byte上限、snapshotと再読込み、編集後の上限、model向けdescription、
既存filesystem focused testである。readWindowやwriteの契約、Core、Surface、外部tool、
provider/APIは変更しない。構想・architecture・roadmapに必要な意味上の変更はない。
常用binaryへの配置、commit、公開/release、実provider callは本変更に含めない。

## 実装・確認計画

1. edit対象file専用の1 MiB定数を導入し、読込みと保存前の二か所の再読込み、編集後の判定を揃える。
   read・write・各置換文字列の既存定数とは分離する。descriptionへ対象全体と各置換文字列の上限を示す。
2. 既存testの「64 KiB超のeditを拒否する」という旧期待を、正常な部分置換の確認へ変更する。
   UTF-8の3行挿入で1 MiBに達する編集とそのfileの再編集、採用した編集前・編集後の上限を確認する。
3. 通常利用メモと最大henji文書のコピーを隔離workspaceに置き、実Workerのbundled tool loader・Registry
   経由で3行挿入と全文readbackを確認する。小fileと1 MiB fileも同経路で時間を観測し、数値はlocal
   単発測定として扱う。実provider callは行わない。
4. 変更箇所のfocused test、関連する既存Worker/基本tool確認、type check、format、lint、git diff
   --checkを行う。Surface変更はないためtmux確認、full gateは行わない。

## 結果

- edit専用の`MAX_EDIT_FILE_BYTES = 1_048_576`を導入した。snapshot読込み、Registry内とrename前の
  再読込み比較、編集後の判定を同じ上限へ揃えた。readWindow、write content、各oldText/newTextは
  既存の`MAX_TEXT_BYTES = 65_536`を使う。上限分の事前確保や処理方式変更はない。
- modelへ提示するdescriptionに編集前・編集後の1 MiB上限と、各置換文字列の64 KiB上限を明示した。
- 既存filesystem focused testは成功した。小fileのwrite/edit/read、64 KiB超の部分置換とreadの
  continuation、UTF-8の3行挿入で1 MiBへ達する編集とそのfileの再編集、編集前・編集後の1 MiB上限を
  確認した。旧仕様を固定していた64 KiB超のedit拒否期待は正常な置換の確認へ更新した。
- productionと同じconfiguration resolver、bundled tool loader、Registryを使う実Deno Workerで、
  通常利用メモ（76,018 bytes）と最大henji文書（137,650 bytes）のコピー、小file、1 MiBに達するfileへ
  日本語3行を挿入した。返却metadata、Workerのread、編集後全文のreadbackがすべて一致した。
  原文書と実configは変更していない。model/provider transportとcompiled常用binaryは使っていない。
- local単発のdispatch所要時間は小file1.87 ms、通常利用メモ3.52 ms、最大文書5.45 ms、 1 MiB file29.54
  msだった。起動後のWorker messageとfile I/Oを含む値で、旧実装との比較や継続利用の
  性能保証ではない。著しい遅延はこの確認では観測されていない。probeと証拠はgit管理外の
  `.tools/increment-188/probe.ts`、`.tools/increment-188/evidence.json`へ保存した。
- 関連する既存の実Workerの基本5 tool確認、変更箇所とWorker loaderのtype check、format、lint、
  `git diff --check`は成功した。full gate、tmux、実provider call、常用配置、commit、公開/releaseは
  行っていない。実provider callは0回。
- 常用binaryは従来のままなので、通常利用には変更sourceを含むbinaryへの更新が必要である。
  常用反映と利用者確認が済むまではincrement全体の完了とは扱わない。

## 常用反映の承認と結果（2026-10-04）

利用者の「反映して」で、公式buildと常用binaryへの配置、配置結果の記録を追加承認された。
上記結果の常用未反映状態をこの節で更新する。commit・公開/release・実provider callは含まない。

- 公式`scripts/build_henji.ts`でDeno 2.9.7のcandidateをbuildした。version 0.8.0、sourceRevision
  `e3333fd1eea50fc5cdf14b2074b63f5d91f14cf1`、sourceDirty=trueであり、未commit状態を維持した。
- 隔離HOME/XDG/workspaceでcompiled `serve` → public API → Worker → Registryの実経路を使い、
  小file・通常利用メモ・最大henji文書・1 MiBに達する日本語fileへ各3行を挿入した。 modelへ提示された1
  MiBのdescription、tool metadata、Workerのread、実file全文、semantic historyの
  readbackが一致した。executionはcompleted/canonical。CoreのPATHにDenoを置いていない。
  localhostの代替modelへ9 request、実provider requestは0回。
- 検証済みcandidateを`/home/agent/.local/bin/henji`と`dist/henji`へstagingからatomic配置した。
  両配置先のversion・build・SHA-256が検証済みartifactと一致し、常用の`tool inspect --name edit`も
  bundled toolを返した。外部tool・設定fileのhashは前後一致した。
- build ID: `1344b0edc8f8d5e84f558aaa818650c3bfe6b1c690c5d2f39a1fce97f9e07a08`。
- embedded runtime SHA-256: `8585b30dcd0fd74a9b515ec95992b6f6a19c61fa31aa74fca56d94aaa485ed15`。
- binary SHA-256: `95f72dfb72b0d1f8c4e2f165f0702d344999d0218400a3a3adecbb2281edc057`。
- 配置前後で既存CoreのID・PID・URLが一致した。既存Core/TUIは再起動していないため、 新binaryの1
  MiB上限は新しいCoreから有効になる。利用者による通常利用と体感速度は未確認である。
- 旧binaryはgit管理外の`.tools/increment-188/deployment/henji.{dist,local}.previous`へ保存した。
  build.log、probe.log、verification/evidence.json、verification/history.ndjson、deployment.jsonと
  Core/configの前後snapshotを`.tools/increment-188/`配下へ保存した。
- full gate、tmux、実provider call、commit、公開/releaseは行っていない。

## 完了判断（2026-10-04）

利用者の「完了とします」によりIncrement 188の完了が承認された。 editの対象全体1
MiBへの拡張、source/compiledの実経路確認、常用配置とこの承認をもって完了とする。
著しい遅延が通常利用で観測された場合は、利用者の方針に従って処理方式を再考する。
この完了承認はcommit・公開/release・実provider callの追加承認を含まない。

## 後続のsource commit（2026-10-04）

Increment 189で利用者が「常用配置・commit」を承認した際、反映済み186〜188のsourceを 先行commit
`560031e9`へまとめた。188のproduct動作は変更していない。
189の常用配置と確認結果は[Increment 189](increment-189.md)の§16を参照する。
