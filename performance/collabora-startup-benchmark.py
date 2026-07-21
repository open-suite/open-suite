#!/usr/bin/env python3
"""Repeatable cold-container and first-document Collabora benchmark.

Requires Docker and the Python ``websocket-client`` package. The fake
WOPI host is loopback-only and exists solely to isolate Collabora timings.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import secrets
import statistics
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

try:
    import websocket
except ImportError as error:
    raise SystemExit("Install websocket-client: python3 -m pip install websocket-client") from error


CONTAINER = "collabora-startup-benchmark"
COLLABORA_PORT = 19980
WOPI_PORT = 18080
ACCESS_TOKEN = secrets.token_urlsafe(24)
WOPI_URL = f"http://host.docker.internal:{WOPI_PORT}/wopi/files/{ACCESS_TOKEN}"


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, text=True, capture_output=True)


def make_document(path: Path) -> bytes:
    content = b"""<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2"><office:automatic-styles><style:style style:name="P1" style:family="paragraph"><style:text-properties fo:language="en" fo:country="US"/></style:style></office:automatic-styles><office:body><office:text><text:p text:style-name="P1">Hello Open Suite performance benchmark</text:p></office:text></office:body></office:document-content>"""
    manifest = b"""<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>"""
    with ZipFile(path, "w") as archive:
        archive.writestr("mimetype", "application/vnd.oasis.opendocument.text", ZIP_STORED)
        archive.writestr("content.xml", content, ZIP_DEFLATED)
        archive.writestr("META-INF/manifest.xml", manifest, ZIP_DEFLATED)
    return path.read_bytes()


class WopiHandler(BaseHTTPRequestHandler):
    document = b""
    events: list[dict[str, float | str]] = []

    def log_message(self, *_args: object) -> None:
        return

    def authorized(self) -> bool:
        parts = urllib.parse.urlparse(self.path).path.split("/")
        return len(parts) > 3 and secrets.compare_digest(parts[3], ACCESS_TOKEN)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        started = time.monotonic_ns()
        if not self.authorized():
            self.send_error(401)
            return
        if urllib.parse.urlparse(self.path).path.endswith("/contents"):
            body = self.document
            content_type = "application/vnd.oasis.opendocument.text"
            event = "GetFile"
        elif self.authorized():
            body = json.dumps(
                {
                    "BaseFileName": "benchmark.odt",
                    "Size": len(self.document),
                    "OwnerId": "benchmark",
                    "UserId": "benchmark",
                    "UserFriendlyName": "Benchmark",
                    "UserCanWrite": True,
                    "SupportsUpdate": True,
                    "Version": "1",
                }
            ).encode()
            content_type = "application/json"
            event = "CheckFileInfo"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.events.append({"event": event, "server_ms": (time.monotonic_ns() - started) / 1e6})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if not self.authorized():
            self.send_error(401)
            return
        if not urllib.parse.urlparse(self.path).path.endswith("/contents"):
            self.send_error(404)
            return
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()


def http_ready() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{COLLABORA_PORT}/", timeout=0.2) as response:
            return response.status == 200
    except Exception:
        return False


