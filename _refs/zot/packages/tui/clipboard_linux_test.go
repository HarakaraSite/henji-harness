//go:build linux

package tui

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func writeFakeLinuxClipboard(t *testing.T, name, script string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(path))
}

func TestReadClipboardImagePNGWayland(t *testing.T) {
	fixture := filepath.Join(t.TempDir(), "image.png")
	want := testClipboardPNG(t)
	if err := os.WriteFile(fixture, want, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLIPBOARD_IMAGE_FIXTURE", fixture)
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	t.Setenv("DISPLAY", "")
	writeFakeLinuxClipboard(t, "wl-paste", `
if [ "$1" = "--list-types" ]; then
    printf 'text/plain\nimage/png\n'
else
    /bin/cat "$CLIPBOARD_IMAGE_FIXTURE"
fi
`)

	path, got, ok, err := ReadClipboardImagePNG()
	if err != nil {
		t.Fatal(err)
	}
	if path != "" || !ok {
		t.Fatalf("path = %q, ok = %v", path, ok)
	}
	if !bytes.Equal(got, want) {
		// Normalization may choose a different valid PNG representation, so
		// compare dimensions when the encoded bytes differ.
		if gotW, gotH := ImageDimensions(got); gotW != 2 || gotH != 2 {
			t.Fatalf("normalized image dimensions = %dx%d", gotW, gotH)
		}
	}
}

func TestReadClipboardImagePNGX11(t *testing.T) {
	fixture := filepath.Join(t.TempDir(), "image.png")
	if err := os.WriteFile(fixture, testClipboardPNG(t), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLIPBOARD_IMAGE_FIXTURE", fixture)
	t.Setenv("WAYLAND_DISPLAY", "")
	t.Setenv("DISPLAY", ":1")
	writeFakeLinuxClipboard(t, "xclip", `
if [ "$4" = "TARGETS" ]; then
    printf 'TARGETS\nimage/png\n'
else
    /bin/cat "$CLIPBOARD_IMAGE_FIXTURE"
fi
`)

	_, got, ok, err := ReadClipboardImagePNG()
	if err != nil {
		t.Fatal(err)
	}
	if !ok || len(got) == 0 {
		t.Fatalf("ok = %v, len(data) = %d", ok, len(got))
	}
}

func TestReadClipboardImagePNGNoImageFallsBack(t *testing.T) {
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	t.Setenv("DISPLAY", "")
	writeFakeLinuxClipboard(t, "wl-paste", `
if [ "$1" = "--list-types" ]; then
    printf 'text/plain;charset=utf-8\n'
    exit 0
fi
exit 9
`)

	_, data, ok, err := ReadClipboardImagePNG()
	if err != nil {
		t.Fatal(err)
	}
	if ok || data != nil {
		t.Fatalf("ok = %v, data = %v", ok, data)
	}
}

func TestReadClipboardImagePNGRejectsMalformedData(t *testing.T) {
	t.Setenv("WAYLAND_DISPLAY", "wayland-0")
	t.Setenv("DISPLAY", "")
	writeFakeLinuxClipboard(t, "wl-paste", `
if [ "$1" = "--list-types" ]; then
    printf 'image/png\n'
else
    printf 'not a png'
fi
`)

	if _, _, ok, err := ReadClipboardImagePNG(); err == nil || ok {
		t.Fatalf("ok = %v, err = %v", ok, err)
	}
}

func TestPreferredClipboardImageMIME(t *testing.T) {
	mime, ok := preferredClipboardImageMIME("text/plain\nimage/jpeg\nimage/png\n")
	if !ok || mime != "image/png" {
		t.Fatalf("mime = %q, ok = %v", mime, ok)
	}
	if mime, ok := preferredClipboardImageMIME("text/plain\ntext/html\n"); ok {
		t.Fatalf("mime = %q, want no image MIME", mime)
	}
}
