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
  2件を正本へ反映し、同じreviewerによる差分再reviewで全件解消、新しいBlocker/P1なしと確認した。設計一式は
  commit `a27b3be0`で保存した。Increment 32は利用者承認済み個別計画に沿って実装、focused test、第三者差分review、
  authoritative `v0:gate` 1回、compiled binaryの実provider run/real-TTY/Session復元受入まで完了し、実装差分を
  commitした。利用者の明示指示によりcompiled artifactを`~/.local/bin/henji`へinstallし、旧shell launcherは
  `~/.local/bin/henji.pre-standalone-launcher`へ退避した。利用者は別workspaceの既存Session exact復元、native Skill
  発見、repository調査のtool実行がinstalled binaryで成立することを確認した。
- 次: Increment 33の個別計画を作成する。architecture・roadmapの実装状態更新は正本変更として別途承認を得る。
- 正本:
  `docs/architecture/henji-host-agent-worker.md`、`docs/roadmap.md`のIncrement 32〜34、
  `docs/increments/increment-32.md`。現行の検討資料は
  `docs/roadmap-inputs/increment-32-34-externalization-concept-plan.md`。当初案と初回reviewの履歴は
  `docs/roadmap-inputs/increment-32-33-initial-plan-review.md`。参照実装比較の背景資料は
  `docs/research/externalization-reference-comparison.md`。
- 注意: Increment 32はstandalone binaryとresource共通identity・配置境界、Increment 33は最初のmanaged kindで
  あるAgent Definition、Increment 34はDefinition transportである。tool等の他resource kindは33のlocal基盤後に
  個別Incrementで扱い、34を必須前提にしない。`--definition <path>`はIncrement 32で廃止し、外部sourceを
  Increment 33以降のinstall inputに限定する。自然言語resourceのnative discoveryにinstallを要求しない。MCPは
  32〜34の実装範囲外であり、managed化の採否とclient等の物理配置は後続Integration Incrementで決める。Increment 32の
  production受入中に見つかったcompiled manifestのproperty-order誤拒否とheadless→TUI state mode衝突は修正・focused
  検証・追加第三者review済みである。installed binary置換とcommitは実施済み。push、publishは未実施。
