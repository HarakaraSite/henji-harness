package tui

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

var errClipboardImageCommandUnavailable = errors.New("clipboard image command is unavailable")

// runClipboardImageCommand keeps binary stdout separate from diagnostics and
// caps both streams. Clipboard utilities can be controlled by another process,
// so neither their output size nor their run time is trusted.
func runClipboardImageCommand(name string, maxOutput int, args ...string) ([]byte, error) {
	path, err := exec.LookPath(name)
	if err != nil {
		return nil, errClipboardImageCommandUnavailable
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var stdout, stderr cappedBuffer
	stdout.max = maxOutput
	stderr.max = maxClipboardDiagnosticBytes
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	if stdout.overflow {
		return nil, fmt.Errorf("%s output exceeds %d bytes", name, maxOutput)
	}
	if err != nil {
		diagnostic := strings.TrimSpace(stderr.String())
		if diagnostic == "" {
			return nil, fmt.Errorf("%s failed: %w", name, err)
		}
		if stderr.overflow {
			diagnostic += " (truncated)"
		}
		return nil, fmt.Errorf("%s failed: %w: %s", name, err, diagnostic)
	}
	return append([]byte(nil), stdout.Bytes()...), nil
}
