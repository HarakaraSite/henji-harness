# Increment 63 — 既定selectionの外部化とbuilt-in providerのoverride-aware解決

ステータス: **完了（v0:gate前）**

基準commit: `5d17d754`

計画日: 2026-09-17

対象: 完全外部化(c)の第1段。既定selectionをHost configへ移し、`openrouter`/`openai`のcatalog/defaultsを
宣言側で差し替え可能にする。adapterはbinary-owned、protocolは固定enumのまま。

## 参照実装から得た設計入力

- deepseek-harness: モデル選択が新規Sessionの既定になり、既にrequestを送ったSessionは自分のログのモデルを保持。
  既定providerが削除され解決不能なら入力をブロックして再選択を要求。設定/catalogはdata、adapterはbinary。
- zot: built-in catalogを同梱しつつprivateモデルは`models.json`。adapterはbinary。
- pi: catalogはコード/生成物寄り。

## 利用者が必要とする動作

- 人間が選んだモデルが**新規Sessionの既定**になり、再起動後も維持される。
- 宣言で`openrouter`/`openai`/`openrouter-responses`のcatalogと既定model/effortをoverrideでき、`/model`・
  `/effort`・model picker・selection検証が実効値を使う。宣言が無ければ同梱のbuilt-in既定へ戻る。
- 既存Sessionは自身が記録したモデルを保持し、既定変更で書き換わらない。
- credential値とAuthorizationは引き続き保存しない。

## 計画

### 既定selectionの外部化

- Host config `$XDG_CONFIG_HOME/henji-harness/default-selection.json`を追加する:
  `{ provider, api, authProfile, modelId, effort }`（`ModelSelection`と同形、`isStoredModelSelection`で検証）。
  atomic replaceでwriteする。
- TUI起動時、`--root-provider`未指定なら保存済み既定selectionをroot selectionとして使う。保存済み既定が無ければ
  同梱built-in既定（`openrouter`）を使う。
- `/provider`・`/model`・`/effort`の選択が確定したら、そのselectionを既定として保存する（新規Sessionへ適用）。
  現在Sessionのselection更新は現行どおり。
- 保存済み既定のproviderが解決不能な場合は、同梱built-in既定へfallbackし、footer/statusへ既定が再選択されたことを
  示す。入力ブロックはこのincrementでは行わない（Surface変更を伴うため後続）。

### built-in providerのoverride-aware解決

- `openrouter`/`openai`をoverride可能にし、宣言は同じ`providerId`のbuilt-inに対しcatalogとdefaultsだけを
  置き換える。`protocol`/`endpoint`/`authProfile`がbuilt-inと一致しない宣言は`provider_declaration_invalid`で
  拒否する。
- `openrouter_model_catalog.ts`/`openai_model_catalog.ts`の`*CatalogEntry`・`search*Models`・
  `is*ModelSelection`・`select*Model`を、対応する宣言があればそのcatalog/defaultsを使うよう変更する。
- `model_catalog.ts`の`defaultModelSelectionFor`は`openrouter`/`openai`でも宣言defaultsを返す。
  `declaredEntriesFor`はbuilt-in idを横取りしない。
- `provider_profile.ts`/`worker_physical_io.ts`のselection未指定フォールバックは実行時の
  `defaultModelSelectionFor('openrouter')`から構築する。

## 対象外

- curated catalogのコードからの完全除去と同梱default declarationsへの移行（Increment 64）
- chat completions adapterのendpoint宣言対応（64）
- planner/Sonarのrole別既定（65）、built-in id削除（66）
- 既定解決不能時の入力ブロック、動的catalog discovery、SQLite schema変更

## Verification

- focused test: 既定selectionの保存/読込/atomic replace、選択で既定が更新されること、`--root-provider`未指定時に
  保存済み既定が使われること、解決不能時にbuilt-inへfallbackすること。
- override test: `openrouter`/`openai`宣言でcatalog・defaults・picker・検証が実効値になり、宣言なしで静的値へ
  戻ること。protocol/endpoint/authProfile不一致が拒否されること。
