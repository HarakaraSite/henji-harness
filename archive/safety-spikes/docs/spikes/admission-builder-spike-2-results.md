# Admission Builder Spike 2 結果

## 判定

Acceptance Human Gate前。全gateは2回成功したが、最終独立再reviewでaccepted outcomeのcross-binding
を完全検証できないP1を確認したため`NO-GO`である。Proposal本体がaccepted outcomeに存在せず、
`candidate.proposalId`をsealed authorityから再導出できないためDiscoveryへ戻る。candidate artifact、
legacy plugin、AI/provider、current、DeploymentStateは実行・変更していない。

## Requirement evidence

| 契約                         | 実装                                                 | 直接証拠                                                                             |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| sealed IDだけのingress       | `admission_request.ts`                               | raw/path/ticket/artifact field injection rejection                                   |
| host-owned Grantとexpiry     | `admission_grant.ts`, `grant_store.ts`               | exact TTL、not-yet-valid、expiry boundary                                            |
| narrow TypeScript subset     | `subset_checker.ts`, `admission_profile.ts`          | allowlisted grammar、dependency/global/unknown node rejection、benign lookalike      |
| candidateを実行しないBuilder | `builder/main.ts`, `builder_process.ts`              | in-memory transpile、fixed argv、empty cwd、deny write/net/run/ffi/import            |
| bounded protocol/process     | `builder_protocol.ts`, `builder_process.ts`          | duplicate/UTF-8/trailing frame rejection、absolute timeoutとkill/reap                |
| environment isolation        | `builder_environment.ts`                             | exact 15名だけread permission、`clearEnv`、enumeration rejection、successful compile |
| create-only artifact         | `artifact_store.ts`                                  | hard-link new/same-idempotent/different-byte race、read-back                         |
| bounded opaque state         | `admission_registry.ts`                              | malformed capacity rejection、constructor getter非評価、deep-copy                    |
| record binding/replay        | `admission_record.ts`, `admission_service.ts`        | 個別digest再導出、全Record field改変拒否、golden、replay。cross-bindingは未解決      |
| fixed TCB closure            | `check_module_graph.ts`, `check_builder_identity.ts` | offline graphとsource/dependency/runtime digest preflight                            |
| repository-local toolchain   | `bootstrap-deno-spike2.sh`                           | archive/binary checksum、fresh concurrent bootstrap、symlink sentinel                |

## Toolchain and identity

- Deno: `2.9.4`; V8: `15.0.245.2-rusty`; embedded TypeScript: `6.0.3`
- archive SHA-256: `111da5c05c240cfdc4340f234a0e3539d39dbcb6755221f19dcd60bacc8be5aa`
- executable SHA-256: `7d87b8a5225485ddea1786024f875b2b3422c31100ba11cb2e36b6125959e218`
- runtime domain digest: `sha256:a1f1c5e949bf50b2f81f3b1b72bf9417c712255a918170656081cc2d9af22d3d`
- preflight source digest: `sha256:0e239d81c5aab82fc438a3f0d7953434cbd3dd50f75cc8dbded46e7496844e04`
- builder source digest: `sha256:875bd1b5d0a57af7034017707b99e0ed49d4b3bc2709b1d464b8cf595fce8037`
- dependency digest: `sha256:2d93c541d76b24efe54a459e9ef33898011ed5953685ea3fc84fb49c3b142368`
- parser digest: `sha256:c51889cbf24dbbd7f48385f58766f83cac032bc51f472931496513ef28966199`
- compiler digest: `sha256:27b895d4f379edb78db738760a93194602744d47d50a691fc74710d7f8b8810b`
- compiler options digest: `sha256:1ff9b4a10f0681ca6b8ce23a808736517a6c0ae276e087561315ef9661cebffc`
- admission profile digest:
  `sha256:7c021c8fc9b6007108d0a98739381da9558f895d03778ea73b15bb23d8b12d2c`

これらはcheckout/cache absolute pathをpreimageへ含めない。behavior-defining
source変更時はsource、parser、 compiler、profileまたはruntime bindingを再計算する。

## Verification

- scoped check: 成功
- offline module graph / identity preflight: 成功
- restricted-permission unit tests: 114件×2成功（exact 15 env名だけallow）
- process/filesystem integration tests: 19件×2成功
- explicit bootstrap tests: 2件成功
- scoped lint 32 files / format 35 files / `git diff --check`: 成功

レビュー修正の直接証拠として、caller-owned Candidate/Grant/Artifact Indexのpost-call mutation隔離、
不正・extra TCB identityでBuilder/publish 0、accepted candidateの個別digest再導出、nested
revision改変拒否、Record全field改変拒否、複合failure precedenceを確認した。一方、descendant
digestを整合させたcross-binding改変と実際のabort/cancelは未観測である。
`record_invalid`は先行するschema/trusted値検証後に有効な注入経路がなく、registry write failure時の
orphan artifactとregister/current/deployment counterを代替の直接証拠とした。

## Deviations

- TypeScript 6.0.3はimport時に15個のenv名を読む。Human Gate承認済みplan-deltaとして、そのexact
  15名だけをpermission allowlistにし、`clearEnv: true`で全値を未設定にする。
- Deno 2.9.4の`cache`/`info`には`--cached-only`がない。取得taskだけnetworkを許し、通常`run/test`は
  `--cached-only --frozen`、`check/info`は`--deny-import --no-remote --frozen`を使う。
- 一度、外側の`deno task`を専用`DENO_DIR`なしで起動し、共有Deno cacheへTypeScript downloadが
  発生した可能性がある。共有状態は勝手に削除せず、以後の全commandで外側にも専用`DENO_DIR`を指定した。

## Remaining risks

- parser/preflightはSupervisor process内で、OS-level CPU/memory隔離を持たない。
- Builderはtrusted TCBであり、candidate sandboxではない。
- filesystem observationはcreate-only/no-overwriteまでで、crash
  durability、ACL、multi-hostを保証しない。
- registryはSpike 2専用in-memory storeで、production persistence、署名、PKIを持たない。
- artifactとruntimeで実行されるobjectのsame-object保証、artifact behavior/resource/runtime
  authorityは Spike 3まで未観測。
- bootstrap path検査後に同一uid adversaryがpath componentを交換するraceはdirfd/openat2を使わず、
  threat model外である。
