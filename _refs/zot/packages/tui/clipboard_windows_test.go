//go:build windows

package tui

import (
	"errors"
	"slices"
	"testing"
)

func TestReadWindowsClipboardImagePNGUsesSTAAndNormalizes(t *testing.T) {
	var gotName string
	var gotArgs []string
	run := func(name string, _ int, args ...string) ([]byte, error) {
		gotName = name
		gotArgs = append([]string(nil), args...)
		return testClipboardPNG(t), nil
	}

	path, data, ok, err := readWindowsClipboardImagePNG(run)
	if err != nil {
		t.Fatal(err)
	}
	if path != "" || !ok || len(data) == 0 {
		t.Fatalf("path = %q, ok = %v, len(data) = %d", path, ok, len(data))
	}
	if gotName != "powershell.exe" {
		t.Fatalf("command = %q, want powershell.exe", gotName)
	}
	if !slices.Contains(gotArgs, "-STA") {
		t.Fatalf("PowerShell args do not enable STA: %q", gotArgs)
	}
}

func TestReadWindowsClipboardImagePNGTriesPwshFallback(t *testing.T) {
	var commands []string
	run := func(name string, _ int, _ ...string) ([]byte, error) {
		commands = append(commands, name)
		if name == "powershell.exe" {
			return nil, errors.New("Windows PowerShell failed")
		}
		return testClipboardPNG(t), nil
	}

	_, _, ok, err := readWindowsClipboardImagePNG(run)
	if err != nil || !ok {
		t.Fatalf("ok = %v, err = %v", ok, err)
	}
	if !slices.Equal(commands, []string{"powershell.exe", "pwsh.exe"}) {
		t.Fatalf("commands = %q", commands)
	}
}

func TestReadWindowsClipboardImagePNGRejectsMalformedData(t *testing.T) {
	run := func(string, int, ...string) ([]byte, error) {
		return []byte("not an image"), nil
	}
	if _, _, ok, err := readWindowsClipboardImagePNG(run); err == nil || ok {
		t.Fatalf("ok = %v, err = %v", ok, err)
	}
}
