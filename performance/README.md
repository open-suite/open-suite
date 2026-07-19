# Application performance harness

The browser harness measures cold SSO navigation and same-context warm reloads
for the full Nextcloud and Element applications. It records useful-content
readiness, navigation/paint timings, long tasks, spinner exposure, request
counts and transferred/decoded asset sizes. Schema 2 results also record the
baseline and deployed revisions, exact workload, requested and completed sample
counts, runner environment, and robust run-to-run spread.

```bash
cd performance
npm ci
npx playwright install chromium
BENCHMARK_USER=johndoe \
BENCHMARK_PASS='<demo password>' \
BENCHMARK_SAMPLES=10 \
BENCHMARK_LABEL='<release-or-candidate>' \
BENCHMARK_BASELINE='<baseline release or commit>' \
BENCHMARK_DEPLOYMENT_REVISION='<deployed release or image revisions>' \
BENCHMARK_RUNNER_LABEL='<stable runner class>' \
BENCHMARK_RUNNER_REGION='<coarse region>' \
BENCHMARK_OUTPUT=/tmp/open-suite-apps.json \
npm run benchmark:apps
```

Exercise isolated Element sessions in a burst to detect false login throttling:

```bash
BENCHMARK_USER=johndoe \
BENCHMARK_PASS='<demo password>' \
BENCHMARK_ATTEMPTS=10 \
BENCHMARK_BASELINE='<baseline release or commit>' \
BENCHMARK_DEPLOYMENT_REVISION='<deployed release or image revisions>' \
BENCHMARK_RUNNER_LABEL='<stable runner class>' \
BENCHMARK_RUNNER_REGION='<coarse region>' \
npm run benchmark:element-login
```

Limit a run with `BENCHMARK_APPS=nextcloud` or `BENCHMARK_APPS=element`.
Set `BENCHMARK_TRACE_RESOURCES=true` to include per-resource waterfall entries
in the raw JSON when diagnosing a startup path. Resource URLs are local
diagnostics and are reduced to origin and path before they are written.

`BENCHMARK_BASELINE` identifies the release or configuration being compared;
`BENCHMARK_LABEL` names this run; and `BENCHMARK_DEPLOYMENT_REVISION` identifies
what was actually deployed. Keep `BENCHMARK_RUNNER_LABEL` stable across the
baseline and candidate and use only a coarse region in
`BENCHMARK_RUNNER_REGION`. The output allowlists environment fields and never
records credentials, cookies, the full process environment, hostnames, or IPs.

## Statistics and comparison policy

Metric summaries use linearly interpolated type-7 quantiles: position
`(n - 1) × q` in the sorted observations. Each metric records `n`, min, p25,
p50, p75, p95, max, interquartile range (IQR), median absolute deviation (MAD),
scaled MAD (`1.4826 × MAD`), and robust coefficient of variation (scaled MAD
divided by the absolute median). A zero median has no robust CV.

Five samples are suitable for exploratory diagnosis, not an improvement claim.
Use at least 10 baseline and 10 candidate samples on the same runner and
environment for a ledger entry. With fewer than 20 observations p95 is
descriptive only, not a stable tail estimate. Compare cold and warm profiles
separately, report actual `n` and discarded attempts, and reject a latency
claim when the change is not larger than run-to-run spread. A payload or
correctness improvement may still be accepted without a latency claim.

For an isolated HTTP-serving change, place the exact resource paths (one
leading-slash path per line) in a local manifest and benchmark baseline and
candidate origins with the same process and configuration except for the one
change under test:

```bash
BENCHMARK_BASELINE_URL=http://127.0.0.1:18080 \
BENCHMARK_CANDIDATE_URL=http://127.0.0.1:18081 \
BENCHMARK_RESOURCE_MANIFEST=/tmp/resources.txt \
BENCHMARK_SAMPLES=30 BENCHMARK_WARMUPS=5 BENCHMARK_CONCURRENCY=6 \
BENCHMARK_BASELINE='<image and baseline setting>' \
BENCHMARK_DEPLOYMENT_REVISION='<image and candidate setting>' \
BENCHMARK_RUNNER_LABEL='<stable runner class>' \
BENCHMARK_RUNNER_REGION='<coarse region>' \
BENCHMARK_OUTPUT=/tmp/open-suite-http-assets.json \
npm run benchmark:http-assets
```

The HTTP harness alternates paired runs, adds a cache-busting query, and checks
every resource before measurement. It fails if status, decoded SHA-256,
content type/encoding, cache policy, `Vary`, or `Last-Modified` differs. The
report also records ETag and `Accept-Ranges` for each representation without
requiring them to match, because serving a prebuilt encoded representation can
legitimately change both. The manifest's digest and resource count make the
workload exact. Baseline and candidate origins must be isolated instances of
the same application build; do not compare unrelated deployments or use this
origin-serving measurement to claim end-to-end browser readiness.

Capture the Kubernetes resource state on the target server with:

```bash
BENCHMARK_BASELINE='<baseline release or commit>' \
BENCHMARK_DEPLOYMENT_REVISION='<deployed revision>' \
BENCHMARK_ENVIRONMENT='<cluster class and region>' \
sudo -E performance/cluster-snapshot.sh
```

For resource sizing, sample every container repeatedly while a browser workload
is running:

```bash
BENCHMARK_BASELINE='<baseline release or commit>' \
BENCHMARK_WORKLOAD='full-applications' \
BENCHMARK_DEPLOYMENT_REVISION='<deployed revision>' \
BENCHMARK_ENVIRONMENT='<cluster class and region>' \
SAMPLE_DURATION=120 SAMPLE_INTERVAL=2 \
SAMPLE_OUTPUT=/tmp/open-suite-cluster.csv \
sudo -E performance/sample-cluster.sh
```

The sampler writes a sibling metadata file with requested cadence, successful
and failed poll counts, and total container observations. Record distribution
statistics from those observations in the ledger; do not infer resource
variance from one snapshot.

Raw JSON, resource waterfalls, CSV samples, and cluster snapshots are local
artifacts, not committed data. They can expose paths and operational state even
though the harness deliberately omits credentials. Commit only the baseline,
workload, sample count, compatible environment, variance summary,
interpretation, and rejected attempts to `APP-PERFORMANCE-BENCHMARK.md`.
