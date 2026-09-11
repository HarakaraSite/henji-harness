package skills

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSplitFrontmatter(t *testing.T) {
	in := "---\nname: foo\ndescription: bar\n---\nbody text\n"
	front, body := splitFrontmatter(in)
	if front != "name: foo\ndescription: bar" {
		t.Errorf("front = %q", front)
	}
	if body != "body text\n" {
		t.Errorf("body = %q", body)
	}

	front2, body2 := splitFrontmatter("no frontmatter here")
	if front2 != "" || body2 != "no frontmatter here" {
		t.Errorf("expected pass-through, got front=%q body=%q", front2, body2)
	}
}

func TestParseFrontmatter(t *testing.T) {
	front := `name: code-review
description: "Review a recent change."
disable-model-invocation: true
allowed-tools: [read, bash]
permissions:
  bash: ["git diff*", "git log*"]
`
	s := &Skill{}
	parseFrontmatter(front, s)
	if s.Name != "code-review" {
		t.Errorf("name = %q", s.Name)
	}
	if s.Description != "Review a recent change." {
		t.Errorf("description = %q", s.Description)
	}
	if !s.DisableModelInvocation {
		t.Error("disable-model-invocation was not parsed")
	}
	if got := s.AllowedTools; len(got) != 2 || got[0] != "read" || got[1] != "bash" {
		t.Errorf("allowed-tools = %v", got)
	}
	if got := s.Permissions["bash"]; len(got) != 2 || got[0] != "git diff*" || got[1] != "git log*" {
		t.Errorf("permissions[bash] = %v", got)
	}
}

func TestDiscoverProjectAndGlobalPriorityAndDedup(t *testing.T) {
	t.Setenv("ZOT_AGENT_SKILLS", "")
	tmp := t.TempDir()
	zotHome := filepath.Join(tmp, "home")
	cwd := filepath.Join(tmp, "proj")

	mk := func(dir, name, desc string) {
		full := filepath.Join(dir, name)
		os.MkdirAll(full, 0o755)
		body := "---\nname: " + name + "\ndescription: " + desc + "\n---\n# " + name + "\n"
		os.WriteFile(filepath.Join(full, "SKILL.md"), []byte(body), 0o644)
	}

	// Same skill name in BOTH project and global; project should win.
	mk(filepath.Join(cwd, ".zot", "skills"), "shared", "project version")
	mk(filepath.Join(zotHome, "skills"), "shared", "global version")
	// Unique skill in global only.
	mk(filepath.Join(zotHome, "skills"), "global-only", "from global")

	skills, errs := Discover(zotHome, cwd, "", true /* includeUser */)
	if len(errs) > 0 {
		t.Fatalf("errs: %v", errs)
	}
	// Expect the two user skills + every built-in shipped with the
	// binary (currently the write-zot-extension authoring guide).
	builtins := loadBuiltins()
	want := 2 + len(builtins)
	if len(skills) != want {
		t.Fatalf("expected %d skills (2 user + %d built-in), got %d (%v)", want, len(builtins), len(skills), skills)
	}
	shared := FindByName(skills, "shared")
	if shared == nil || shared.Description != "project version" {
		t.Errorf("expected project to win for 'shared', got %v", shared)
	}
	if FindByName(skills, "global-only") == nil {
		t.Errorf("global-only skill missing")
	}
	// At least one built-in should have made it through.
	for _, b := range builtins {
		if FindByName(skills, b.Name) == nil {
			t.Errorf("built-in skill %q missing from Discover output", b.Name)
		}
	}
}

func TestDiscoverWithoutUserSkillsStillIncludesBuiltins(t *testing.T) {
	got, errs := Discover("", "", "", false)
	if len(errs) != 0 {
		t.Fatalf("errs: %v", errs)
	}
	for _, builtin := range loadBuiltins() {
		if FindByName(got, builtin.Name) == nil {
			t.Errorf("built-in skill %q missing", builtin.Name)
		}
	}
}

