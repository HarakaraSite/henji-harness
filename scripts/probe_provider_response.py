#!/usr/bin/env python3
"""Capture a declared provider's real Henji request and response in isolated XDG.

Example:
  python3 scripts/probe_provider_response.py --provider opencode-go-chat \
    --model glm-5.3-flash

The script starts the production TUI. Enter one diagnostic task, then /exit.
Request bodies and response bodies remain in the printed output directory.
Authorization headers and credential values are not written there.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def write_private(path: Path, data: bytes) -> None:
    with path.open("xb") as output:
        output.write(data)


def handler_for(raw_dir: Path, upstream_origin: str, credential: bytes):
    opener = urllib.request.build_opener(NoRedirect())
    counter = 0
    counter_lock = threading.Lock()

    class ProbeHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.forward()

        def do_POST(self) -> None:
            self.forward()

        def forward(self) -> None:
            nonlocal counter
            with counter_lock:
                counter += 1
                ordinal = counter
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            replacement = b"[REDACTED_CREDENTIAL]"
            saved_request = body.replace(credential, replacement) if credential else body
            write_private(raw_dir / f"request-{ordinal}.body", saved_request)

            headers = {
                name: value
                for name, value in self.headers.items()
                if name.lower()
                not in {"host", "connection", "content-length", "transfer-encoding", "accept-encoding"}
            }
            headers["Accept-Encoding"] = "identity"
            request = urllib.request.Request(
                upstream_origin + self.path,
                data=body if self.command == "POST" else None,
                headers=headers,
                method=self.command,
            )
            try:
                with opener.open(request, timeout=180) as response:
                    status = response.status
                    content_type = response.headers.get("content-type", "application/octet-stream")
                    response_body = response.read()
            except urllib.error.HTTPError as error:
                status = error.code
                content_type = error.headers.get("content-type", "application/octet-stream")
                response_body = error.read()
            except urllib.error.URLError as error:
                status = 502
                content_type = "application/json"
                response_body = json.dumps({"probe_transport_error": type(error.reason).__name__}).encode()

            saved_response = (
                response_body.replace(credential, replacement) if credential else response_body
            )
            write_private(raw_dir / f"response-{ordinal}.body", saved_response)
            write_private(
                raw_dir / f"metadata-{ordinal}.json",
                (json.dumps({
                    "method": self.command,
                    "path": self.path,
                    "status": status,
                    "contentType": content_type,
                    "requestBytes": len(body),
                    "responseBytes": len(response_body),
                    "credentialRedacted": saved_request != body or saved_response != response_body,
                }, indent=2) + "\n").encode(),
            )
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)

        def log_message(self, _format: str, *_args: object) -> None:
            pass

    return ProbeHandler


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Capture a declared provider's real Henji request and response.",
        epilog=(
            "Example:\n"
            "  scripts/probe_provider_response.py --provider opencode-go-chat "
            "--model glm-5.3-flash\n\n"
            "Enter one diagnostic task in the TUI, then /exit. The probe uses isolated "
            "XDG state and buffers each response before forwarding it."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--provider", required=True, help="Existing declared provider ID")
    parser.add_argument("--model", help="Model ID; defaults to the declaration's selection")
    parser.add_argument("--effort", help="Effort; defaults to the selected model's default")
    parser.add_argument("--max-steps", type=int, default=2)
    parser.add_argument("--output", type=Path, help="New output directory (default: /tmp)")
    parser.add_argument("--henji", type=Path, default=Path(__file__).resolve().parents[1] / "dist/henji")
    args = parser.parse_args()
    if args.max_steps < 1:
        parser.error("--max-steps must be positive")
    source_config = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "henji-harness"
    declaration_path = source_config / "providers" / f"{args.provider}.json"
    if not declaration_path.is_file():
        parser.error(f"declared provider is unavailable: {declaration_path}")
    declaration = json.loads(declaration_path.read_text())
    if declaration.get("providerId") != args.provider:
        parser.error("provider ID does not match the declaration file")
    if declaration.get("protocol") not in {"openai-chat-completions", "openai-responses"}:
        parser.error("provider protocol is unsupported by this probe")
    endpoint = urlsplit(declaration["endpoint"])
    if (
        endpoint.scheme not in {"http", "https"}
        or not endpoint.netloc
        or endpoint.username
        or endpoint.password
        or endpoint.query
        or endpoint.fragment
    ):
        parser.error("provider endpoint is unsupported by this probe")
    model = args.model or declaration["defaults"]["modelId"]
    catalog = declaration["modelCatalog"]
    if catalog.get("kind") != "fixed":
        parser.error("this probe currently requires a fixed model catalog")
    entry = next((item for item in catalog["entries"] if item["modelId"] == model), None)
    if entry is None:
        parser.error(f"model is not in the provider catalog: {model}")
    effort = args.effort or (
        declaration["defaults"]["effort"]
        if model == declaration["defaults"]["modelId"]
        else entry["defaultEffort"]
    )
    if effort not in entry["efforts"]:
        parser.error(f"effort is not available for {model}: {effort}")
    credential_path = source_config / declaration["authProfile"]
    if not credential_path.is_file():
        parser.error(f"credential file is unavailable: {credential_path}")
    if not args.henji.is_file():
        parser.error(f"Henji executable is unavailable: {args.henji}")
    alias = f"probe-{args.provider}"
    if len(alias) > 64:
        parser.error("provider ID is too long for a probe alias")

    os.umask(0o077)
    root = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="henji-provider-probe-", dir="/tmp"))
    if args.output:
        root.mkdir(mode=0o700)
    raw_dir = root / "raw"
    raw_dir.mkdir()
    config = root / "config/henji-harness"
    (config / "providers").mkdir(parents=True)
    (root / "data").mkdir()
    (root / "state").mkdir()
    credential = credential_path.read_bytes().strip()
    isolated_credential = config / declaration["authProfile"]
    instruction = source_config / "instruction.md"
    if instruction.is_file():
        shutil.copyfile(instruction, config / "instruction.md")

    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        handler_for(raw_dir, f"{endpoint.scheme}://{endpoint.netloc}", credential),
    )
    server.daemon_threads = True
    server.block_on_close = False
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    local = copy.deepcopy(declaration)
    local["providerId"] = alias
    local["endpoint"] = f"http://127.0.0.1:{server.server_port}{endpoint.path.rstrip('/')}"
    local["defaults"] = {"modelId": model, "effort": effort}
    write_private(
        config / "providers" / f"{alias}.json",
        (json.dumps(local, indent=2) + "\n").encode(),
    )
    write_private(
        root / "probe.json",
        (json.dumps({
            "provider": args.provider,
            "probeProvider": alias,
            "model": model,
            "effort": effort,
            "protocol": declaration["protocol"],
            "originalEndpoint": declaration["endpoint"],
            "responseDelivery": "buffered by local proxy",
        }, indent=2) + "\n").encode(),
    )
    environment = os.environ.copy()
    environment.update({
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_DATA_HOME": str(root / "data"),
        "XDG_STATE_HOME": str(root / "state"),
    })
    command = [str(args.henji), "--root-provider", alias, "--max-steps", str(args.max_steps)]
    print(f"Probe output: {root}", file=sys.stderr, flush=True)
    print("Enter the diagnostic task in Henji, then /exit.", file=sys.stderr, flush=True)
    try:
        write_private(isolated_credential, credential + b"\n")
        return subprocess.run(command, env=environment, check=False).returncode
    finally:
        server.shutdown()
        server.server_close()
        isolated_credential.unlink(missing_ok=True)
        print(f"Captured files: {raw_dir}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
