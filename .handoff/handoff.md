# Handoff

## Records

### Increment 14〜17 複数provider設計

- 状態: 横断architecture承認済み。Increment 14のgeneric route、OpenAI direct Responses adapter、route別認証、Session
  v4、evidence、startup provider選択を実装し、offline testと第三者reviewを完了した。OpenAI credential不在のため実provider
  callだけ未確認。
- 次: `/home/masat.guest/.config/henji-harness/openai-api-key`を用意した後、OpenAI rootのproduction TUIでtext、tool
  continuation、OpenRouter plannerまたはSonar併用、evidence readbackを確認する。その後Increment 15の同一Session
  provider切替を計画する。
- 正本: `docs/architecture/multi-provider-routing-and-auth.md`
- 実装記録: `docs/increments/increment-14.md`
- 注意: OpenAI built-in Web searchの採否は実装時に別途検討する。Increment 15以降はまだ実装認可されていない。
