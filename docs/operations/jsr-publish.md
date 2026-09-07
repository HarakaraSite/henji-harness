# JSR publish procedure

## Purpose

Publish a reviewed Henji Harness source snapshot from this repository to
[`@henji/harness`](https://jsr.io/@henji/harness). Forgejo and JSR are separate publication
destinations: pushing `main` does not update JSR automatically.

This procedure publishes the API declared by [`jsr.json`](../../jsr.json). The current package
exports the Agent Definition composition API through [`mod.ts`](../../mod.ts); the development CLI
and TUI are not package entrypoints.

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
   henji_deno=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
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
henji_deno=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
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
"$henji_deno" eval --no-config --minimum-dependency-age=0 \
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
