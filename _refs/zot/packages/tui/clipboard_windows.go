//go:build windows

package tui

import (
	"errors"
	"fmt"
	"os/exec"
)

const readClipboardImagePowerShell = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) { exit 3 }
$stream = New-Object System.IO.MemoryStream
try {
    $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
} finally {
    $stream.Dispose()
    $image.Dispose()
}
`

// ReadClipboardImagePNG reads the Windows desktop clipboard through the
// PowerShell installation included with supported Windows versions. STA mode
// is required by the Windows Forms clipboard API.
func ReadClipboardImagePNG() (string, []byte, bool, error) {
	return readWindowsClipboardImagePNG(runClipboardImageCommand)
}

func readWindowsClipboardImagePNG(run func(string, int, ...string) ([]byte, error)) (string, []byte, bool, error) {
	commands := []string{"powershell.exe", "pwsh.exe"}
	var lastErr error
	found := false
	for _, name := range commands {
		data, err := run(name, maxClipboardImageBytes,
			"-NoProfile", "-NonInteractive", "-STA", "-Command", readClipboardImagePowerShell)
		if errors.Is(err, errClipboardImageCommandUnavailable) {
			continue
		}
		found = true
		if clipboardHasNoImageExit(err) {
			return "", nil, false, nil
		}
		if err != nil {
			lastErr = err
			continue
		}
		pngData, err := normalizeClipboardImagePNG(data)
		if err != nil {
			return "", nil, false, fmt.Errorf("invalid clipboard image: %w", err)
		}
		return "", pngData, true, nil
	}
	if found && lastErr != nil {
		return "", nil, false, fmt.Errorf("read image clipboard: %w", lastErr)
	}
	return "", nil, false, nil
}

func clipboardHasNoImageExit(err error) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == 3
}
