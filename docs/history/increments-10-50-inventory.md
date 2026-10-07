# Increment 10〜50の文書整理調査

## 対象と利用者判断

利用者の「じゃあの残そうか　インクリメント50まで調査して」に基づく調査。
前の棚卸しで「残す」とした計画文書8ファイルは、現在位置に残す。
今回の対象はIncrement 10〜50。2〜9はすでにアーカイブ済みであり、再調査・再移動しない。
調査後、利用者の「17はもう新しい実装になってるので不要」「アーカイブ候補38ファイルはアーカイブしよう」により、
17を含む38ファイルをアーカイブした。29・37は現在位置に残す。文書の削除は行わない。
構想・architecture・roadmap、通常利用メモ、handoff、実装・設定も変更しない。

## 結論

- 調査時点の対象は40ファイル、6,860行。各文書は計画と結果を一つに保持する。
  移動後は履歴に38ファイル、`docs/increments/`に29・37の2ファイルを保持する。
- 36の文書はこのdirectoryにない。欠番を未完了incrementと解釈せず、他の保存先・Git履歴の調査は行っていない。
- **アーカイブ済み：38ファイル、6,594行。** 調査の分類と利用者の移動指示に基づく。
  移動先は`docs/history/increments/`。
  調査だけで完了した17・49も含み、runtime実装完了や全受入条件の達成へ格上げしない。
- **現在位置に保留：29・37の2ファイル、266行。** 通常利用メモが未採用候補の根拠として直接リンクしているため。
  product作業が進行中という意味ではなく、参照先の置き場所を維持する整理判断である。
- 後続increment・research・roadmap-inputsからの参照も、移動後のpathへ更新した。
  文書の意味・当時の要件・判断・実行証拠は変更していない。

## 確認方法と限界

- 対象40ファイルのcurrent本文を直接取得し、タイトル、ステータス、冒頭、全見出し、末尾を確認した。
  24、29、32〜35、37〜38、40〜43、49〜50は、中間の実装結果・checkpoint・受入／検証・完了判断も追加確認した。
  これは文書整理の調査であり、40ファイルすべての要件本文を逐語的に精査したという意味ではない。
- Git管理下と非ignoreの未追跡Markdown／TypeScript／JavaScript／JSON／shell／Pythonから、対象ファイル名の
  文字列参照を走査した。表の直接参照は走査時点のsourceと行番号を示す。
- ファイル名に加えて、roadmap、architecture、通常利用メモ、operations、conceptsで
  `Increment N`等の番号参照も別に検索した。範囲表記の全番号や略記を機械的に網羅したとはしない。
- 当時のprovider実行・data・binaryを再実行・再readbackしていない。完了や受入は文書記載の確認である。
  現行コードの機能状態、旧仕様の全置換先、外部repositoryの参照は今回の確認対象外。

## 完了記録を読む際の注意

1. **10**はlocal実装・検証・review・gate完了。production CLI基本E2Eの記録は後続11にある。
2. **17**はChatGPT subscription経路のfeasibility調査を完了し、当時のruntime実装は延期した。
   後続163がこの記録へ直接リンクしている。旧判断を現在のChatGPT実装状態と混同しない。
   利用者は新しい実装があるため現在文書として不要と判断した。削除せず旧調査としてアーカイブした。
3. **19**はSSH先terminalでblinkが見えず、直接SGR 5も点滅しなかった観測を利用者がterminal制約と判断して受入れた。
   点滅表示を全terminalで実証した記録ではない。
4. **24**はretryのfocused確認と通常利用完遂をもって利用者が完了と判断した。
   productionで自然発生5xxからのretryは未観測と明記されている。
5. **29**は当時の機械的tool-result省略とautomatic compactionを停止した記録。
   これを現在のcompaction全体の仕様として転用しない。通常利用メモの候補から直接参照されている。
6. **35→47**では`/new`の空Session先行保存を後から廃止している。
   35の当時の即時durability要件と47の後続変更を、矛盾解消のために本文を書き換えず両方保持する。
7. **37**は当初期待したsource選択のHuman Gateを満たしていない。
   利用者がrepository context課題を別候補へ分離し、観測・instruction変更までを成果として完了と判断した。
   通常利用メモが未達の証拠・判断の正本として直接参照している。
8. **38→39**ではrecall受入中に観測したcancel cleanup failureを39で別修正した。
   recall成功とcancel不具合を混同せず履歴を残す。
9. **40〜44・50**は当時のSQLite schema・journal・history viewと、その後の整理・正規化の記録。
   当時のraw常設保存、旧command、検索・export仕様、schemaを現在の仕様へ格上げしない。
   特に40のgate終了code回収欠落、50の最終修正後のfocused確認等の検証範囲は原文どおり保持する。
