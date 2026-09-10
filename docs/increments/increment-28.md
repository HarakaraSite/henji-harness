# 通常利用 Increment 28 — Busy経過時間とSession識別情報

ステータス: **完了**

## 利用者が必要とする動作

- 長いturnの継続時間を、busy footerだけを見て判断できる。
- 保存済みSessionを、provider/modelではなく更新日時と人間が付けたtitleで識別できる。
- current SessionのtitleをTUIの`/rename <title>`から変更できる。
- AIによる自動title生成は行わない。

## Product動作

### Busy経過時間

- Host Surfaceが`turn_start`を受けた時点をtask開始とし、1秒ごとに経過時間を更新する。
- 1時間未満は`MM:SS`、1時間以降は`H:MM:SS`で、footerの`busy`または`cancelling`直後へ表示する。
- steeringやfollow-up準備中も同じturnの経過時間を維持し、`turn_end`、失敗、renderer終了時に停止する。
- timerはTUI内だけに置き、Worker protocol、Session、provider requestへ追加しない。

### Session titleとrename

- current Worker Session schemaをv5とし、nullableな手動titleを永続化する。
- schema v1〜v4は従来どおり読み、titleなしとして扱う。次のdurable commit、model変更、またはrenameでv5へ移行する。
- idle中の`/rename <title>`はcurrent persistent Sessionのtitle、`updatedAt`、state revisionを更新する。
- `/rename`だけではusageを表示せず変更なしとする。busy中はmodel入力にせず、ready後の再実行を案内する。
- `--no-session`ではrenameを利用不可とする。

### Session picker

- 各Sessionを二行で表示し、一行目をUTC分単位の`updatedAt`とtitle、二行目を短縮Session ID、turn数、
  current/resume可否等の状態とする。
- titleなしは`untitled`と表示する。
- provider、model、effortは一覧から外すが、Sessionへの保存とresume時の復元は維持する。

## 実装計画

1. Session v5 codec、v1〜v4 read migration、metadata projection、current handleを使うHost-owned renameを追加する。
2. presentation intent/resultとTUI slash commandをrenameへ接続し、commandをmodelへ渡さない。
3. retained Session pickerを日時/titleの二行表示へ変更する。
4. retained UiStateへbusy elapsedを追加し、renderer-local timerを`turn_start`/`turn_end`へ接続する。
5. 採用項目を通常利用メモから移し、READMEと承認済みroadmap記述を現動作へ合わせる。
6. focused test、type check、format、lint、`git diff --check`、review後、stable candidateで`v0:gate`を一回実行する。

## 成功条件

- production TUIでbusy経過時間が毎秒進み、turn終了後に更新が残らない。
- `/rename <title>`がcurrent persistent Sessionへ保存され、turn commitとresume後も保持される。
- schema v1〜v4のSessionをtitleなしで読み、次のwriteでv5へ移行できる。
- Session pickerが日時/titleを表示し、provider/model/effortを表示しない。
- provider/model selectionの保存・復元、Session navigation、conversation動作を変更しない。

## 対象外

- AIによるtitle生成、title再生成、title削除専用command
- slash command候補の選択・入力補完
- provider/model selectionまたはfooter identityの削除
- Worker protocol、provider request、構想・architectureの変更
- live provider、real-TTY、browser E2E

## 承認

- 利用者は2026-09-10、上記計画と、F01、F05、現行production TUIの新動作に限るroadmap更新を承認した。

## 実装結果

- retained rendererは`turn_start`から`00:00`を表示し、毎秒更新する。1時間以降は`H:MM:SS`へ切り替え、
  steering、follow-up準備、cancellingでも同じturnの時計を維持する。`turn_end`、失敗、renderer終了で停止する。
- Worker Session schema v5へnullableな手動titleを追加した。v1〜v4はtitleなしで読み、turn commit、model変更、
  `/rename <title>`の次のdurable writeでv5へ移行する。
- `/rename`はtyped presentation intentからcurrent persistent SessionのHost-owned handleへ到達する。busy中は
  modelへ送らずready待ちとし、引数なしでは変更なし、`--no-session`では利用不可とする。
- Session pickerはUTC分単位の更新日時とtitle、短縮ID・turn数・resume状態の二行表示へ変更し、一覧から
  provider/model/effortを外した。保存とresume時のmodel selection復元は変更していない。
- README、roadmapのF01/F05と現行production TUI記述を更新し、採用項目を通常利用メモから移した。

## 検証結果

- focused TUI test: 32件成功。busy時計の開始・分/時表示・停止、二行picker、renameのidle/busy/
  no-session動作、slash parseを確認した。
- Worker foundation test: 42件成功。typed adapterからのrename、schema v5保存、revision更新、busy拒否、
  turn commitとresume後のtitle保持を確認した。
- model/provider persistenceのfocused test: Increment 12の3件、Increment 14の10件、Increment 15の6件が成功した。
- 初回差分reviewとgate後、利用者の通常利用で、`/rename`追加により全slash候補が80列footerを超えると
  command候補segment全体が省略されるregressionを確認した。利用可能幅で候補をellipsis表示するよう修正し、
  `/`入力時にcredential状態との併記でも`cmds:`と`/rename`が残るfocused testを追加した。
- 初回のauthoritative `v0:gate`は成功したが、上記の利用者観測に基づくproduct修正で候補が変わったため、
  その具体的理由によるcorrection `v0:gate`を実行した。最終候補でtype check、196 filesのformat、193 filesのlint、
  offline 147 testsが再び通過し、未解決findingはない。live providerとreal-TTYは対象外のため実行していない。
