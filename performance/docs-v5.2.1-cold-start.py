#!/usr/bin/env python3
"""Measure a cached-image Docs v5.2.1 process becoming usable."""

import argparse
import json
import shlex
import statistics
import subprocess
import time
import urllib.error
import urllib.request


COMPONENTS = {
    "backend": {
        "image": "lasuite/impress-backend:v5.2.1",
        "port": 18000,
        "container_port": 8000,
        "path": "/__heartbeat__",
    },
    "worker": {
        "image": "lasuite/impress-backend:v5.2.1",
        "ready_log": " ready.",
        "command": [
            "celery", "-A", "impress.celery_app", "worker", "-l", "INFO",
            "-n", "impress@%h", "--autoscale=9,3",
        ],
    },
    "frontend": {
        "image": "lasuite/impress-frontend:v5.2.1",
        "port": 18080,
        "container_port": 8080,
        "path": "/",
    },
    "y-provider": {
        "image": "lasuite/impress-y-provider:v5.2.1",
        "port": 14444,
        "container_port": 4444,
        "path": "/ping",
    },
}


def command(runtime, *arguments, check=True):
    return subprocess.run(
        [*runtime, *arguments], check=check, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )


def wait_http(port, path, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}{path}",
                headers={"X-Forwarded-Proto": "https"},
            )
            with urllib.request.urlopen(request, timeout=0.2) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.02)
    raise TimeoutError(f"{port}{path} did not become usable")


def sample(runtime, network, component, env_file, timeout):
    config = COMPONENTS[component]
    name = f"docs-v5.2.1-cold-start-{component}"
    command(runtime, "rm", "-f", name, check=False)
    create = ["create", "--name", name, "--network", network]
    if env_file:
        create += ["--env-file", str(env_file)]
    if "port" in config:
        create += ["-p", f"{config['port']}:{config['container_port']}"]
    create.append(config["image"])
    create += config.get("command", [])
    command(runtime, *create)
    started = time.monotonic_ns()
    command(runtime, "start", name)
    try:
        if "path" in config:
            wait_http(config["port"], config["path"], timeout)
        else:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                logs = command(runtime, "logs", name, check=False).stdout
                if config["ready_log"] in logs:
                    break
                state = command(runtime, "inspect", "-f", "{{.State.Status}}", name).stdout.strip()
                if state == "exited":
                    raise RuntimeError(logs)
                time.sleep(0.05)
            else:
                raise TimeoutError(f"{component} did not become usable")
        elapsed_ms = (time.monotonic_ns() - started) / 1_000_000
        memory = command(runtime, "stats", "--no-stream", "--format", "{{.MemUsage}}", name).stdout.strip()
        return {"usable_ms": round(elapsed_ms, 1), "memory": memory}
    finally:
        command(runtime, "rm", "-f", name, check=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("component", choices=COMPONENTS)
    parser.add_argument("--count", type=int, default=7)
    parser.add_argument("--network", default="docs-v5.2.1-benchmark")
    parser.add_argument("--env-file", type=str)
    parser.add_argument("--runtime", default="docker", help="container command, e.g. 'sudo docker'")
    parser.add_argument("--timeout", type=float, default=90)
    arguments = parser.parse_args()
    runtime = shlex.split(arguments.runtime)
    results = [
        sample(runtime, arguments.network, arguments.component, arguments.env_file, arguments.timeout)
        for _ in range(arguments.count)
    ]
    timings = [result["usable_ms"] for result in results]
    print(json.dumps({
        "component": arguments.component,
        "image": COMPONENTS[arguments.component]["image"],
        "samples": results,
        "median_ms": statistics.median(timings),
        "max_ms": max(timings),
    }, indent=2))


if __name__ == "__main__":
    main()
