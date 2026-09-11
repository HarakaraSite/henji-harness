package modes

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

type preparationCaptureClient struct{ requests chan provider.Request }

func (*preparationCaptureClient) Name() string { return "test" }
func (c *preparationCaptureClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	select {
	case c.requests <- req:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	events := make(chan provider.Event, 1)
	events <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "ok"}}}}
	close(events)
	return events, nil
}

func TestAutoSwarmToggleDuringPromptPreparation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := &preparationCaptureClient{requests: make(chan provider.Request, 1)}
	ag := core.NewAgent(client, "model", "base", nil)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	calls := 0
	ag.BeforeStart = func(ctx context.Context, system string) string {
		calls++
		if calls == 1 {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
			}
			return "stale replacement"
		}
		return system + "/extension"
	}
	i := &Interactive{agent: ag, cfg: InteractiveConfig{AutoSwarmSystemAddendum: "swarm instructions"}}
	var runErr error
	go func() { defer close(done); runErr = ag.Prompt(ctx, "hello", nil, nil) }()
	t.Cleanup(func() { cancel(); <-done })
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("hook did not start")
	}
	i.applyAutoSwarmSystemPrompt(true)
	close(release)
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("prompt did not finish")
	}
	if runErr != nil {
		t.Fatal(runErr)
	}
	if calls != 2 {
		t.Fatalf("preparation calls = %d, want 2", calls)
	}
	select {
	case req := <-client.requests:
		if req.System != "base\n\nswarm instructions/extension" {
			t.Fatalf("provider received stale prompt: %q", req.System)
		}
	default:
		t.Fatal("provider was not called")
	}
	if ag.BaseSystem() != "base\n\nswarm instructions" {
		t.Fatal("rebuild base was lost")
	}
}

func TestAutoSwarmToggleAfterPreparationBeforeModelCall(t *testing.T) {
	client := &preparationCaptureClient{requests: make(chan provider.Request, 1)}
	ag := core.NewAgent(client, "model", "base", nil)
	i := &Interactive{agent: ag, cfg: InteractiveConfig{AutoSwarmSystemAddendum: "swarm instructions"}}
	calls := 0
	ag.BeforeStart = func(_ context.Context, system string) string {
		calls++
		return system + "/extension"
	}
	// Simulate a settings change while the turn-start guard runs, after
	// initial preparation but before the provider request is constructed.
	ag.BeforeTurn = func(int) (bool, string) {
		i.applyAutoSwarmSystemPrompt(true)
		return true, ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ag.Prompt(ctx, "hello", nil, nil); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("preparation calls = %d, want 2", calls)
	}
	select {
	case req := <-client.requests:
		if req.System != "base\n\nswarm instructions/extension" {
			t.Fatalf("provider received unprepared prompt: %q", req.System)
		}
	default:
		t.Fatal("provider was not called")
	}
}

func TestAutoSwarmRebuildsBasePromptBeforeExtensions(t *testing.T) {
	ag := core.NewAgent(nil, "model", "base", nil)
	calls := 0
	ag.BeforeStart = func(ctx context.Context, system string) string {
		calls++
		if strings.Contains(system, "extension") {
			t.Fatal("replacement fed back into extension")
		}
		return system + "/extension"
	}
	ag.BeforeTurn = func(int) (bool, string) { return false, "test" }
	i := &Interactive{agent: ag, cfg: InteractiveConfig{AutoSwarmSystemAddendum: "swarm instructions"}}
	prepare := func() {
		t.Helper()
		if err := ag.Continue(context.Background(), nil); err != nil {
			t.Fatal(err)
		}
	}
	prepare()
	i.applyAutoSwarmSystemPrompt(true)
	prepare()
	if !strings.Contains(ag.System, "swarm instructions") || calls != 2 {
		t.Fatal("toggle did not rebuild prompt")
	}
	i.applyAutoSwarmSystemPrompt(true)
	prepare()
	if calls != 2 {
		t.Fatal("unchanged toggle reapplied extensions")
	}
	i.applyAutoSwarmSystemPrompt(false)
	prepare()
	if strings.Contains(ag.System, "swarm instructions") || calls != 3 {
		t.Fatal("toggle did not remove instructions")
	}
}
