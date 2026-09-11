# Skill-only extension fixture

This is a standalone extension bundle containing only filesystem-backed skills.
It has no executable and therefore does not start a subprocess.

Test it from the repository root with:

```bash
go run ./cmd/zot --no-ext --ext ./examples/skills/extension-fixture
```

Run `/skills` in zot. The discovered names are:

- `demo-tools:writing-git-commits` — namespace plus path-derived name
- `demo-tools:secret-review` — namespace plus explicit frontmatter name
