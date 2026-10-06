# JSR publish procedure

## Purpose

Publish a reviewed Henji Harness source snapshot from this repository to
[`@henji/harness`](https://jsr.io/@henji/harness). Forgejo and JSR are separate publication
destinations: pushing `main` does not update JSR automatically.

This procedure publishes the API declared by [`jsr.json`](../../jsr.json). The current package
exports the tool factory API through [`mod.ts`](../../mod.ts) and the hook API through
[`hook_api.ts`](../../v0/agent/hook_api.ts); the development CLI and TUI are not package
entrypoints.

## Operator boundary

The agent performs repository checks, version/document updates, tests, the JSR dry run, commit and
push, creation of the clean release worktree, starting and waiting for `deno publish`, published
package verification, and temporary-worktree cleanup.

The user performs every interactive authentication and browser action:

1. Complete any browser challenge.
2. Sign in to JSR through the intended provider and account.
3. Confirm that the account is an administrator of the `@henji` scope.
4. Confirm the package name and exact version on the authorization page.
5. Press **Approve**.

The agent does not enter a password, one-time code, or other authentication material. If the browser
shows the wrong JSR account, do not approve; sign out and authenticate with the scope-admin account.

## Prepare the release source

1. Finish the intended product changes and choose the next SemVer value in `jsr.json`. Pre-release
   updates use a new value such as `0.1.0-alpha.2`; an already published version is never reused.
2. Update the version shown in the JSR installation and import examples in `README.md`.
3. If `mod.ts` or its transitive imports changed, update `publish.include` in `jsr.json` so every
   required source file is present and unrelated development material remains excluded.
4. Run the repository's authoritative offline gate once on the release candidate:

   ```sh
   henji_deno=$(command -v deno)
   "$henji_deno" task --config deno.v0.json v0:gate
   ```

5. Commit the release preparation, push `main`, and verify that local and remote identify the same
   commit:

   ```sh
   git push origin main
   git fetch origin main
   test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
   ```

Publishing must use this pushed commit, not a changing development worktree.

## Create and verify a clean release worktree

Run these commands from the repository root:

```sh
release_version=$(jq -r .version jsr.json)
release_commit=$(git rev-parse HEAD)
release_dir=$(mktemp -d "/tmp/henji-harness-jsr-${release_version}.XXXXXX")
rmdir "$release_dir"
git worktree add --detach "$release_dir" "$release_commit"
test -z "$(git -C "$release_dir" status --porcelain)"
```

Keep this shell open through verification and cleanup so `release_version`, `release_commit`, and
`release_dir` continue to identify the same release.

Run JSR's complete validation without uploading anything:

```sh
henji_deno=$(command -v deno)
cd "$release_dir"
"$henji_deno" publish --dry-run --config jsr.json
```

Read the simulated package name, version, and full file list. Do not continue if they differ from
the intended release. Fix ordinary slow-type diagnostics by making the existing public type
explicit; do not bypass them with `--allow-slow-types`. The clean worktree also avoids using
`--allow-dirty` for an actual release.

## Publish

From the same clean worktree and with the same Deno binary, run:

```sh
"$henji_deno" publish --config jsr.json
```

Interactive authentication requires a terminal. In a headless environment, start the command under a
PTY (tmux or an equivalent); without one Deno stops with `No means to authenticate` before
authorization begins.

The command prints a short-lived `https://jsr.io/auth?...` URL and waits. Open that URL in the
user's browser, then stop for the user actions listed in **Operator boundary**. After the user
presses **Approve**, keep the command running until it reports both successful authorization and
successful publication.

Do not start a second publish attempt merely because the browser or package page is slow to update.
First inspect the waiting command and JSR package metadata.

## Verify the published package

Read the registry metadata and confirm that the exact version is present:

```sh
curl -fsS -H 'Accept: application/json' \
  https://jsr.io/@henji/harness/meta.json | jq .
```

Then import the exact version from JSR rather than from the release worktree. Immediately after a
release, the development Deno may apply its minimum-dependency-age policy, so set it to zero only
for this verification:

```sh
"$henji_deno" eval --no-config --no-lock --min-dep-age=0 \
  --reload="jsr:@henji/harness" \
  'import * as harness from "jsr:@henji/harness@VERSION";
   if (Object.keys(harness).length === 0) throw new Error("package has no exports");
   console.log(Object.keys(harness).sort());'
```

Replace `VERSION` with the exact published version. For a pre-release, JSR may show no `latest`
version; successful resolution of the exact version is the relevant result.

## Clean up

After registry metadata and the real import both succeed, return to the development repository and
remove only the temporary worktree recorded in `release_dir`:

```sh
cd /home/masat.guest/src/henji-harness
git worktree remove "$release_dir"
test ! -e "$release_dir"
```

Do not remove or alter the development worktree or its untracked `_refs/` material. A Git tag is not
required by JSR; create one only when a separate repository release policy calls for it.

## Immutable-version rule

JSR versions are immutable. If a published version has a problem, do not try to overwrite or delete
its files. Yank it when appropriate, fix the repository, choose a new version, and repeat this
procedure.

## References

- [JSR: Publishing packages](https://jsr.io/docs/publishing-packages)
- [JSR: Packages and versions](https://jsr.io/docs/packages)
- [JSR package configuration](https://jsr.io/docs/package-configuration)

## 0.8.0 publication — 2026-10-01 JST

Published [`@henji/harness@0.8.0`](https://jsr.io/@henji/harness@0.8.0) at the user's request. The
published source is pushed commit `fda1e17fb000bb3d562b30026d7dab4c81cee42c`.

- Updated the version in `jsr.json`, both README examples, and the `mod.ts` example. Added
  `v0/agent/history/history_v7_model.ts` to `publish.include` after JSR validation identified it as
  a required module missing from the published graph.
- The authoritative offline `v0:gate` passed once. The clean detached release worktree's
  `deno publish --dry-run --no-lock --config jsr.json` passed with exactly the 88 configured files.
  Type checking and slow-type validation were enabled.
- The user approved browser authorization. The waiting PTY command reported
  `Successfully published @henji/harness@0.8.0`.
- Registry metadata confirmed `latest: 0.8.0` and the version's creation timestamp
  `2026-09-30T22:35:33.260021Z`. A registry import of `jsr:@henji/harness@0.8.0`, run outside the
  repository with `--no-config --no-lock --min-dep-age=0 --reload=jsr:@henji/harness`, loaded all
  eight runtime exports successfully.
- Removed the temporary clean release worktree after verification. The existing local binary remains
  the previously deployed `henji 0.7.0`; this request published the JSR package.

Verification logs: `/tmp/henji-jsr-0.8.0-gate.log`, `/tmp/henji-jsr-0.8.0-dry-run.log`,
`/tmp/henji-jsr-0.8.0-published-meta.json`, and `/tmp/henji-jsr-0.8.0-published-import.log`.

## 0.9.0 publication — 2026-10-05 JST

Published [`@henji/harness@0.9.0`](https://jsr.io/@henji/harness@0.9.0) at the user's request after
accepting Increment 191. The published source is pushed commit
`cab0404971daf17b69e0140d9b557bf34072657c`.

- Updated `jsr.json` and both README exact-version examples; verified both public entrypoint graphs.
  The authoritative `v0:gate` passed once (645 tests, no failures), and the clean detached release
  worktree's dry run passed with the 59 configured files. Type and slow-type checks were enabled.
- After the first authorization expired, confirmed that its publisher had exited and 0.9.0 was
  absent from the registry before starting a replacement. The user approved browser authorization,
  and the waiting PTY command reported `Successfully published @henji/harness@0.9.0`.
- Registry metadata confirmed `latest: 0.9.0`, with creation timestamp
  `2026-10-05T02:57:42.796650Z`. A consumer outside both repositories ran
  `deno run --check --no-config --no-lock --min-dep-age=0 --reload=jsr:@henji/harness`, importing
  the exact-version tool and hook entrypoints from JSR. Both public factory types checked; seven
  tool runtime exports, both hook runtime exports, and the six hook phases loaded successfully.
- Removed the clean release worktree after verification. The accepted native binary remains the
  Increment 191 deployment (`henji 0.8.0`); this request published the JSR package.

Verification logs are stored in the ignored `.tools/jsr-0.9.0/` directory: `gate.log`,
`clean-dry-run.log`, `publish.log`, `published-meta.json`, and `published-import.log`.

## 0.10.0 publication — 2026-10-07 JST

The user requested version 0.10.0 and JSR publication after accepting Increment 207. Release
preparation updates `jsr.json` and the exact-version examples in `README.md` and `README.ja.md`.
The accepted native binary remains the Increment 207 deployment (`henji 0.9.0`).

The authoritative `v0:gate` passed once on the release candidate (691 tests, no failures; the gate
was run with `HOME` set, which the runtime path resolution requires). The first gate attempt without
`HOME` failed 12 tests with `invalid HOME`. After setting `HOME`, two tests still failed because
`tests/v0/agent_worker_foundation_test.ts` and `tests/v0/increment_127_external_agents_test.ts`
asserted the pre-Increment-206 wording of the `search` and `git_inspect` guidelines, which Increment
206 replaced in the external tool definitions. Preparation updated those expectations to the
current adopted text; the focused re-run of both files passed 31 tests.

The preparation dry run passed with the 59 configured files for `@henji/harness@0.10.0`, including
both public entrypoints and slow-type checking, and the clean detached release worktree at the
pushed commit passed the same dry run.

The user approved browser authorization, and the waiting PTY command (an isolated tmux server,
socket `jsr010`) reported `Authorization successful. Authenticated as HarakaraSite` and
`Successfully published @henji/harness@0.10.0`.

Registry metadata confirmed `latest: 0.10.0` with creation timestamp
`2026-10-06T21:35:08.085714Z`. Outside the repository, `deno eval --no-config --no-lock
--min-dep-age=0 --reload=jsr:@henji/harness` imported the exact version: the tool entrypoint loaded
seven runtime exports, and the hooks entrypoint loaded `HOOK_API_CONTRACT` and `HOOK_PHASES`.
`deno check` of `ToolFactory`, `ToolFactoryInput`, and `HookFactory` from the exact version passed.

Removed the clean release worktree after verification. At publication time the accepted native
binary was the Increment 207 deployment (`henji 0.9.0`); a later user request rebuilt and deployed
the native binary as 0.10.0 (see [native 0.10.0 deployment](native-0.10.0-deployment.md)).

Verification logs are stored in the ignored `.tools/jsr-0.10.0/` directory (`gate.log`,
`gate-home.log`, `gate-release.log`, `focused-tests.log`, `pre-dry-run-dirty.log`) and in
`/tmp/henji-jsr-0.10.0-dry-run.log`.