func TestKebabCase(t *testing.T) {
	cases := map[string]string{
		"writing-git-commits": "writing-git-commits",
		"Writing Git Commits": "writing-git-commits",
		"git_commits":         "git-commits",
		"git.commits":         "git-commits",
		"Git/Commits":         "git-commits",
	}
	for in, want := range cases {
		if got := KebabCase(in); got != want {
			t.Errorf("KebabCase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDiscoverSourcesFollowsSymlinkedRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory symlinks require elevated privileges on Windows")
	}

	target := t.TempDir()
	path := filepath.Join(target, "nested", "review")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte("---\ndescription: linked\n---\nbody"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "skills")
	if err := os.Symlink(target, root); err != nil {
		t.Fatal(err)
	}

	got, errs := DiscoverSources([]Source{{Root: root, Prefix: "linked:"}}, false)
	if len(errs) != 0 || len(got) != 1 || got[0].Name != "linked:nested-review" {
		t.Fatalf("skills=%#v errs=%v", got, errs)
	}
}

func TestDiscoverSourcesRecursiveAndPrefixed(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "Something", "Writing Git Commits")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "---\ndescription: nested\n---\nbody"
	if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	got, errs := DiscoverSources([]Source{{Root: root, Label: "extension Git Tools", Prefix: "git-tools:"}}, false)
	if len(errs) != 0 {
		t.Fatalf("errs: %v", errs)
	}
	if len(got) != 1 || got[0].Name != "git-tools:something-writing-git-commits" {
		t.Fatalf("skills = %#v", got)
	}
	if got[0].Source != "extension Git Tools" || got[0].Body != "body" {
		t.Errorf("skill metadata = %#v", got[0])
	}
}

func TestDiscoverSourcesDuplicateDiagnostic(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	for _, root := range []string{a, b} {
		dir := filepath.Join(root, "review")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: review\n---\nbody"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, errs := DiscoverSources([]Source{{Root: a}, {Root: b}}, false)
	if len(got) != 1 || len(errs) != 1 || !strings.Contains(errs[0].Error(), "shadowed") {
		t.Fatalf("got=%#v errs=%v", got, errs)
	}
}

func TestVisibleSkillsHidesBuiltins(t *testing.T) {
	in := []*Skill{
		{Name: "user-one"},
		{Name: "built-one", Builtin: true},
		{Name: "user-two"},
	}
	out := VisibleSkills(in)
	if len(out) != 2 {
		t.Fatalf("expected 2 visible skills, got %d (%v)", len(out), out)
	}
	for _, s := range out {
		if s.Builtin {
			t.Errorf("built-in %q leaked into visible set", s.Name)
		}
	}
}

func TestSystemPromptAddendum(t *testing.T) {
	skills := []*Skill{
		{Name: "built-a", Description: "Do A.", Builtin: true},
		{Name: "user-b", Description: "Do B.", Path: "/tmp/skills/user-b/SKILL.md"},
		{Name: "manual-c", Description: "Do C.", DisableModelInvocation: true},
	}
	out := SystemPromptAddendum(skills)
	if !contains(out, "- built-a [builtin]: Do A.\n") {
		t.Errorf("builtin entry missing or wrong:\n%s", out)
	}
	if !contains(out, "- user-b [/tmp/skills/user-b/SKILL.md]: Do B.\n") {
		t.Errorf("user entry missing path pointer:\n%s", out)
	}
	if contains(out, "manual-c") {
		t.Errorf("manual skill leaked into system prompt:\n%s", out)
	}
}

func TestSystemPromptAddendumEmptyWhenAllSkillsDisableModelInvocation(t *testing.T) {
	out := SystemPromptAddendum([]*Skill{{Name: "manual", DisableModelInvocation: true}})
	if out != "" {
		t.Fatalf("SystemPromptAddendum() = %q, want empty", out)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || (len(sub) > 0 && stringIndex(s, sub) >= 0))
}

func stringIndex(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