10. **49**はstorage amplificationの調査でruntime変更なし。
    末尾の「実装候補は未採用」は当時の記録であり、50の根拠・Verification・容量観測が49の調査を明示的に参照している。
    49を現在の独立した承認待ち作業と推定しない。

## 番号のみの参照

直接リンク以外にも、次の現行文書が対象incrementを履歴・判断根拠として番号で参照している。
移動しても番号とファイル名は保持する。番号だけの記載を、ファイル名参照がないことを理由に削除しない。

- [roadmap](../roadmap.md)：32〜34のstandalone／Definition基盤、38のrecall、40〜44のdurable history等。
  32〜34については「実装済みの当時計画・受入境界の履歴」と明記されている。
- [provider/auth architecture](../architecture/multi-provider-routing-and-auth.md)：14〜17の経路・instruction・feasibilityの履歴。
- [Host/Worker architecture](../architecture/henji-host-agent-worker.md)：32のlogical/physical分離、38のrecall。
- [通常利用メモ](../experience/normal-use-inbox.md)：37の未達観測、32〜34の基盤等。

これらの正本は変更していない。移動に伴う正本の改訂が必要になれば、対象と意味上の差を別途提示する。

## 全件分類

タイトルとステータスは調査時の本文から抽出した。完了は現在機能の再検証ではない。
直接参照元の行番号は調査時点の記録であり、移動によるリンク更新後も参照の意味を保持する。
直接参照がないものにも、本文中の番号参照や外部参照がないことまでは保証しない。

