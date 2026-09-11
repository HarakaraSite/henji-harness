# Handoff

## Records

### Increment 32以降 — standalone配布とmanaged externalization

- 状態: Henji全体の外部化対象をmanaged revision候補、既存external input/state、binary側platform authority、
  追加architecture判断が必要な対象へ分類し、Increment 32〜34と後続resource-kind Incrementの段階計画を
  統合資料へ保存した。Definition中心案と全体taxonomyをそれぞれ第三者reviewし、指摘を反映した。さらにPi、
  Zot、DeepSeek Harness、OpenComputer、Cloudflare Agents、Cloudflare Sandbox SDKの固定snapshotと分類を照合し、
  共通root graph、binding identity、resource候補、mutable instance state、直交属性を更新した。最新の参照実装
  反映差分は未reviewである。利用者は統合資料の提案を採用し、direct-path Definitionを残さないこと、
  Increment 34のtransportを採用して他resource外部化の前提にはしないこと、自然言語resourceのsource-native
  形式とnative zero-install discoveryを維持してmanaged envelopeを追加経路にすることを決めた。managed Skill、
  Henji独自Instruction、workspace `AGENTS.md`を別authorityとし、MCPもnative connectionへinstallを要求せず、
  connection、credential、server、runtime capability、実行recordを分離する案を統合資料へ反映した。
  利用者の承認を受け、externalization taxonomyと共通identity/authority、native discovery、MCP境界、Increment
  32〜34、Definition transportをarchitecture・roadmap正本へ反映した。最新差分の第三者reviewで得たP1 2件、P2
  2件を正本へ反映し、同じreviewerによる差分再reviewで全件解消、新しいBlocker/P1なしと確認した。個別Increment
  計画と実装は未承認である。
- 次: Increment 32の個別計画を`docs/increments/`へ正本化し、利用者の実装承認を得る。
- 正本:
  `docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`の「Self-revision
  Cycle 1前段 — 配布とDefinition revision基盤」。現行の検討資料は
  `docs/roadmap-inputs/increment-32-34-externalization-concept-plan.md`。当初案と初回reviewの履歴は
  `docs/roadmap-inputs/increment-32-33-initial-plan-review.md`。参照実装比較の背景資料は
  `docs/research/externalization-reference-comparison.md`。
- 注意: Increment 32はstandalone binaryとresource共通identity・配置境界、Increment 33は最初のmanaged kindで
  あるAgent Definition、Increment 34はDefinition transportである。tool等の他resource kindは33のlocal基盤後に
  個別Incrementで扱い、34を必須前提にしない。`--definition <path>`はIncrement 32で廃止し、外部sourceを
  Increment 33以降のinstall inputに限定する。自然言語resourceのnative discoveryにinstallを要求しない。MCPは
  32〜34の実装範囲外であり、managed化の採否とclient等の物理配置は後続Integration Incrementで決める。統合資料は
  承認済みincrement正本ではない。実装、test、provider E2E、commit、push、publishは未許可・未実施。
