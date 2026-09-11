package modes

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/patriceckhart/zot/packages/agent/skills"
	"github.com/patriceckhart/zot/packages/tui"
)

func TestFuzzySkillSuggestions(t *testing.T) {
	s := newSlashSuggester()
	s.SetSkills([]*skills.Skill{
		{Name: "code-review", DisableModelInvocation: true},
		{Name: "review-code"},
		{Name: "aaa", Description: "review"},
		{Name: "review-builtin", Builtin: true},
	})
	check := func(query string, want ...string) {
		t.Helper()
		if got := commandNames(s.matches(query)); !slices.Equal(got, want) {
			t.Fatalf("matches(%q) = %v, want %v", query, got, want)
		}
	}
	check("/skill:review", "/skill:review-code")
	check("/skill:crv")
	s.SetFuzzySkills(true)
	check("/skill:review", "/skill:review-code", "/skill:code-review")
	check("/SKILL:CRV", "/skill:code-review")
	check("/skill:", "/skill:aaa", "/skill:code-review", "/skill:review-code")
	check("/skill:code-review", "/skill:code-review")
	check("/skill:zzz")
	check("/skill:skill") // The command prefix is not searched.
	check("/skill:review request")
	check("/x") // Other slash commands still require prefixes.
	s.SetExtra([]slashCommand{{Name: "/code-review"}})
	check("/review")
	s.Render("/skill:review", tui.Theme{}, 80)
	s.Down()
	if got := s.Selection("/skill:review"); got != "/skill:code-review" {
		t.Fatal(got)
	}
	s.SetFuzzySkills(false)
	check("/skill:review", "/skill:review-code")
	if s.cursor != 0 || s.lastMatches != nil {
		t.Fatal("toggle did not reset selection")
	}
	for _, c := range s.matches("/skill:") {
		if len(c.matchedIndexes) != 0 {
			t.Fatal("highlight leaked into catalog")
		}
	}
}

func TestFuzzySkillSuggestionExactName(t *testing.T) {
	s := newSlashSuggester()
	s.SetSkills([]*skills.Skill{{Name: "review-more"}, {Name: "review"}, {Name: "code-review"}})
	for _, enabled := range []bool{false, true} {
		s.SetFuzzySkills(enabled)
		if got := commandNames(s.matches("/SKILL:REVIEW")); !slices.Equal(got, []string{"/skill:review"}) {
			t.Fatalf("exact match with fuzzy=%v: %v", enabled, got)
		}
	}
	if _, recognized, err := expandSkillCommand("/skill:crv", []*skills.Skill{{Name: "code-review"}}); !recognized || err == nil {
		t.Fatal("invocation must still require an exact name")
	}
}

func TestFuzzySkillSuggestionTies(t *testing.T) {
	s := newSlashSuggester()
	s.SetSkills([]*skills.Skill{{Name: "bb-review"}, {Name: "aa-review"}})
	s.SetFuzzySkills(true)
	want := []string{"/skill:aa-review", "/skill:bb-review"}
	for range 10 {
		if got := commandNames(s.matches("/skill:review")); !slices.Equal(got, want) {
			t.Fatalf("ties = %v", got)
		}
	}
}

func TestFuzzySkillSuggestionHighlight(t *testing.T) {
	s := newSlashSuggester()
	s.SetSkills([]*skills.Skill{{Name: "pré-review"}, {Name: "pré-revise"}})
	s.SetFuzzySkills(true)
	for _, width := range []int{1, 20, 80} {
		lines := s.Render("/skill:Érv", tui.Theme{}, width)
		for row := range 2 {
			for _, char := range []string{"é", "r", "v"} {
				if !strings.Contains(lines[row], tui.Bold(char)) {
					t.Fatalf("missing emphasis for %q: %q", char, lines[row])
				}
			}
			if !strings.Contains(lines[row], "/skill:") {
				t.Fatalf("prefix was emphasized: %q", lines[row])
			}
		}
	}
}

type fuzzySkillSettingsStore struct {
	SettingsStore
	value bool
	err   error
}

func (s *fuzzySkillSettingsStore) SetFuzzySkillSuggest(value bool) error {
	if s.err != nil {
		return s.err
	}
	s.value = value
	return nil
}

func TestFuzzySkillSetting(t *testing.T) {
	// Exercise the normal repaint path, independent of the developer's terminal.
	t.Setenv("TERM_PROGRAM", "")
	for _, enabled := range []bool{false, true} {
		i := NewInteractive(InteractiveConfig{Terminal: &cleanupTestTerminal{}, FuzzySkillSuggest: &enabled})
		if i.suggest.fuzzySkills != enabled {
			t.Fatal("startup preference ignored")
		}
	}
	store := &fuzzySkillSettingsStore{}
	i := NewInteractive(InteractiveConfig{Terminal: &cleanupTestTerminal{}, SettingsStore: store})
	if i.suggest.fuzzySkills {
		t.Fatal("default must be off")
	}
	for _, value := range []bool{true, false} {
		i.applySettingToggle("fuzzy_skill_suggest", value)
		if store.value != value || i.suggest.fuzzySkills != value || i.cfg.FuzzySkillSuggest == nil || *i.cfg.FuzzySkillSuggest != value {
			t.Fatal("toggle was not applied and persisted")
		}
	}
	store.err = errors.New("save failed")
	i.applySettingToggle("fuzzy_skill_suggest", true)
	if i.suggest.fuzzySkills || *i.cfg.FuzzySkillSuggest || !strings.Contains(i.statusErr, "save failed") {
		t.Fatal("failed save changed live preference or hid error")
	}
}
