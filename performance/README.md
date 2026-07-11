# Application performance harness

The browser harness measures cold SSO navigation and same-context warm reloads
for the full Nextcloud and Element applications. It records useful-content
readiness, navigation/paint timings, long tasks, spinner exposure, request
counts and transferred/decoded asset sizes.

```bash
cd performance
npm ci
npx playwright install chromium
BENCHMARK_USER=johndoe \
BENCHMARK_PASS='<demo password>' \
BENCHMARK_SAMPLES=5 \
BENCHMARK_LABEL='<release-or-candidate>' \
BENCHMARK_OUTPUT=/tmp/open-suite-apps.json \
npm run benchmark:apps
```

Exercise isolated Element sessions in a burst to detect false login throttling:

```bash
BENCHMARK_USER=johndoe \
BENCHMARK_PASS='<demo password>' \
BENCHMARK_ATTEMPTS=10 \
npm run benchmark:element-login
```

Limit a run with `BENCHMARK_APPS=nextcloud` or `BENCHMARK_APPS=element`.

Capture the Kubernetes resource state on the target server with:

```bash
sudo performance/cluster-snapshot.sh
```

For resource sizing, sample every container repeatedly while a browser workload
is running:

```bash
SAMPLE_DURATION=120 SAMPLE_INTERVAL=2 \
SAMPLE_OUTPUT=/tmp/open-suite-cluster.csv \
sudo performance/sample-cluster.sh
```

Raw JSON and cluster snapshots are artifacts, not committed data. Summaries and
interpretation belong in `APP-PERFORMANCE-BENCHMARK.md`.
