# Increment 46 — TUI build version header

ステータス: **完了（2026-09-13）**

基準commit: `a8857912`

対象機能: F01、F10

## 利用者が必要とする動作

- 通常利用中のTUI起動ヘッダで、実行中Henji buildのversionを`Henji Harness v0.1.2`形式で確認できる。
- 通常幅とcompact表示は同じ`productVersion`を表示する。
- development source実行とstandalone buildのversionは、いずれも`jsr.json`をpackage versionの正本とする。

## 根拠と確認済み状態

- standalone buildは`jsr.json`のversionをbuild manifestへ埋め込み、`henji --version`で表示する。
- TUIのstartup display stateはbuild manifestを受け取らず、通常幅・compactとも`Henji Harness`だけを表示する。
- development manifestには旧version `0.1.1`が固定され、現行`jsr.json`の`0.1.2`と一致していない。
- 利用者は固定文字列ではなく実行中buildの`productVersion`をTUIヘッダへ表示する方針を選んだ。

## 承認済み実装範囲

1. development manifestの`productVersion`を`jsr.json`から取得する。
2. Hostがbuild manifestの`productVersion`をstartup display stateとpresentation contractへ渡す。
3. 通常幅とcompactのヘッダへ`Henji Harness v<productVersion>`を表示する。
4. development version、Worker sessionのstartup projection、両ヘッダ表示をfocused testで確認する。

## 対象外

- footer、help、Session identity、version選択規則の変更
- version更新、commit、push、publish、installed binaryの置換
- architecture、roadmap、構想の変更

## Verification

- Increment 32のdevelopment manifest / Worker startup testとTUI retained header testを実行する。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`はIncrement 46〜48の安定候補でまとめて実行する。

## 実装結果

- development build manifestは`jsr.json`をimportし、package version `0.1.2`を`productVersion`として返す。
- runtimeとWorker TUI sessionが同じbuild manifest値をstartup projectionへ渡し、presentation contractを通じて
  通常幅・compact両方のヘッダへ`Henji Harness v0.1.2`と表示する。
- Increment 32 suite全7件とTUI retained terminal suite全32件が成功した。`v0:check`、`v0:fmt`、`v0:lint`、
  `git diff --check`も成功した。version更新、release、full `v0:gate`は実行していない。
- 利用者の別途明示指示により、Increment 45〜48を含むbinaryを`dist/henji`と
  `/home/masat.guest/.local/bin/henji`へ配置した。commit前の同一runtimeを含む配置後動作を利用者が確認し、
  OKと判断した。実装commit後にattributionを揃えて再build・再配置し、version `0.1.2`、source revision
  `229e40ee79e448f6895a6480a69aaf607ea756fd`、`sourceDirty: false`、build ID
  `9bf545653b420811ceabdcd02e2c95bf3fea2569605b94e47659b97cfc86e7f3`をreadbackした。両配置先のartifact
  SHA-256 `1e5c87759b20981cd966682d689fefb637bb71d618d76dd55321a1ef8b8af71f`も一致した。
