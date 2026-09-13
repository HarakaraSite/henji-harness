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
- 利用者の別途明示指示により、Increment 45〜48の未commit runtime差分を含むdevelopment binaryを
  `dist/henji`と`/home/masat.guest/.local/bin/henji`へ配置した。version `0.1.2`、build ID
  `a86f640ec6f0dd50b98dcb4e4448c8b7a3c3b39ee5c4bbe4912953dde536a93a`、`sourceDirty: true`をreadbackし、
  両配置先のartifact SHA-256 `1c5a4a5a4c48e1fa46f5c4887290973202236a5cc8ff83976691280b252d97b6`が一致した。
- 配置後、利用者がinstalled binaryを確認し、OKと判断した。
