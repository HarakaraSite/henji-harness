//go:build darwin

package tui

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const readClipboardImageScript = `
on run argv
	set outPath to item 1 of argv
	try
		set imgData to the clipboard as «class PNGf»
		set imgKind to "png"
	on error
		try
			set imgData to the clipboard as «class TIFF»
			set imgKind to "tiff"
		on error
			return "NO_IMAGE"
		end try
	end try

	set outFile to POSIX file outPath
	set fileRef to open for access outFile with write permission
	try
		set eof of fileRef to 0
		write imgData to fileRef
		close access fileRef
	on error errMsg number errNum
		try
			close access fileRef
		end try
		error errMsg number errNum
	end try
	return imgKind
end run
`

func ReadClipboardImagePNG() (string, []byte, bool, error) {
	dir := clipboardImageDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", nil, false, fmt.Errorf("create clipboard image directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", nil, false, fmt.Errorf("secure clipboard image directory: %w", err)
	}
	path := filepath.Join(dir, "clipboard-"+time.Now().Format("20060102-150405")+"-"+randomHex(4)+".png")
	rawPath := path + ".raw"
	defer os.Remove(rawPath)

	kind, err := writeClipboardImageData(rawPath)
	if err != nil {
		return "", nil, false, err
	}
	if kind == "" {
		return "", nil, false, nil
	}

	sourcePath := rawPath
	if kind != "png" && kind != "tiff" {
		var ok bool
		sourcePath, ok = findClipboardImagePath(kind)
		if !ok {
			return "", nil, false, fmt.Errorf("unexpected clipboard image kind %q", kind)
		}
	}
	raw, err := readClipboardImageFile(sourcePath)
	if err != nil {
		return "", nil, false, fmt.Errorf("read clipboard image: %w", err)
	}
	data, err := normalizeClipboardImagePNG(raw)
	if err != nil {
		return "", nil, false, fmt.Errorf("invalid clipboard image: %w", err)
	}
	if err := writeClipboardPNGFile(path, data); err != nil {
		return "", nil, false, fmt.Errorf("write clipboard PNG: %w", err)
	}
	return path, data, true, nil
}

func writeClipboardImageData(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/osascript", "-e", readClipboardImageScript, path)
	out, err := cmd.CombinedOutput()
	trimmed := strings.TrimSpace(string(out))
	if ctx.Err() != nil {
		return "", fmt.Errorf("osascript timed out: %w", ctx.Err())
	}
	if err != nil {
		if strings.Contains(trimmed, "NO_IMAGE") || strings.Contains(trimmed, "Can’t make") || strings.Contains(trimmed, "Can't make") {
			return "", nil
		}
		if kind, ok := clipboardImageKind(trimmed); ok {
			return kind, nil
		}
		if path, ok := findClipboardImagePath(trimmed); ok {
			return path, nil
		}
		if trimmed == "" {
			return "", fmt.Errorf("osascript failed: %w", err)
		}
		return "", fmt.Errorf("osascript failed: %s", trimmed)
	}
	if trimmed == "NO_IMAGE" {
		return "", nil
	}
	if kind, ok := clipboardImageKind(trimmed); ok {
		return kind, nil
	}
	return trimmed, nil
}

func clipboardImageKind(s string) (string, bool) {
	for _, line := range strings.Split(s, "\n") {
		switch strings.TrimSpace(line) {
		case "png":
			return "png", true
		case "tiff":
			return "tiff", true
		}
	}
	return "", false
}

func findClipboardImagePath(s string) (string, bool) {
	if p, ok := clipboardImagePath(s); ok {
		return p, true
	}
	for _, ext := range []string{".png", ".tiff", ".tif"} {
		lower := strings.ToLower(s)
		end := strings.Index(lower, ext)
		if end < 0 {
			continue
		}
		end += len(ext)
		start := strings.LastIndex(s[:end], "/")
		if start < 0 {
			continue
		}
		for start > 0 {
			c := s[start-1]
			if c == '\'' || c == '"' || c == '\n' || c == '\r' || c == '\t' {
				break
			}
			start--
		}
		if p, ok := clipboardImagePath(s[start:end]); ok {
			return p, true
		}
	}
	return "", false
}

func clipboardImagePath(s string) (string, bool) {
	p := strings.TrimSpace(s)
	p = strings.Trim(p, "'\"")
	if p == "" {
		return "", false
	}
	info, err := os.Stat(p)
	if err != nil || info.IsDir() {
		return "", false
	}
	switch strings.ToLower(filepath.Ext(p)) {
	case ".png", ".tif", ".tiff":
		return p, true
	default:
		return "", false
	}
}

func clipboardImageDir() string {
	if info, err := os.Stat("/tmp"); err == nil && info.IsDir() {
		return filepath.Join("/tmp", "zot-clipboard-images")
	}
	return filepath.Join(os.TempDir(), "zot-clipboard-images")
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
