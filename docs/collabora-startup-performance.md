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
  `en_GB en_US nl`. Collabora expands `en` to 18 regional English writing-aid
  locales. The candidate explicitly retains US and UK English and adds Dutch
  (`nl-NL` and `nl-BE`). This does not remove or filter any fonts.

The **combined candidate** improved cold service readiness by **15.2% at p50**
(6205.589 ms to 5264.536 ms) and **14.4% at p95** (6383.890 ms to
5462.386 ms). This run did not use four factorial profiles, so the improvement
cannot be attributed independently to certificate or dictionary treatment.
First-document candidate medians stayed within 0.4 ms of baseline. Ten samples
are too few to characterize tails or establish statistical equivalence.

All values below are milliseconds. p95 is nearest-rank. Sorted raw samples are
included to make the stated distribution exact rather than inferred from a
single run.

| Marker | Profile | Sorted samples | min / p50 / p95 / max |
|---|---|---|---|
| fresh-container HTTP ready (`GET /` = 200) | baseline | 5969.610, 6040.486, 6069.751, 6090.855, 6196.723, 6214.455, 6275.993, 6350.352, 6377.011, 6383.890 | 5969.610 / 6205.589 / 6383.890 / 6383.890 |
| fresh-container HTTP ready (`GET /` = 200) | candidate | 5122.141, 5160.285, 5206.009, 5253.726, 5262.857, 5266.216, 5365.206, 5438.716, 5454.435, 5462.386 | 5122.141 / 5264.536 / 5462.386 / 5462.386 |
| WOPI CheckFileInfo + GetFile (`stats: wopiloadduration`) | baseline | 0, 0, 0, 0, 0, 0, 1, 1, 1, 1 | 0 / 0 / 1 / 1 |
| WOPI CheckFileInfo + GetFile (`stats: wopiloadduration`) | candidate | 0, 0, 0, 0, 0, 0, 1, 1, 1, 1 | 0 / 0 / 1 / 1 |
| WebSocket connection attempt to `loaded:` | baseline | 34.822, 35.396, 35.400, 35.425, 36.275, 36.394, 36.742, 36.825, 37.338, 38.307 | 34.822 / 36.335 / 38.307 / 38.307 |
| WebSocket connection attempt to `loaded:` | candidate | 34.914, 35.156, 35.649, 36.086, 36.235, 36.598, 36.815, 37.573, 37.628, 37.923 | 34.914 / 36.417 / 37.923 / 37.923 |
| connection attempt to first tile bytes | baseline | 42.737, 43.082, 43.755, 44.442, 44.507, 44.596, 44.798, 45.174, 46.481, 48.016 | 42.737 / 44.551 / 48.016 / 48.016 |
| connection attempt to first tile bytes | candidate | 42.310, 42.792, 43.105, 43.453, 44.289, 44.325, 46.029, 46.390, 47.780, 48.105 | 42.310 / 44.307 / 48.105 / 48.105 |
| connection attempt to first tile/cursor invalidation after key input | baseline | 44.885, 46.089, 46.288, 46.764, 46.885, 47.019, 47.568, 47.997, 49.159, 50.900 | 44.885 / 46.952 / 50.900 / 50.900 |
| connection attempt to first tile/cursor invalidation after key input | candidate | 44.642, 45.019, 45.189, 45.769, 46.530, 46.719, 48.439, 50.044, 50.864, 51.271 | 44.642 / 46.625 / 51.271 / 51.271 |

## Method

Run:

```sh
python3 -m pip install websocket-client
sudo performance/collabora-startup-benchmark.py \
  --samples 10 --output collabora-startup-results.json
```

The harness discards one baseline and one combined-candidate warm-up, then
alternates AB/BA order to limit time/order bias. Every sample removes and
creates a fresh container from the already-pulled immutable image digest. It
measures from `docker run` invocation until the same HTTP `/` 200 used by the
enabled Kubernetes readiness probe. This is **service cold readiness**, excluding
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
by the optimization. The generated ODT is tagged `en-US`; every sample must
load it, render a tile, and produce an invalidation after input. Candidate
startup-log assertions additionally require `en-US`, `en-GB`, and Dutch
dictionaries/hyphenators plus both English thesauri.

The server-side phase distributions confirm that first-document work is not
the cold-start bottleneck:

| Phase | Baseline p50 / p95 | Candidate p50 / p95 |
|---|---:|---:|
| CheckFileInfo | 1.181 / 1.493 | 1.233 / 1.553 |
| GetFile | 1.018 / 1.184 | 1.046 / 1.233 |
| spare-child assignment | 0.114 / 0.187 | 0.104 / 0.129 |
| jail setup | 899.188 / 949.619 | 885.066 / 904.567 |
| child document-load handler | 30.175 / 32.499 | 30.502 / 31.841 |
| loaded-to-first-tile render | 5.912 / 6.649 | 5.877 / 7.606 |

A timestamped startup trace identifies the dominant interval before the spare
kit is available: VCL/component/plugin preload, writing-aid locale expansion,
language data, font-cache warming, and configuration preload. Font preload is
retained deliberately so workers inherit a complete warm font selection cache.
Baseline `en` logged 18 English writing-aid locales. Candidate
`en_GB en_US nl` logged `en-US`, `en-GB`, `nl-NL`, and `nl-BE`. The combined
candidate also removes dummy-certificate key generation ahead of coolwsd; this
benchmark does not separate the contribution of those treatments. The
post-key marker is an asynchronous invalidation, not a save acknowledgement or
persisted-content check.

## Safety, rollout, and remaining bottlenecks

- **TLS:** ingress TLS and coolwsd's `ssl.termination=true` remain unchanged.
  `DONT_GEN_SSL_CERT` skips only the unused internal dummy certificate created
  by the CODE entrypoint while `ssl.enable=false`.
- **WOPI:** both HTTPS alias-group hosts, mode, access tokens, and Nextcloud's
  WOPI enforcement remain unchanged.
- **Documents/fonts:** no image, font, fontconfig, missing-font diagnostics,
  LibreOffice component, or rendering option changes. English (US and UK) and
  Dutch writing aids remain preloaded; rendering for all scripts is unaffected.
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
