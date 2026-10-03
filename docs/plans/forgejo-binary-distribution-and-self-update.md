# Forgejoでのbinary配布と自己update — 段階案

## 状態と承認範囲

利用者の要望をまとめた検討案。個別incrementへの採用、実装着手、version変更、tag作成、
Release公開、Forgejo Actionsの設定変更、常用binaryの更新は、この文書の作成では承認されていない。
各段階の具体的な計画と承認を得てから進める。
構想・architecture・roadmapの変更が必要なら、対象・理由・意味上の変更を別途提示し、承認を得る。

## 目的と明示要件

利用者がrepositoryのcheckoutやDenoの導入なしにHenjiを利用開始でき、後に同じ配布基盤から
`henji update`でbinaryを更新できるようにする。

利用者の明示要件：

- 一度に実装せず、何段階かに分けて進める。
- 最終的な対応OSはmacOS・Linux・Windows。
- 最終的にForgejo Actionsでbuildする。
- 別の利用者機能として、`henji update`による自己updateを実現する。

この文書の段階順、初回target、配布形式、受入方法は提案であり、確定仕様ではない。

## 現行経路と確認済みの根拠

直接確認したrepository内のsource：

- [`README.ja.md`](../../README.ja.md)：現在の導入経路はclone → Deno 2.9.7で
  `deno task --config deno.v0.json henji:compile` → `./dist/henji --version` → 起動・認証設定。
  JSRはDefinition用composition APIの配布先であり、native binaryは配布しない。
- [`scripts/build_henji.ts`](../../scripts/build_henji.ts)：standalone executableを作成し、
  product version、source revision、source dirty flag、Deno version、target、build ID等を埋め込む。
  product versionは`jsr.json`から取得する。現在の引数は`--output PATH`で、target指定はない。
  compileに`/bin/bash`の実行許可を指定し、targetには`Deno.build.target`を記録する。
- [`docs/operations/local-build-2026-10-01.md`](../operations/local-build-2026-10-01.md)：
  Linux x86_64向けのbuild・識別情報確認・常用配置・隔離環境での起動確認の過去の実施記録。
  これは今回の配布候補の検証結果ではない。

