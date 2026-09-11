package tui

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func testClipboardPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	img.Set(1, 0, color.RGBA{G: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestNormalizeClipboardImagePNGValidatesPNG(t *testing.T) {
	got, err := normalizeClipboardImagePNG(testClipboardPNG(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, format, err := image.Decode(bytes.NewReader(got)); err != nil || format != "png" {
		t.Fatalf("decoded format = %q, err = %v", format, err)
	}
}

func TestNormalizeClipboardImagePNGConvertsJPEG(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, img, nil); err != nil {
		t.Fatal(err)
	}

	got, err := normalizeClipboardImagePNG(jpegData.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if _, format, err := image.Decode(bytes.NewReader(got)); err != nil || format != "png" {
		t.Fatalf("decoded format = %q, err = %v", format, err)
	}
}

func TestNormalizeClipboardImagePNGRejectsMalformedData(t *testing.T) {
	if _, err := normalizeClipboardImagePNG([]byte("not an image")); err == nil {
		t.Fatal("normalizeClipboardImagePNG accepted malformed data")
	}
}

func TestNormalizeClipboardImagePNGEnforcesLimits(t *testing.T) {
	data := testClipboardPNG(t)
	if _, err := normalizeClipboardImagePNGWithLimits(data, len(data)-1, 100, 1024); !errors.Is(err, errClipboardImageTooLarge) {
		t.Fatalf("input limit error = %v", err)
	}
	if _, err := normalizeClipboardImagePNGWithLimits(data, len(data), 3, 1024); !errors.Is(err, errClipboardImageTooLarge) {
		t.Fatalf("pixel limit error = %v", err)
	}
	if _, err := normalizeClipboardImagePNGWithLimits(data, len(data), 100, 1); !errors.Is(err, errClipboardImageTooLarge) {
		t.Fatalf("output limit error = %v", err)
	}
}

func TestWriteClipboardPNGFileUsesRestrictivePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows FileMode permission bits do not represent ACL access")
	}
	path := filepath.Join(t.TempDir(), "clipboard.png")
	if err := writeClipboardPNGFile(path, testClipboardPNG(t)); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got&0o077 != 0 {
		t.Fatalf("file permissions = %o, want no group or other access", got)
	}
}

func TestRunClipboardImageCommandSeparatesStderr(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test helper is a shell script")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "clipboard-image-test")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf payload\nprintf diagnostic >&2\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	got, err := runClipboardImageCommand("clipboard-image-test", 100)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "payload" {
		t.Fatalf("output = %q, want payload", got)
	}
}

func TestRunClipboardImageCommandCapsOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test helper is a shell script")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "clipboard-image-test")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf 'too much data'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	if _, err := runClipboardImageCommand("clipboard-image-test", 3); err == nil {
		t.Fatal("runClipboardImageCommand accepted oversized output")
	}
}
