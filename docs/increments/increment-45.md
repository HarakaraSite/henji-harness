# Increment 45 — native Skill description acceptance

ステータス: **完了（2026-09-13）**

基準commit: `dc3e1788`

対象機能: F02、F03、F06

## 利用者が必要とする動作

- native `SKILL.md`のdescriptionが160 bytesを超えていても、1 KiB以内なら通常のSkill discoveryで受理する。
- 観測済みの`handoff-write`、`playwright-e2e`、`apply-forgejo-go-release-profile`相当のdescriptionを、
  外部Skill側で短縮せず利用できる。
- workspace/user scope、Zot・Claude・Agents間のprecedence、Skill本文の遅延読込みは変えない。

## 根拠と確認済み状態

- 現行sourceは`MAX_SKILL_DESCRIPTION_BYTES = 160`を固定し、超過したSkillをdiscovery結果から除外する。
- 通常利用では158 bytesの`handoff-read`だけが受理され、176 bytes、370 bytes、575 bytesの有効なSkillが
  description長だけを理由に除外された。
- 利用者はdescription単体を1 KiBまたはそれ以上へ広げる方針を選び、このIncrementでは最小の1 KiBを採用した。
- description単体上限はarchitecture上の固定値ではなく、現行のfrontmatter全体4 KiB、manifest全体8 KiB、
  callable Skill 24件とは独立した実装上限である。

## 承認済み実装範囲

1. native Skill descriptionのUTF-8上限を160 bytesから1 KiBへ変更する。
2. 1 KiBのdescriptionを持つSkillが通常のworkspace discovery経路で受理され、catalogとmanifestへ同じ本文で
   現れることをfocused testで確認する。
3. 通常利用メモのA8をこのIncrementへ移す。

## 対象外

- frontmatter、manifest、Skill file、tool result、callable件数の上限変更
- discovery failureのdiagnostic追加、parser形式の変更
- `/rebuild`、Skillの有効・無効selection、managed Skill revision
- architecture、roadmap、構想の変更
- version更新、commit、push、publish、installed binaryの置換

## Verification

- Increment 32の既存Skill discovery testと、追加する1 KiB descriptionのfocused testを実行する。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`を実行する。
- 開発VMの実Skill catalogをread-onlyで生成し、観測済みの長いdescriptionを持つSkillが受理されることを確認する。

## 実装結果

- `MAX_SKILL_DESCRIPTION_BYTES`を160から1024へ変更し、frontmatter、manifest、Skill file、tool result、
  callable件数の各上限は変更しなかった。
- 1 KiBのdescriptionを持つworkspace Skillがdiscoveryされ、catalogとmanifestへ同じdescriptionで現れる
  focused testを追加した。既存のworkspace/user scopeとprecedenceを含むIncrement 32 suiteは全7件成功した。
- 開発VMの実Skill catalogをread-onlyで生成し、158 bytesの`handoff-read`に加えて、従来除外されていた
  176 bytesの`handoff-write`、370 bytesの`playwright-e2e`、575 bytesの
  `apply-forgejo-go-release-profile`がすべて受理されることを確認した。
- `v0:check`、`v0:fmt`、`v0:lint`、`git diff --check`は成功した。full `v0:gate`は承認済み計画に含めず、
  実行していない。
