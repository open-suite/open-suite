# LiveKit startup readiness benchmark

Measured 2026-07-20 against the distribution's pinned LiveKit server v1.13.1.
This document is intentionally LiveKit-specific; it does not define shared
workload sizing or general performance policy.

## Finding and fix

Redis configured a readiness initial delay much larger than measured process
initialization:

1. The demo Helmfile orders LiveKit's private Redis release before LiveKit, but
   does not wait for Redis pod readiness.
2. Redis configured a 20-second readiness initial delay.

Redis readiness also controls whether its pod is an eligible Service endpoint.
Because LiveKit v1.13.1 connects to Redis synchronously and exits when it is
unavailable, the old 20-second delay can expose a startup race and restart
backoff. That Kubernetes path has not been measured on the demo cluster.

Redis runs a meaningful authenticated readiness ping. The fix in
`patches/local/livekit-performance.patch` changes only its first readiness
probe opportunity to one second. `initialDelaySeconds` is a lower bound;
kubelet does not guarantee a probe at that exact timestamp. The fix does not
remove, replace, or make the check less strict, and it preserves Helmfile's
release ordering.

LiveKit keeps its chart-default 10-second readiness delay. A fresh Helm render
starts with placeholder `NODE_IP=1.3.5.7`; the demo's post-Helm networking step
then writes the validated public IP and restarts LiveKit. Because LiveKit `/`
does not validate the advertised IP, reducing that delay could let a
placeholder-configured replacement pod become Ready earlier than the corrected
old pod. Public-IP discovery is therefore deliberately out of scope here.

## Measured intrinsic distribution

Thirty iterations were run in an Amp Linux x86-64 orb with the official
`livekit-server` v1.13.1 release binary and the installed Redis 7.0.15 binary.
Redis used authentication, AOF persistence, no RDB snapshots, and a fresh data
directory on every iteration, matching the important bundled chart settings.

| Metric (milliseconds) | Min | p50 | p95 | Max |
|---|---:|---:|---:|---:|
| Redis actually accepts authenticated `PING` | 10.666 | 10.882 | 14.150 | 16.634 |
| LiveKit `/` actually returns ready | 37.466 | 43.906 | 58.297 | 60.914 |
| Room create API | 4.205 | 5.174 | 7.275 | 7.796 |
| Signaling WebSocket HTTP upgrade | 84.874 | 102.714 | 127.937 | 129.385 |

The patch changes Kubernetes observation timing, not the processes, so these
intrinsic distributions are the same before and after. Room creation and the
WebSocket `101` are post-readiness functional smoke latencies, not room-join or
media-path measurements and not expected to change.

## Before/after probe configuration

| Readiness probe | Before initial delay | After initial delay | Period (unchanged) |
|---|---:|---:|---:|
| Authenticated Redis | 20s | 1s | 5s |
| LiveKit `/` | 10s | 10s | 10s |

All 30 measured Redis starts became usable before one second. The patch removes
19 seconds from its configured **earliest probe opportunity**. This is not a
deployment distribution: Helmfile orders the releases but does not wait for
Redis pod readiness, and kubelet probe scheduling is not exact. If
initialization takes longer, the same probe continues to fail closed and retry
at its unchanged period.

## Reproduction

Download and verify the official pinned binary, then run:

```bash
curl -fsSLO https://github.com/livekit/livekit/releases/download/v1.13.1/livekit_1.13.1_linux_amd64.tar.gz
curl -fsSL https://github.com/livekit/livekit/releases/download/v1.13.1/checksums.txt \
  | grep 'livekit_1.13.1_linux_amd64.tar.gz' | sha256sum --check
tar -xzf livekit_1.13.1_linux_amd64.tar.gz livekit-server
python3 performance/livekit-startup-benchmark.py \
  --livekit-binary ./livekit-server --iterations 30 --raw
```

The benchmark uses only Python's standard library. For each iteration it:

1. starts an authenticated, AOF-enabled Redis with fresh storage;
2. polls authenticated `PING` for the first usable timestamp;
3. starts LiveKit with Redis enabled and explicit loopback `node_ip`;
4. polls the chart's `/` endpoint until it returns `200`;
5. creates a room through the authenticated RoomService API;
6. performs an authenticated `/rtc` WebSocket upgrade.

Apply all local patches to the pinned infra checkout and verify preservation of
the deployment contracts with:

```bash
bash ci/test-livekit-performance.sh /path/to/patched-mijn-bureau-infra
```

## Preserved invariants

- Redis and LiveKit readiness and liveness checks remain enabled.
- Redis authentication, AOF persistence, and the LiveKit key file remain in
  place.
- Helmfile's Redis-before-LiveKit release ordering is unchanged.
- Redis and LiveKit NetworkPolicies and all ingress/egress rules are unchanged.
- RTC UDP/TCP ports, TURN configuration, and WebSocket ingress are unchanged.
- `use_external_ip: false`, explicit `node_ip` handling, and the public-IP
  updater are unchanged.
- LiveKit and Redis resource requests/guarantees are unchanged.

## Risks and unverified real-network assumptions

- This was not deployed to the demo VPS. GitHub's ephemeral self-signed fresh
  install exercises the patched deployment, but does not collect the
  before/after event distribution. Demo scheduling, image pulls, PVC
  attachment/AOF replay, DNS, Traefik, TLS, and WAN RTT can add variance.
- The WebSocket metric ends at HTTP `101`. It validates authentication and
  signaling session setup through the upgrade locally, not receipt of the
  initial LiveKit join message or full browser room join.
- No browser/WebRTC pair was available in the orb, so ICE gathering, UDP media,
  ICE/TCP fallback, TURN allocation, DTLS/SRTP setup, and time to first decoded
  audio/video frame are unverified on a real network.
- Explicit public-IP advertising remains necessary. The benchmark uses
  loopback only and does not validate cloud LoadBalancer IP discovery, NAT,
  hairpin routing, or reachability of advertised candidates.
- A large existing Redis AOF or slow volume may exceed one second. Redis
  readiness remains false until the authenticated probe succeeds, but LiveKit
  may race the unready Service endpoint, exit, and restart. The patch does not
  worsen that existing race; target-cluster startup/restart timing still needs
  measurement.

Before production rollout, repeat at least 30 cold pod starts on the target
cluster and use two external browser peers to record signaling connected, room
joined, ICE connected, first RTP packet, and first decoded frame separately for
UDP, ICE/TCP, and TURN paths.
