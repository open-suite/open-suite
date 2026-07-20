#!/usr/bin/env python3
"""Measure LiveKit's local process startup path.

This deliberately uses only the Python standard library. It launches the
pinned LiveKit binary against an authenticated, AOF-enabled local Redis,
measures when each process is actually usable, and reports the chart's
before/after configured initial delays separately. It also measures room API
and WebSocket-upgrade latency. It does not claim to measure kubelet scheduling
or a real ICE/media path.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


API_KEY = "livekit-benchmark-key"
API_SECRET = "livekit-benchmark-secret-at-least-32-characters"
REDIS_PASSWORD = "livekit-benchmark-redis-password"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def elapsed_ms(start_ns: int) -> float:
    return (time.monotonic_ns() - start_ns) / 1_000_000


def redis_ping(port: int) -> bool:
    password = REDIS_PASSWORD.encode()
    request = (
        f"*2\r\n$4\r\nAUTH\r\n${len(password)}\r\n".encode()
        + password
        + b"\r\n*1\r\n$4\r\nPING\r\n"
    )
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.1) as sock:
            sock.sendall(request)
            response = sock.recv(128)
            return b"+OK\r\n+PONG\r\n" in response
    except OSError:
        return False


def wait_until(check, process: subprocess.Popen[bytes], timeout: float = 10) -> float:
    start_ns = time.monotonic_ns()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"process exited early with status {process.returncode}")
        if check():
            return elapsed_ms(start_ns)
        time.sleep(0.005)
    raise TimeoutError(f"process was not usable within {timeout}s")


def http_ready(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=0.1) as response:
            return response.status == 200
    except (OSError, urllib.error.HTTPError):
        return False


def jwt(video_grant: dict[str, object], subject: str) -> str:
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "iss": API_KEY,
        "sub": subject,
        "nbf": now - 10,
        "exp": now + 600,
        "video": video_grant,
    }

    def encode(value: object) -> bytes:
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=")

    unsigned = encode(header) + b"." + encode(payload)
    signature = hmac.new(API_SECRET.encode(), unsigned, hashlib.sha256).digest()
    return (unsigned + b"." + base64.urlsafe_b64encode(signature).rstrip(b"=")).decode()


def create_room(port: int, room: str) -> float:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/twirp/livekit.RoomService/CreateRoom",
        data=json.dumps({"name": room}).encode(),
        headers={
            "Authorization": f"Bearer {jwt({'roomCreate': True}, 'room-service')}",
            "Content-Type": "application/json",
        },
    )
    start_ns = time.monotonic_ns()
    with urllib.request.urlopen(request, timeout=2) as response:
        if response.status != 200:
            raise RuntimeError(f"room creation returned HTTP {response.status}")
        response.read()
    return elapsed_ms(start_ns)


def websocket_upgrade(port: int, room: str) -> float:
    token = jwt({"roomJoin": True, "room": room}, "websocket-participant")
    key = base64.b64encode(os.urandom(16)).decode()
    path = f"/rtc?access_token={token}&protocol=16&auto_subscribe=1&sdk=js&version=2.15.6"
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    ).encode()
    start_ns = time.monotonic_ns()
    with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
        sock.sendall(request)
        response = sock.recv(4096)
    if not response.startswith(b"HTTP/1.1 101"):
        status = response.split(b"\r\n", 1)[0].decode(errors="replace")
        raise RuntimeError(f"WebSocket upgrade failed: {status}")
    return elapsed_ms(start_ns)


def terminate(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def run_once(livekit_binary: Path) -> dict[str, float]:
    redis_port, http_port, tcp_port, udp_port = (free_port() for _ in range(4))
    with tempfile.TemporaryDirectory(prefix="livekit-startup-") as directory:
        work = Path(directory)
        redis = subprocess.Popen(
            [
                "redis-server",
                "--port", str(redis_port),
                "--bind", "127.0.0.1",
                "--requirepass", REDIS_PASSWORD,
                "--appendonly", "yes",
                "--save", "",
                "--dir", str(work),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        livekit: subprocess.Popen[bytes] | None = None
        try:
            redis_usable = wait_until(lambda: redis_ping(redis_port), redis)
            config = work / "livekit.yaml"
            config.write_text(
                f"""port: {http_port}
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: {tcp_port}
  udp_port: {udp_port}
  use_external_ip: false
  node_ip: 127.0.0.1
redis:
  address: 127.0.0.1:{redis_port}
  password: {REDIS_PASSWORD}
keys:
  {API_KEY}: {API_SECRET}
logging:
  level: warn
"""
            )
            livekit = subprocess.Popen(
                [str(livekit_binary), "--config", str(config)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            livekit_healthy = wait_until(lambda: http_ready(http_port), livekit)
            room = f"benchmark-{time.monotonic_ns()}"
            room_create = create_room(http_port, room)
            websocket = websocket_upgrade(http_port, room)
            return {
                "redis_usable_ms": redis_usable,
                "livekit_http_healthy_ms": livekit_healthy,
                "room_create_ms": room_create,
                "websocket_upgrade_ms": websocket,
            }
        finally:
            if livekit is not None:
                terminate(livekit)
            terminate(redis)


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    rank = (len(ordered) - 1) * fraction
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (rank - lower)


def summarize(samples: list[dict[str, float]]) -> dict[str, dict[str, float]]:
    return {
        metric: {
            "min": round(min(values), 3),
            "p50": round(statistics.median(values), 3),
            "p95": round(percentile(values, 0.95), 3),
            "max": round(max(values), 3),
        }
        for metric in samples[0]
        for values in [[sample[metric] for sample in samples]]
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--livekit-binary", required=True, type=Path)
    parser.add_argument("--iterations", type=int, default=30)
    parser.add_argument("--raw", action="store_true", help="include per-iteration samples")
    args = parser.parse_args()
    if args.iterations < 1:
        parser.error("--iterations must be at least 1")
    if not args.livekit_binary.is_file():
        parser.error("--livekit-binary must name an existing file")

    samples = [run_once(args.livekit_binary.resolve()) for _ in range(args.iterations)]
    output: dict[str, object] = {
        "iterations": args.iterations,
        "model": {
            "before_initial_delay_ms": {"redis": 20_000, "livekit": 10_000},
            "after_initial_delay_ms": {"redis": 1_000, "livekit": 1_000},
            "note": "initialDelaySeconds is a lower bound, not an exact kubelet probe timestamp",
            "excludes": ["image pull", "pod scheduling", "ingress/TLS", "real ICE/media path"],
        },
        "summary_ms": summarize(samples),
    }
    if args.raw:
        output["samples_ms"] = samples
    print(json.dumps(output, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
