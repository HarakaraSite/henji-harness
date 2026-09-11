//go:build !darwin && !linux && !windows

package tui

func ReadClipboardImagePNG() (string, []byte, bool, error) {
	return "", nil, false, nil
}
