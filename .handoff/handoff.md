# Handoff

## Records

### Increment 14〜17 複数provider設計

- 状態: 横断architectureとIncrement 15計画は承認済み。Increment 14に続き、同一Sessionの`/provider`、
  provider-scoped `/model`・`/effort`、provider横断Host/Worker切替、固定footer表示を実装した。real-provider
  preflight、offline test、第三者review、authoritative gateに加え、Session `a338621b`でproduction TUIの
  OpenRouter → OpenAI → OpenRouterとevidence readbackまで完了した。変更は未commitである。
- 次: 利用者の指示後にIncrement 15の変更をcommitする。
- 正本: `docs/architecture/multi-provider-routing-and-auth.md`
- 実装記録: `docs/increments/increment-14.md`、`docs/increments/increment-15.md`
- 注意: API key値は記録しない。OpenAI built-in Web searchの採否は実装時に別途検討する。Increment 16以降はまだ
  実装認可されていない。認証statusとslash command登録の改善候補は`docs/experience/normal-use-inbox.md`にある。
