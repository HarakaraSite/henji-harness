# Portable launch and startup orientation results

## Scope and status

Step 81 is implemented against the approved plan
(`docs/plans/portable-launch-startup-orientation.md`, SHA-256
`6000e27210305845032e74f2ccecc04ce1c03b6f6c1e84e30beed673ea251a09`). The documented normal TUI
entry is:

```text
deno task --quiet --config deno.v0.json agent:tui
```

It requires exact Deno 2.9.4 on `PATH`, a POSIX shell, a repository-root working directory, and a
real stdin/stdout TTY. The launcher resolves an absolute regular executable with `command -v`,
performs one sanitized version preflight, and retains the existing child permission envelope.
No fixed checkout path is stored in the portable command, launcher, or portable test leaf.

## Requirement evidence

- `v0/agent/startup_orientation.ts` owns the pure, deeply frozen, secret-free projection. It
  bounds canonical state to 1,024 UTF-8 bytes, workspace labels to 96 bytes, and skill display to
  the first five names plus an omitted count. It projects the validated built-in Agent, provider
  profile, session mode, instruction source, fixed trust boundary, and the exact
  `before_each_provider_request` policy.
- Instruction source and formatted text come from one accepted filesystem snapshot. Runtime
  projects display state once after resolved-manifest validation and before model/registry
  materialization; prepared and materialized compositions retain the same state object.
- The TUI renders the exact twelve logical startup lines before the existing session/replay line
  and controller input. Dynamic values pass through terminal escaping. Current submit, steer,
  follow-up, cancel, and exit keys are shown; deferred surfaces are not advertised.
- Startup runtime tests observe display projection, model/registry materialization, credential reads,
  and provider fetch starts at zero for invalid Definition/resource/manifest paths. Persistent TUI
  matrices additionally observe unchanged state trees, no terminal acquisition/output, and no store
  mutation; valid CLI/TUI compositions correlate all common display fields. Existing request-time
  credential reread, cancellation, failure, session cleanup, replay, and trusted-local Bash behavior
  remain covered by their prior suites.
- The portable PTY test copies the tracked config and `v0/` tree into `/tmp`, uses a temporary PATH
  `deno` shim backed by the exact test-process executable, reaches the complete orientation before
  input, and proves a `workspace> ` value cannot masquerade as the live prompt. Launcher cases cover
  missing, wrong-version, nonregular, and nonexecutable resolutions, a plausible 2.9.4 probe with a
  nonzero status, sanitized raw probe/path failures, and zero child spawn. It performs no provider
  request or credential access.

## Verification

Focused suites passed:

- startup orientation: 8/8
- portable launcher PTY/process: 2/2
- runtime: 51/51
- instruction discovery: 9/9
- session launcher process regression: 3/3
- persistent session/TUI lifecycle: 9/9
- TUI direct/process/topology: 68/68, 25/25, 4/4
- offline topology: 2/2

The full offline `v0:test` chain and authoritative `v0:gate` passed 591/591, with topology 2/2,
`v0:check`, `v0:fmt`, and `v0:lint` green; `git diff --check` also passed. During verification,
one initial gate run hit a known non-reproducing PTY process-status race (24/25); the filtered case,
complete PTY suite (25/25), and subsequent authoritative gate all passed. The approved closure
evidence covers all four implementation-review P2s. The single narrow changed-lines re-review
confirmed all four Closed and returned GO, Blocker/P1/P2 zero. The owner independently reran
orientation 8/8, portable PTY 2/2, runtime 51/51, persistent session/TUI 9/9, and the authoritative
`v0:gate` 591/591.

## Boundaries and residual risk

The separately approved representative human acceptance was consumed exactly once in a disposable
checkout and state root. With credential env unset, the documented default-autosave command rendered
all twelve orientation lines, reached the ready prompt, accepted only empty Ctrl-D, exited 0, and
emitted bracketed-paste disable, SGR/reset, scroll-region reset, and cursor-show restoration
controls. Session JSON, per-session lock, and temporary-file counts were zero; only the shared index
lock and empty workspace directories existed before the disposable root was removed. No retry or
rerun occurred.

No provider, external network, credential value/file, production task, actual persistent product
state, dependency/lockfile, or `_refs/` operation was used. The reviewed increment is recorded by
the user-authorized final integration commit; push, tag, publish, and release remain unperformed.
The default work tools remain trusted-local OS-user execution without a hard sandbox. Deno versions
other than 2.9.4 and terminals narrower than the documented 80x24 support boundary remain
explicitly unsupported or truncated as described in the plan. The representative human acceptance
Human Gate is complete.

Independent review and final owner disposition: GO, Blocker/P1/P2 zero.