- 既存回帰: openrouter/openai、openrouter-responses、宣言provider、planner、Sonar、Session resume、footer。
- type check、format、lint、`git diff --check`、authoritative `v0:gate`は安定候補で1回。

## 規模見積り

既定selectionのstoreとTUI配線、override許可と検証、catalog/selectionのoverride-aware化、フォールバック更新、
testで**2〜3開発日相当**。

## Human Gate

実装前に、利用者は次を確認・承認する。

1. 既定selectionをXDG config `default-selection.json`へ保存し、選択で更新、新規Sessionへ適用する扱い。
2. 保存済み既定が解決不能なときはbuilt-inへfallbackして通知する扱い（入力ブロックは後続）。
3. `openrouter`/`openai`のcatalog/defaults overrideを許可し、protocol/endpoint/authProfileはbuilt-in一致必須とする扱い。
4. roadmapのProvider外部化節へIncrement 63〜66の段階を追記する（roadmap正本更新）。

2026-09-17、利用者はこの計画を承認し、実装を指示した（roadmap追記は本increment確定時にまとめる）。

## 実装・検証結果

- `v0/agent/provider/default_selection.ts`を追加した。`$XDG_CONFIG_HOME/henji-harness/default-selection.json`の
  atomic read/writeで、`isStoredModelSelection`で検証する。`tui_cli.ts`は起動時に保存済み既定を読み、
  `--root-provider`未指定かつ解決可能ならそれをroot selectionに使い、解決不能ならbuilt-in既定
  （`openrouter`）へfallbackする。
- `/provider`・`/model`・`/effort`の選択確定時に、adapter経由で既定selectionを保存する
  （`persistDefaultSelection`）。新規Sessionへ適用され、既存Sessionの記録は変更しない。
- `openrouter`/`openai`をoverride可能にし、`resolveProviderRegistry`が`protocol`/`endpoint`/`authProfile`の
  built-in一致を検証する（不一致は`provider_declaration_invalid`）。`tui_cli`/`worker_tui_session`は
  `builtinProviderDeclarations()`と宣言を`resolveProviderRegistry`でマージしてactive化する。
- `openrouter_model_catalog.ts`/`openai_model_catalog.ts`のcatalog参照・selection検証・選択・検索を
  `declarationFor('openrouter'|'openai')`でoverride-awareにした。`defaultModelSelectionFor`は宣言defaultsを返し、
  `worker_physical_io.ts`のroot fallbackは実行時の`defaultModelSelectionFor('openrouter')`を使う。
- focused test: `default-selection`のread/write、`openrouter`宣言overrideでのcatalog/defaults/search/検証、
  built-in overrideの不一致拒否を追加し、increment-14は17 passed。increment-15（6）、increment-33（11）、
  TUI系（86）、foundation（26）もpassed。type check/format/lint/`git diff --check`成功。
- 実機: isolated XDGで保存済み既定（`openai`/`gpt-5.6-terra`）が起動footerに反映され、`--root-provider
  openrouter`が保存済み既定を上書きし、`openrouter`のcatalog override宣言でfooterが`model:acme/chat low`に
  なること、endpoint不一致の宣言が起動前に失敗することを確認した（provider requestは行っていない）。
- roadmapのProvider外部化節へIncrement 58〜63の実装状況と64〜66の予定段階を追記した。
- authoritative `v0:gate`は2026-09-17に実行し全check/fmt/lint/testが成功した。
- 利用者の明示指示により、実装をcommit `26743c62`へ確定した。そのclean commitからbuild
  `45298791438c8ad7d1a60229c742825404f9ee7a16fe8f1da84c80cadb780992`を生成し、`dist/henji`と
  `~/.local/bin/henji`をatomic置換した。両方のSHA-256は
  `f1b428dbeb9f036fc5f4cf4d277d7fc9e9abc715ecb91e1b35289f36787450f8`で、導入版はsource
  `26743c620cbb5bd5fe9bd06831cc173dda4c5fac`、`sourceDirty=false`を返した。tag、release、publishは行っていない。