def document_sample() -> dict[str, object]:
    encoded = urllib.parse.quote(WOPI_URL, safe="")
    socket_url = (
        f"ws://127.0.0.1:{COLLABORA_PORT}/cool/{encoded}/ws"
        f"?WOPISrc={encoded}&access_token={ACCESS_TOKEN}&access_token_ttl=0"
    )
    started = time.monotonic_ns()
    connection = websocket.create_connection(
        socket_url,
        timeout=20,
        origin=f"https://127.0.0.1:{COLLABORA_PORT}",
    )
    marks: dict[str, object] = {"websocket_ms": (time.monotonic_ns() - started) / 1e6}
    connection.send("coolclient 0.1 1700000000000 1")
    connection.send(
        f"load url={WOPI_URL} access_token={ACCESS_TOKEN} deviceFormFactor=desktop spellOnline=true"
    )
    tile_requested = False
    edit_sent = False
    while True:
        message = connection.recv()
        elapsed = (time.monotonic_ns() - started) / 1e6
        if isinstance(message, bytes):
            if message.startswith(b"tile:") and "first_tile_ms" not in marks:
                marks["first_tile_ms"] = elapsed
            continue
        line = message.split("\n", 1)[0]
        if line.startswith("stats: wopiloadduration"):
            marks["wopi_load_ms"] = float(line.rsplit(" ", 1)[1]) * 1000
        elif line.startswith("serverloadtimings:"):
            marks["serverloadtimings"] = {
                item.split("=", 1)[0]: int(item.split("=", 1)[1])
                for item in line.split()[1:]
            }
        elif line.startswith("loaded:") and "loaded_ms" not in marks:
            marks["loaded_ms"] = elapsed
        if line.startswith("status:") and not tile_requested:
            tile_requested = True
            connection.send("clientvisiblearea x=0 y=0 width=12240 height=15840 splitx=0 splity=0")
            connection.send(
                "tilecombine nviewid=0 part=0 width=256 height=256 "
                "tileposx=0 tileposy=0 tilewidth=3840 tileheight=3840"
            )
        if "first_tile_ms" in marks and not edit_sent:
            edit_sent = True
            marks["edit_sent_ms"] = elapsed
            connection.send("key type=input char=88 key=0")
        if edit_sent and (line.startswith("invalidatetiles:") or line.startswith("invalidatecursor:")):
            marks["post_key_invalidation_ms"] = elapsed
            break
        if elapsed > 20_000:
            raise TimeoutError(f"document sample timed out after marks {marks}")
    connection.close()
    return marks


def assert_startup_languages(profile: str) -> list[str]:
    output = run("docker", "logs", CONTAINER)
    logs = (output.stdout + output.stderr).splitlines()
    if profile != "candidate":
        return []
    expected = {
        "Allowlisted languages:": ("en_GB", "en_US", "nl"),
        "Preloading local dictionaries:": ("en-US", "en-GB", "nl-NL"),
        "Preloading local thesauri:": ("en-US", "en-GB"),
        "Preloading local hyphenators:": ("en-US", "en-GB", "nl-NL"),
    }
    matched: list[str] = []
    for prefix, languages in expected.items():
        line = next((entry for entry in logs if entry.startswith(prefix)), None)
        if line is None or any(language not in line.split() for language in languages):
            raise AssertionError(f"startup log does not preserve {languages}: {line!r}")
        matched.append(line)
    return matched


def sample(profile: str, image: str, number: int) -> dict[str, object]:
    run("docker", "rm", "-f", CONTAINER, check=False)
    environment = ["-e", "dictionaries=en"]
    if profile == "candidate":
        environment = [
            "-e",
            "dictionaries=en_GB en_US nl",
            "-e",
            "DONT_GEN_SSL_CERT=true",
        ]
    extra_params = " ".join(
        (
            "--o:ssl.enable=false",
            "--o:ssl.termination=true",
            "--o:storage.wopi.host[0]=host.docker.internal",
            "--o:storage.wopi.alias_groups.mode=groups",
            "--o:storage.wopi.alias_groups.group[0].host=host.docker.internal",
            "--o:welcome.enable=false",
            "--o:home_mode.enable=true",
            "--o:logging.level=warning",
            "--o:logging.level_startup=warning",
        )
    )
    started = time.monotonic_ns()
    run(
        "docker", "run", "-d", "--name", CONTAINER,
        "-p", f"127.0.0.1:{COLLABORA_PORT}:9980",
        "--add-host", "host.docker.internal:host-gateway",
        *environment,
        "-e", f"extra_params={extra_params}",
        "--cap-add", "MKNOD",
        image,
    )
    deadline = time.monotonic() + 30
    while not http_ready():
        if time.monotonic() >= deadline:
            raise TimeoutError("Collabora did not become HTTP-ready in 30 seconds")
        time.sleep(0.05)
    ready_ms = (time.monotonic_ns() - started) / 1e6
    WopiHandler.events = []
    result = {
        "profile": profile,
        "sample": number,
        "container_ready_ms": ready_ms,
        "startup_language_logs": assert_startup_languages(profile),
        "document_language": "en-US",
        "document": document_sample(),
        "wopi_server": WopiHandler.events,
    }
    print(json.dumps(result, sort_keys=True), flush=True)
    return result