| Increment | 内容（原文タイトル） | 行数 | 分類 | 原文ステータス | ファイル名の直接参照元 |
| --- | --- | ---: | --- | --- | --- |
| [10](increments/increment-10.md) | 非対話CLIのheadless Host / Worker統合 | 129 | アーカイブ済み | local実装・検証完了。2026-09-08に利用者が初期計画を承認し、第三者reviewと最終gateまで完了 | — |
| [11](increments/increment-11.md) | ユーザー起動型production CLI基本E2E | 257 | アーカイブ済み | Gate 1およびGate 2完了。production CLI基本E2E受入成功 | — |
| [12](increments/increment-12.md) | 同一Session内のOpenRouter model/effort切替 | 91 | アーカイブ済み | 完了 | — |
| [13](increments/increment-13.md) | provider deadlineと固定Session footer | 130 | アーカイブ済み | 完了（実装・offline検証・review・通常利用確認済み） | — |
| [14](increments/increment-14.md) | generic provider routeとOpenAI direct API | 111 | アーカイブ済み | **実装・offline検証・第三者review・OpenAI production通常利用確認完了** | — |
| [15](increments/increment-15.md) | 同一Session内のroot provider切替 | 165 | アーカイブ済み | **実装・検証・第三者review・production TUI user確認完了** | — |
| [16](increments/increment-16.md) | built-in instruction component | 126 | アーカイブ済み | **完了** | — |
| [17](increments/increment-17.md) | ChatGPT subscription root provider feasibility | 180 | アーカイブ済み | **feasibility gate完了、runtime実装は将来incrementへ延期** | [docs/increments/increment-163.md:272](../increments/increment-163.md), [docs/research/a1-chatgpt-subscription-provider.md:11](../research/a1-chatgpt-subscription-provider.md) |
| [18](increments/increment-18.md) | tool activityの意味的preview | 136 | アーカイブ済み | **完了** | — |
| [19](increments/increment-19.md) | busy activity indicator | 112 | アーカイブ済み | **完了。local実装・gateとproduction目視確認を完了し、2026-09-10に利用者が受け入れた** | — |
| [20](increments/increment-20.md) | source準拠instructionと入力前status | 169 | アーカイブ済み | **完了** | — |
| [21](increments/increment-21.md) | OpenRouter mixed text/tool-call互換性 | 137 | アーカイブ済み | **完了** | — |
| [22](increments/increment-22.md) | production SSE継続とlimit正本化 | 156 | アーカイブ済み | **完了** | — |
| [23](increments/increment-23.md) | 取得済み結果の再利用、調査終了、tool実行境界 | 148 | アーカイブ済み | **完了** | — |
| [24](increments/increment-24.md) | OpenRouter provider request retry | 101 | アーカイブ済み | **完了** | — |
| [25](increments/increment-25.md) | Bash workspace開始directoryの明示 | 109 | アーカイブ済み | **完了** | — |
| [26](increments/increment-26.md) | Compaction provider failure diagnostic | 104 | アーカイブ済み | **完了** | — |
| [27](increments/increment-27.md) | Retained TUI描画への一本化 | 129 | アーカイブ済み | **完了** | — |
| [28](increments/increment-28.md) | Busy経過時間とSession識別情報 | 89 | アーカイブ済み | **完了** | — |
| [29](increments/increment-29.md) | 自動context変換の停止 | 89 | 現在位置に保留 | **完了** | [docs/experience/normal-use-inbox.md:250](../experience/normal-use-inbox.md) |
| [30](increments/increment-30.md) | 履歴表示の一貫性と検索試行の取り下げ | 82 | アーカイブ済み | **完了** | — |
| [31](increments/increment-31.md) | セッション開始時のヘッダー充実 | 95 | アーカイブ済み | **完了** | — |
| [32](increments/increment-32.md) | standalone executableとexternalization共通境界 | 364 | アーカイブ済み | **完了 — 2026-09-11** | [docs/roadmap-inputs/increment-32-33-initial-plan-review.md:17](../roadmap-inputs/increment-32-33-initial-plan-review.md) |
| [33](increments/increment-33.md) | local managed Agent Definition revision | 383 | アーカイブ済み | **利用者確認済み・完了（2026-09-12）** | [docs/roadmap-inputs/increment-32-33-initial-plan-review.md:17](../roadmap-inputs/increment-32-33-initial-plan-review.md) |
| [34](increments/increment-34.md) | Definition revision transport | 234 | アーカイブ済み | **完了 — 利用者確認済み（2026-09-12）** | — |
| [35](increments/increment-35.md) | TUI `/new` Session creation | 183 | アーカイブ済み | **完了** | [docs/increments/increment-133.md:183](../increments/increment-133.md) |
| [37](increments/increment-37.md) | 外部情報調査のtool・source選択instruction | 177 | 現在位置に保留 | **完了（Human Gate実施・context課題を分離）** | [docs/experience/normal-use-inbox.md:294](../experience/normal-use-inbox.md) |
| [38](increments/increment-38.md) | stopped execution recall | 316 | アーカイブ済み | **完了（2026-09-12）** | — |
| [39](increments/increment-39.md) | cancellation stream settlement | 97 | アーカイブ済み | **完了** | — |
| [40](increments/increment-40.md) | destructive SQLite canonical history cutover | 354 | アーカイブ済み | **完了（計画承認、実装、test、production受入、差分review済み）** | [docs/roadmap-inputs/durable-history-and-context-rebuild.md:298](../roadmap-inputs/durable-history-and-context-rebuild.md) |
| [41](increments/increment-41.md) | durable active execution and live journal | 381 | アーカイブ済み | **完了（利用者承認、実装、検証、第三者review、production Human Gate完了）** | — |
| [42](increments/increment-42.md) | exact context attribution | 452 | アーカイブ済み | **完了（実装・検証・production Human Gate・第三者review完了）** | — |
| [43](increments/increment-43.md) | human history view | 373 | アーカイブ済み | **完了** | — |
| [44](increments/increment-44.md) | post-SQLite consistency and obsolete-code cleanup | 86 | アーカイブ済み | **完了（2026-09-13）** | — |
| [45](increments/increment-45.md) | native Skill description acceptance | 56 | アーカイブ済み | **完了（2026-09-13）** | — |
| [46](increments/increment-46.md) | TUI build version header | 52 | アーカイブ済み | **完了（2026-09-13）** | — |
| [47](increments/increment-47.md) | Temporary `/new` Session binding | 47 | アーカイブ済み | **完了（2026-09-13）** | — |
| [48](increments/increment-48.md) | Sole slash command completion | 49 | アーカイブ済み | **完了（2026-09-13）** | — |
| [49](increments/increment-49.md) | durable history storage amplification investigation | 99 | アーカイブ済み | **調査完了、runtime変更なし** | — |
| [50](increments/increment-50.md) | normalized history authority and active Session projection | 312 | アーカイブ済み | **完了（計画承認、実装、検証、production受入完了）** | — |

## 次の作業と意図した差分

- 8計画文書は現在位置に保持し、17を含む38ファイルのアーカイブを完了した。
  原文の全文・ファイル名・行数を保持し、移動に必要なMarkdownリンクの宛先だけを更新した。
- Increment 133・163、旧A1調査のリンク、およびroadmap-inputsの32・33・40への文書pointerを更新した。
  roadmap-inputsの3つのplain pathは移動後のpathを示すリンクにした。
- 原文の状態・要件・例・command・設定・schema・外部URL・証拠を変更していない。
  移動した文書内の当時の実装対象・保存先を示す旧pathは歴史的記録として保持した。
- 29・37を移動する場合は、通常利用メモの参照先も同時更新する方針を別に確認する。
- 今回は要約・分類に必要な詳細を省略し、各原文へのリンクを保持した。番号36を補完・創作していない。
- 移動前snapshotとの本文差分、38ファイルの存在・行数、相対リンク、旧pathへのMarkdownリンク残存、
  保留29・37の本文不変、空白エラーを確認する。
  実装変更がないためproduct test・gate・provider callは行わない。
