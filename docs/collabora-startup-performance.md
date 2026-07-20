# Collabora cold-start and first-document performance

Measured 2026-07-20 for `collabora/code:26.04.1.4.1` at digest
`sha256:75859dc9f9084d1877ce36cf96ec86600f495bade33289c9cbc27e0a0ee23b81`
on an x86-64 Amp orb (Docker overlay2, 31 GiB RAM). No cluster was changed.

## Result

The candidate changes only Collabora's application values:

- set `DONT_GEN_SSL_CERT=true`, because Open Suite already runs coolwsd with
  `ssl.enable=false` and `ssl.termination=true`; the ingress remains the TLS
  endpoint, while the image no longer generates an unused CA, RSA key, and
  leaf certificate on every start;
- replace the chart's broad `dictionaries=en` environment override with
  `en_GB nl`. Collabora expands `en` to 18 regional English writing-aid
  locales. The candidate preloads `en-GB`, `nl-NL`, and `nl-BE`, matching the
  chart's existing `en_GB nl` XML intent. This does not remove or filter any
  fonts.

Cold service readiness improved by **15.6% at p50** (6265.140 ms to
5286.895 ms) and **15.6% at p95** (6489.597 ms to 5476.238 ms). First-document
candidate medians were 0.5–1.9 ms higher in this 10-sample local run. Ten
samples are too few to characterize tails or establish statistical
equivalence; the change removes roughly one second from process initialization
without a material median first-editor shift.

All values below are milliseconds. p95 is nearest-rank. Sorted raw samples are
included to make the stated distribution exact rather than inferred from a
single run.

| Marker | Profile | Sorted samples | min / p50 / p95 / max |
|---|---|---|---|
| fresh-container HTTP ready (`GET /` = 200) | baseline | 6165.610, 6170.438, 6201.858, 6207.235, 6221.514, 6308.765, 6337.177, 6337.191, 6341.562, 6489.597 | 6165.610 / 6265.140 / 6489.597 / 6489.597 |
| fresh-container HTTP ready (`GET /` = 200) | candidate | 5128.036, 5197.995, 5210.878, 5262.840, 5269.449, 5304.341, 5325.504, 5339.259, 5351.557, 5476.238 | 5128.036 / 5286.895 / 5476.238 / 5476.238 |
| WOPI CheckFileInfo + GetFile (`stats: wopiloadduration`) | baseline | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 | 0 / 0 / 0 / 0 |
| WOPI CheckFileInfo + GetFile (`stats: wopiloadduration`) | candidate | 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 | 0 / 0 / 1 / 1 |
| WebSocket connection attempt to `loaded:` | baseline | 33.925, 34.152, 34.465, 34.534, 34.608, 35.447, 35.589, 35.824, 35.845, 37.395 | 33.925 / 35.028 / 37.395 / 37.395 |
| WebSocket connection attempt to `loaded:` | candidate | 33.684, 34.124, 34.153, 34.251, 35.297, 35.789, 35.974, 36.525, 48.426, 49.174 | 33.684 / 35.543 / 49.174 / 49.174 |
| connection attempt to first tile bytes | baseline | 40.803, 40.971, 41.198, 41.293, 41.413, 42.208, 42.404, 42.944, 42.993, 44.723 | 40.803 / 41.811 / 44.723 / 44.723 |
| connection attempt to first tile bytes | candidate | 40.515, 40.891, 40.960, 42.305, 43.418, 43.722, 44.090, 45.029, 57.274, 58.171 | 40.515 / 43.570 / 58.171 / 58.171 |
| connection attempt to first tile/cursor invalidation after key input | baseline | 43.141, 43.462, 43.577, 43.643, 43.762, 44.591, 44.791, 45.161, 45.328, 47.104 | 43.141 / 44.177 / 47.104 / 47.104 |
| connection attempt to first tile/cursor invalidation after key input | candidate | 42.869, 43.319, 43.669, 44.740, 45.843, 46.309, 46.660, 47.671, 60.390, 60.621 | 42.869 / 46.076 / 60.621 / 60.621 |

## Method

Run:

```sh
python3 -m pip install websocket-client
sudo performance/collabora-startup-benchmark.py \
  --samples 10 --output collabora-startup-results.json
```

