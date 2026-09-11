package extensions

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/patriceckhart/zot/packages/agent/extproto"
)

type startWriter struct{ write func([]byte) (int, error) }

func (w startWriter) Write(p []byte) (int, error) { return w.write(p) }
func (w startWriter) Close() error                { return nil }

func addStartExtension(t *testing.T, m *Manager, name string, response func(extproto.EventInterceptFromHost) string) *Extension {
	t.Helper()
	log, err := os.CreateTemp(t.TempDir(), "log")
	if err != nil {
		t.Fatal(err)
	}
	reader, writer := io.Pipe()
	ext := &Extension{Manifest: Manifest{Name: name}, logFile: log, readyCh: make(chan struct{}), pendingIntercept: map[string]chan extproto.EventInterceptResponseFromExt{}, interceptSubs: map[string]struct{}{}, eventSubs: map[string]struct{}{}}
	ext.stdin = startWriter{write: func(p []byte) (int, error) {
		var ev extproto.EventInterceptFromHost
		if err := json.Unmarshal(p, &ev); err != nil {
			return 0, err
		}
		_, err := io.WriteString(writer, response(ev)+"\n")
		return len(p), err
	}}
	m.mu.Lock()
	m.ext[name] = ext
	m.extOrder = append(m.extOrder, ext)
	m.mu.Unlock()
	done := make(chan struct{})
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	go func() { defer close(done); m.readLoop(ext, scanner) }()
	t.Cleanup(func() { writer.Close(); <-done; reader.Close(); log.Close() })
	if _, err := io.WriteString(writer, `{"type":"subscribe","intercept":["before_agent_start"]}`+"\n"+`{"type":"ready"}`+"\n"); err != nil {
		t.Fatal(err)
	}
	<-ext.readyCh
	return ext
}

func TestBeforeAgentStartResponses(t *testing.T) {
	for _, tc := range []struct {
		name, raw, want string
		warning         bool
	}{
		{"unchanged", `"base"`, "base", false},
		{"appended", `"base plus"`, "base plus", false},
		{"rewritten", `"BASE"`, "BASE", false},
		{"replaced", `"  völlig neu\n\n"`, "  völlig neu\n\n", false},
		{"empty", `""`, "", false},
		{"omitted", "", "base", false},
		{"null", "null", "base", true},
		{"number", "42", "base", true},
		{"object", "{}", "base", true},
		{"oversized", `"` + strings.Repeat("x", MaxSystemPromptResponseSize) + `"`, "base", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hooks := &stubHooks{}
			m := New(t.TempDir(), "/effective", "test", "provider", "model", hooks)
			ext := addStartExtension(t, m, "test", func(ev extproto.EventInterceptFromHost) string {
				if ev.Event != "before_agent_start" || ev.SystemPrompt == nil || *ev.SystemPrompt != "base" || ev.CWD != "/effective" || ev.SessionID != "session" || ev.AgentRunID != "run" || ev.Provider != "provider" || ev.Model != "model" {
					t.Errorf("wrong event metadata")
				}
				field := ""
				if tc.raw != "" {
					field = `,"system_prompt":` + tc.raw
				}
				return `{"type":"event_intercept_response","id":"` + ev.ID + `"` + field + `}`
			})
			base := "base"
			got := m.InterceptBeforeAgentStart(context.Background(), extproto.EventInterceptFromHost{SystemPrompt: &base, SessionID: "session", AgentRunID: "run", Model: "model"})
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
			ext.mu.Lock()
			warnings := len(ext.diagnostics)
			ext.mu.Unlock()
			if (warnings > 0) != tc.warning {
				t.Fatalf("warnings = %d", warnings)
			}
			hooks.mu.Lock()
			notifications := len(hooks.notifies)
			hooks.mu.Unlock()
			if (notifications > 0) != tc.warning {
				t.Fatalf("notifications = %d", notifications)
			}
		})
	}
}

func TestBeforeAgentStartChainsInLoadOrder(t *testing.T) {
	m := New(t.TempDir(), "", "test", "p", "m", nil)
	for _, name := range []string{"z-first", "a-second"} {
		addStartExtension(t, m, name, func(ev extproto.EventInterceptFromHost) string {
			raw, _ := json.Marshal(*ev.SystemPrompt + "/" + name)
			return `{"type":"event_intercept_response","id":"` + ev.ID + `","system_prompt":` + string(raw) + `}`
		})
	}
	for range 20 {
		base := "base"
		if got := m.InterceptBeforeAgentStart(context.Background(), extproto.EventInterceptFromHost{SystemPrompt: &base}); got != "base/z-first/a-second" {
			t.Fatal(got)
		}
	}
}

func TestBeforeAgentStartMalformedResponseTimesOut(t *testing.T) {
	hooks := &stubHooks{}
	m := New(t.TempDir(), "", "test", "p", "m", hooks)
	ext := addStartExtension(t, m, "bad", func(extproto.EventInterceptFromHost) string { return `{invalid` })
	addStartExtension(t, m, "good", func(ev extproto.EventInterceptFromHost) string {
		if *ev.SystemPrompt != "base" {
			t.Error("failed extension changed prompt")
		}
		return `{"type":"event_intercept_response","id":"` + ev.ID + `","system_prompt":"good"}`
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*interceptTimeout)
	defer cancel()
	base := "base"
	if got := m.InterceptBeforeAgentStart(ctx, extproto.EventInterceptFromHost{SystemPrompt: &base}); got != "good" {
		t.Fatalf("chain did not continue after timeout: %q", got)
	}
	ext.mu.Lock()
	pending := len(ext.pendingIntercept)
	ext.mu.Unlock()
	if pending != 0 {
		t.Fatal("pending request leaked")
	}
	hooks.mu.Lock()
	defer hooks.mu.Unlock()
	if len(hooks.notifies) != 1 || !strings.Contains(hooks.notifies[0], "timed out") {
		t.Fatalf("missing timeout warning: %v", hooks.notifies)
	}
}

func TestBeforeAgentStartBoundsBlockedWrite(t *testing.T) {
	m := New(t.TempDir(), "", "test", "p", "m", nil)
	log, err := os.CreateTemp(t.TempDir(), "log")
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	reader, writer := io.Pipe()
	defer reader.Close()
	ext := &Extension{stdin: writer, logFile: log, pendingIntercept: map[string]chan extproto.EventInterceptResponseFromExt{}}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	result := m.askIntercept(ctx, ext, extproto.EventInterceptFromHost{Event: "before_agent_start"})
	if result.failure == "" {
		t.Fatal("expected write timeout")
	}
	if _, err := writer.Write([]byte("x")); err == nil {
		t.Fatal("blocked pipe not closed")
	}
}