Forgejo公式の[Tags and Releases](https://forgejo.org/docs/latest/user/repository/releases/)について、
検索で取得した公式ページの抜粋を確認した。Git tagに紐づくReleaseへrelease notesとfileを添付でき、
Web UIとAPIから操作できる。実instanceの設定・容量上限・API詳細は未確認。

現行ではbuild scriptがbinaryと埋込み識別情報を生成し、利用者がbinaryを配置・起動する。
新しい配布経路ではForgejo Releaseが公開成果物の取得先になる。自己updateでは、同じ成果物を
Henjiが取得して配置する。Session dataやcredentialの移行・削除はこの案に含めない。

## 全体方針

1. Linuxで手動配布を成立させる。
2. 同じ成果物のbuild・配布をForgejo Actionsへ移す。
3. macOS・Windowsへ配布対象を広げる。
4. 配布基盤を使う`henji update`を実装する。

各段階は、計画 → 実装 → 実利用経路の確認 → 結果報告で区切る。
前段階の完了は後続段階の完了・着手承認を意味しない。

自己updateのためのversion・target・asset識別は段階1から考えるが、update処理そのものは先行実装しない。
最初からinstaller、自動更新実行、すべてのarchitecture対応まで広げない。

## 段階1：Linuxで手動配布を成立させる

### 提案する範囲

- 初回targetはLinux x86_64。
- 現repositoryのForgejo Releasesへ手動で公開する。
- 配布物は`henji-<version>-linux-x86_64.tar.gz`と`SHA256SUMS`を候補とする。
- archiveには`henji`、`LICENSE`、短い導入説明を含める。
- Git tag、Release表示、binary内product versionを揃える。
- release notesに変更概要、対応環境、導入方法、0.xの破壊的変更に関する注意を記載する。
- READMEにbinaryからの導入経路を追加する。JSRとnative binaryの役割分離は維持する。

### 利用者経路と完了条件

Forgejoからdownload → 展開 → PATHの通った場所へ配置 → `henji --version` → 起動・認証設定。

公開された配布物を実際にdownloadし、repository checkoutなし・隔離config/stateで配置・起動できることを
確認する。Linuxの具体的な対応環境は配布候補を検証して明記する。
TUI確認は隔離XDGのtmuxで行い、通常configや稼働Coreを変更しない。
実provider callを伴う機能確認は、対象・回数・保存先を提示し、別途明示承認を得る。

### この段階で決める事項

- 初回versionとtag命名。READMEのJSR例は`0.8.0`だが、初回配布versionは未決定。
- product versionが`jsr.json`由来であることを踏まえたversion運用。
  JSR packageも同時に公開するかは別の判断。
- archive内容、asset命名、checksum記載形式。
- version・targetからassetを特定する契約。
  機械向けmanifestを添付するか、Release APIと規則的なasset名を使うかは未決定。
- 実instanceの添付容量上限と、配布binaryのサイズが収まること。

## 段階2：Linuxのbuild・配布をForgejo Actionsへ移す

### 提案する範囲

- 固定したDeno versionで既存のbuild経路を実行する。
- binaryのversion、source revision、dirty flag、targetを確認する。
- 段階1と同じarchive・checksumを生成する。
- tagを起点にReleaseへ添付する運用を整備する。

最初はActionsで成果物を生成し、公開だけ手動にしてもよい。
build自動化と公開自動化を分けて確認し、公開の承認境界を明確にする。

### 完了条件

承認したversionのtagからLinux配布物を生成し、Forgejoからdownloadした成果物が利用できる。
単なるworkflow成功やartifact生成だけでは完了としない。

### 未確認事項

Forgejo Actionsの公式契約、実instanceでの有効化状態、runner構成、利用可能なbuild環境、
Release添付方法と必要な認証設定。実装前に公式文書と既存設定を確認し、設定で満たせる部分を優先する。
credential値・Authorizationを記録しない。

## 段階3：macOS・Windowsへ配布対象を広げる

### target候補

| OS | architecture候補 |
|---|---|
| Linux | x86_64、ARM64追加の要否は未決定 |
| macOS | Apple Silicon、Intel対応の要否は未決定 |
| Windows | まずx86_64、ARM64対応の要否は未決定 |

OSごとに独立した実装・確認単位とする。すべてのarchitectureを必須とはしない。

### 必要な確認

- 各OSのbuild方法と、Forgejo Actionsから利用できるrunner／環境。
- Denoの対象targetとcompileの公式契約。
- 配置・起動・TUI操作・保存履歴・tool実行の実利用経路。
- 現build scriptの`/bin/bash`指定を含む環境依存。
  特にWindowsでbash toolをどう利用可能にするかは未決定。

cross compile成功を製品対応の代替にしない。現時点ではbuild script以外のOS依存実装の調査は行っておらず、
具体的な変更箇所・対応工数は未確定。

### 完了条件

各対応OSでdownload・配置・起動・主要操作が成立し、その配布物をForgejo Actionsから生成できる。
OSごとの導入条件を利用者向けに明記する。

## 段階4：`henji update`を実装する

### 想定する利用者経路

```text
henji update
  → 利用可能なversionを確認
  → 自分のOS／architectureに合う配布物を取得
  → checksumを確認
  → 配置済みbinaryを更新
  → 更新結果とversionを表示
```

段階1〜3の配布契約を再利用する。別のbinary配布先や重複したversion管理を増やさない。
まずLinuxで成立させ、その後macOS・Windowsの実経路を確認する順序を提案する。

### 実装前に決めるproduct動作

- 「最新」をどのReleaseから選ぶか。prereleaseを含めるか。
- version指定更新を提供するか。
- 手動配置されたbinaryの更新先をどう特定するか。
- 起動中のCoreは旧binaryで継続し、新しい起動から新版を使う方針でよいか。
- Windowsの実行中binary置換をどう成立させるか。
- 0.xの破壊的変更を利用者へどう知らせるか。

### 完了条件

配布済みの旧versionから`henji update`を実行し、新versionで起動できる。
各OSの実配置先で更新結果を確認する。内部testやdownload成功のみでは完了としない。

自動的な更新実行、Session dataのmigration、既存dataの削除は対象外。
`henji update`自体がまだない旧binaryでは手動更新が必要となるため、初回導入の説明も残す。

## 次の一手

この案の段階順・初回target・段階1の対象範囲を利用者と確認し、承認後に個別incrementとして
具体的な計画を作成する。段階1の配布契約を決め、公開前に配布候補の実利用確認を行う。

## 今回の文書化での差分

会話の提案を段階別に整理し、確認済みsource、未確認事項、実装・公開の承認境界を明記した。
versionの取得元が`jsr.json`である点と、update未搭載binaryの初回更新は手動になる点を補足した。
提案を確定仕様へ変更していない。実装・公開作業、既存のproduct正本やREADMEの変更は行っていない。
