# Handoff

## Records

### Increment 14〜17 複数provider設計

- 状態: 横断architectureは承認済み。Increment 14と15は実装・検証・review・production確認を完了し、
  Increment 15を`075d17f`でcommitした。Increment 16は計画承認後、built-in instruction component、Worker/direct
  runtimeへの共通composer接続、manifest identity、focused product test、第三者review、authoritative
  `v0:gate`まで完了した。reviewはBlocker/P1なしで、handoffの古い状態だけをP2として指摘し本Recordで解消した。
  gateはtype check、format、lint、全125 testが成功した。利用者はOpenAI rootからplanner委譲、rootのREADME read、
  最終要約までのproduction経路を確認し、Increment 16は完了した。
- 次: 利用者の明示依頼があればIncrement 16の変更をcommitする。
- 正本: `docs/architecture/multi-provider-routing-and-auth.md`
- 実装記録: `docs/increments/increment-14.md`、`docs/increments/increment-15.md`、
  `docs/increments/increment-16.md`
- 注意: API key値は記録しない。OpenAI built-in Web searchの採否は実装時に別途検討する。認証status、slash
  command登録、F24 instruction revisionの改善候補は`docs/experience/normal-use-inbox.md`にある。`_refs/`配下の
  未追跡directoryは利用者所有であり、Increment 16へ含めない。