def percentile(values: list[float], fraction: float) -> float:
    return sorted(values)[math.ceil(len(values) * fraction) - 1]


def summarize(rows: list[dict[str, object]]) -> dict[str, object]:
    summary: dict[str, object] = {}
    for profile in ("baseline", "candidate"):
        selected = [row for row in rows if row["profile"] == profile]
        metrics: dict[str, list[float]] = {
            "container_ready_ms": [float(row["container_ready_ms"]) for row in selected]
        }
        for key in (
            "wopi_load_ms",
            "loaded_ms",
            "first_tile_ms",
            "post_key_invalidation_ms",
        ):
            metrics[key] = [float(row["document"][key]) for row in selected]  # type: ignore[index]
        timings = [row["document"]["serverloadtimings"] for row in selected]  # type: ignore[index]
        for key, start, end in (
            ("check_file_info_ms", "checkFileInfoStart", "checkFileInfoEnd"),
            ("get_file_ms", "wopiDownloadStart", "wopiDownloadEnd"),
            ("child_assignment_ms", "childRequested", "childAssigned"),
            ("jail_setup_ms", "jailSetupStart", "jailSetupEnd"),
            ("child_load_handler_ms", "loadDocumentStart", "loadDocumentEnd"),
            ("loaded_to_first_tile_ms", "loadDocumentEnd", "firstTileSent"),
        ):
            metrics[key] = [(float(timing[end]) - float(timing[start])) / 1000 for timing in timings]
        summary[profile] = {
            key: {
                "samples": sorted(round(value, 3) for value in values),
                "min": round(min(values), 3),
                "p50": round(statistics.median(values), 3),
                "p95": round(percentile(values, 0.95), 3),
                "max": round(max(values), 3),
            }
            for key, values in metrics.items()
        }
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--image",
        default="collabora/code@sha256:75859dc9f9084d1877ce36cf96ec86600f495bade33289c9cbc27e0a0ee23b81",
    )
    parser.add_argument("--samples", type=int, default=10)
    parser.add_argument("--output", type=Path, default=Path("collabora-startup-results.json"))
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be positive")
    with tempfile.TemporaryDirectory(prefix="collabora-benchmark-") as temp:
        WopiHandler.document = make_document(Path(temp) / "benchmark.odt")
        server = ThreadingHTTPServer(("0.0.0.0", WOPI_PORT), WopiHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        rows: list[dict[str, object]] = []
        try:
            # Discard one of each profile so both measured profiles inherit the
            # same image/filesystem cache warm-up.
            sample("baseline", args.image, 0)
            sample("candidate", args.image, 0)
            for number in range(1, args.samples + 1):
                order = ("baseline", "candidate") if number % 2 else ("candidate", "baseline")
                for profile in order:
                    rows.append(sample(profile, args.image, number))
        finally:
            run("docker", "rm", "-f", CONTAINER, check=False)
            server.shutdown()
        report = {
            "image": args.image,
            "image_id": run("docker", "image", "inspect", args.image, "--format", "{{.Id}}").stdout.strip(),
            "method": "discarded AB warm-up; alternating AB/BA fresh containers; immutable image; local token-validating fake WOPI; monotonic clock",
            "rows": rows,
            "summary": summarize(rows),
        }
        args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + os.linesep)


if __name__ == "__main__":
    main()