The harness discards one baseline and one candidate warm-up, then alternates
AB/BA order to limit time/order bias. Every sample removes and creates a fresh
container from the already-pulled immutable image digest. It measures from
`docker run` invocation until the same HTTP `/` 200 used by the enabled
Kubernetes readiness probe. This is **service cold readiness**, excluding
scheduler and image-pull time; it does not include the probe's 5-second initial
delay or 10-second cadence, so it is not the quantized Pod `Ready` transition.
Host page cache remains warm, matching a pod restart on an existing node rather
than first-ever node provisioning.

After readiness, the harness opens a new editable ODT through a local fake
WOPI host. It records Collabora's own `serverloadtimings`, `loaded:`, first
binary `tile:`, and the first tile/cursor invalidation after a key input. The
fake WOPI host returns a 200-byte-class CheckFileInfo response and a small ODT;
it isolates Collabora and does not model Nextcloud/network latency. The fake
host validates a random per-run capability in the WOPI path, and the protocol
still carries a random access token, although this fake does not implement
Nextcloud's token semantics. The WOPI listener is reachable on the Docker
bridge so Collabora can call it; the published Collabora benchmark port is
bound to host loopback. The production WOPI HTTPS host allowlist is not changed
by the optimization.

The server-side phase distributions confirm that first-document work is not
the cold-start bottleneck:

| Phase | Baseline p50 / p95 | Candidate p50 / p95 |
|---|---:|---:|
| CheckFileInfo | 1.152 / 1.588 | 1.274 / 1.476 |
| GetFile | 0.910 / 0.992 | 0.956 / 1.124 |
| spare-child assignment | 0.096 / 0.159 | 0.102 / 0.113 |
| jail setup | 910.817 / 965.314 | 881.509 / 891.831 |
| child document-load handler | 29.483 / 31.651 | 29.819 / 43.443 |
| loaded-to-first-tile render | 6.477 / 6.724 | 6.237 / 8.880 |

A timestamped startup trace identifies the dominant interval before the spare
kit is available: VCL/component/plugin preload, writing-aid locale expansion,
language data, font-cache warming, and configuration preload. Font preload is
retained deliberately so workers inherit a complete warm font selection cache.
Baseline `en` logged 18 dictionary, thesaurus, and hyphenation locales;
candidate `en_GB nl` logged `en-GB`, `nl-NL`, and `nl-BE`. The implementation
also removes dummy-certificate key generation ahead of coolwsd. Neither cost is
on the measured WOPI or render path, consistent with the stable medians in this
run. The post-key marker is an asynchronous invalidation, not a save
acknowledgement or persisted-content check.

## Safety, rollout, and remaining bottlenecks

- **TLS:** ingress TLS and coolwsd's `ssl.termination=true` remain unchanged.
  `DONT_GEN_SSL_CERT` skips only the unused internal dummy certificate created
  by the CODE entrypoint while `ssl.enable=false`.
- **WOPI:** both HTTPS alias-group hosts, mode, access tokens, and Nextcloud's
  WOPI enforcement remain unchanged.
- **Documents/fonts:** no image, font, fontconfig, missing-font diagnostics,
  LibreOffice component, or rendering option changes. English (UK) and Dutch
  writing aids remain preloaded. Users who specifically require US-English
  spelling conventions would need `en_US` added deliberately; font rendering
  for US-English and all other scripts is unaffected.
- **Isolation/health:** no capabilities, mount, security context, liveness, or
  readiness settings change. The regression guard rejects capability and
  missing-font-diagnostic shortcuts.
- **Rollout:** this requires a normal Collabora pod restart to inherit the new
  environment. Monitor startup logs for the exact allowlist and open one Writer,
  Calc, and Impress document through Nextcloud before broad rollout.

The largest remaining first-document component is ~1.0 s of jail population.
The container cannot use Collabora's faster bind-mount jail path without mount
privileges in the tested runtime. Granting `SYS_ADMIN` would be a poor security
trade for this deployment, so this patch leaves the fallback intact. This
benchmark also intentionally excludes Kubernetes scheduling/image pulls,
browser asset download, WAN/TLS transit, Nextcloud application latency, large
documents, custom remote fonts, and concurrent document bursts; those should
not be attributed to the optimized coolwsd initialization path.
