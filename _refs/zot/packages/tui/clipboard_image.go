package tui

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"os"

	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

const (
	maxClipboardImageBytes      = 32 << 20
	maxClipboardImagePixels     = 25_000_000
	maxNormalizedImageBytes     = 64 << 20
	maxClipboardMetadataBytes   = 1 << 20
	maxClipboardDiagnosticBytes = 16 << 10
)

var errClipboardImageTooLarge = errors.New("clipboard image is too large")

// normalizeClipboardImagePNG validates an image and converts it to PNG. The
// limits keep an untrusted clipboard owner from making zot allocate without
// bound while probing the clipboard.
func normalizeClipboardImagePNG(data []byte) ([]byte, error) {
	return normalizeClipboardImagePNGWithLimits(data, maxClipboardImageBytes, maxClipboardImagePixels, maxNormalizedImageBytes)
}

func normalizeClipboardImagePNGWithLimits(data []byte, maxInput, maxPixels, maxOutput int) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("clipboard image is empty")
	}
	if len(data) > maxInput {
		return nil, fmt.Errorf("%w (maximum input is %d bytes)", errClipboardImageTooLarge, maxInput)
	}

	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode clipboard image metadata: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxPixels/cfg.Height {
		return nil, fmt.Errorf("%w (maximum is %d pixels)", errClipboardImageTooLarge, maxPixels)
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode clipboard image: %w", err)
	}
	var out cappedBuffer
	out.max = maxOutput
	if err := png.Encode(&out, img); err != nil {
		return nil, fmt.Errorf("encode clipboard image as PNG: %w", err)
	}
	if out.overflow {
		return nil, fmt.Errorf("%w (maximum normalized size is %d bytes)", errClipboardImageTooLarge, maxOutput)
	}
	return append([]byte(nil), out.Bytes()...), nil
}

// cappedBuffer retains at most max bytes while reporting successful writes.
// Reporting the full write prevents child processes and encoders from failing
// with an unrelated short-write error after the configured limit is reached.
type cappedBuffer struct {
	buf      bytes.Buffer
	max      int
	overflow bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.max - b.buf.Len()
	if remaining > 0 {
		if remaining > len(p) {
			remaining = len(p)
		}
		_, _ = b.buf.Write(p[:remaining])
	}
	if remaining < len(p) {
		b.overflow = true
	}
	return n, nil
}

func (b *cappedBuffer) Bytes() []byte  { return b.buf.Bytes() }
func (b *cappedBuffer) String() string { return b.buf.String() }

func readClipboardImageFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxClipboardImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxClipboardImageBytes {
		return nil, fmt.Errorf("%w (maximum input is %d bytes)", errClipboardImageTooLarge, maxClipboardImageBytes)
	}
	return data, nil
}

func writeClipboardPNGFile(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}
