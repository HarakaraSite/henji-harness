package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

func TestRPCRejectsMutationsDuringPromptPreparation(t *testing.T) {
	models := provider.ModelsForProvider("anthropic")
	if len(models) < 2 {
		t.Fatal("need two catalog models")
	}
	modelJSON, err := json.Marshal(map[string]string{"model": models[1].ID})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		command string
		raw     []byte
	}{
		{"clear", nil},
		{"set_model", modelJSON},
		{"set_reasoning", []byte(`{"reasoning":"max"}`)},
	} {
		t.Run(tc.command, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			client := &startCaptureClient{}
			ag := core.NewAgent(client, models[0].ID, "base", nil)
			entered := make(chan struct{})
			ag.BeforeStart = func(ctx context.Context, system string) string {
				close(entered)
				<-ctx.Done()
				return "stale replacement"
			}
			var out bytes.Buffer
			s := &rpcServer{ctx: ctx, agent: ag, provider: "anthropic", model: ag.Model, out: &out}
			t.Cleanup(func() { cancel(); s.inFlight.Wait() })
			s.dispatch("prompt", "prompt-1", []byte(`{"message":"hello"}`))
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("preparation did not start")
			}
			dispatched := make(chan struct{})
			go func() { defer close(dispatched); s.dispatch(tc.command, "mutation", tc.raw) }()
			select {
			case <-dispatched:
			case <-ctx.Done():
				t.Fatal("mutation blocked the RPC read loop")
			}
			s.writeMu.Lock()
			responses := append([]byte(nil), out.Bytes()...)
			s.writeMu.Unlock()
			var rejected bool
			for _, line := range bytes.Split(responses, []byte("\n")) {
				if len(line) == 0 {
					continue
				}
				var response struct {
					ID      string
					Success bool
					Error   string
				}
				if err := json.Unmarshal(line, &response); err != nil {
					t.Fatal(err)
				}
				if response.ID == "mutation" {
					rejected = !response.Success && strings.Contains(response.Error, "busy")
				}
			}
			// Abort must remain usable while the hook waits. Wait before inspecting
			// agent fields so the test itself does not race with prompt preparation.
			s.dispatch("abort", "abort-1", nil)
			s.inFlight.Wait()
			if !rejected {
				t.Errorf("mutation should return a busy error: %s", responses)
			}
			if ag.Model != models[0].ID || ag.Reasoning != "" || len(ag.Messages()) != 1 {
				t.Fatal("busy mutation changed active agent state")
			}
			if ag.System != "base" || len(client.requests) != 0 {
				t.Fatal("canceled hook result reached model")
			}
			// The same command succeeds when idle; the next preparation uses current
			// state rather than marking the canceled extension response as prepared.
			s.dispatch(tc.command, "idle-mutation", tc.raw)
			switch tc.command {
			case "clear":
				if len(ag.Messages()) != 0 {
					t.Fatal("idle clear failed")
				}
			case "set_model":
				if ag.Model != models[1].ID {
					t.Fatal("idle model change failed")
				}
			case "set_reasoning":
				if ag.Reasoning != "max" {
					t.Fatal("idle reasoning change failed")
				}
			}
			ag.BeforeStart = func(_ context.Context, base string) string {
				if base != "base" {
					t.Error("stale prompt became base")
				}
				return "fresh replacement"
			}
			s.runPrompt("prompt-2", "again", nil)
			if len(client.requests) != 1 || client.requests[0].System != "fresh replacement" || client.requests[0].Model != ag.Model {
				t.Fatal("next prompt did not use freshly prepared state")
			}
		})
	}
}

func TestRPCRejectsMutationsWhileTurnLockHeld(t *testing.T) {
	// The same lock covers active model/tool work and compaction, not just
	// preparation. Rejection must not depend on activeCancel being populated.
	var out bytes.Buffer
	s := &rpcServer{agent: core.NewAgent(nil, "model", "base", nil), out: &out}
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	s.dispatch("clear", "1", nil)
	if !strings.Contains(out.String(), `"success":false`) || !strings.Contains(out.String(), "busy") {
		t.Fatalf("missing busy response: %s", out.String())
	}
}
