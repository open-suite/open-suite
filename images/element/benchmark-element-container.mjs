import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

const baseline =
  process.env.ELEMENT_BASELINE_IMAGE ||
  "ghcr.io/open-suite/element-web:sha-253492c";
const candidate = process.env.ELEMENT_CANDIDATE_IMAGE;
const samples = Number(process.env.ELEMENT_CONTAINER_SAMPLES || 20);
const output =
  process.env.ELEMENT_BENCHMARK_OUTPUT || "/tmp/element-container-startup.json";
const [engine, ...enginePrefix] = (
  process.env.ELEMENT_CONTAINER_ENGINE || "podman"
).split(/\s+/);

if (!candidate) throw new Error("Set ELEMENT_CANDIDATE_IMAGE");
if (!Number.isInteger(samples) || samples < 1) {
  throw new Error("ELEMENT_CONTAINER_SAMPLES must be a positive integer");
}

const run = (args, options = {}) =>
  execFileSync(engine, [...enginePrefix, ...args], {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : undefined,
  }).trim();
const inspect = (image) => JSON.parse(run(["image", "inspect", image], { quiet: true }))[0];
const imageMetadata = Object.fromEntries(
  [baseline, candidate].map((image) => {
    const metadata = inspect(image);
    return [
      image,
      {
        id: metadata.Id,
        unpacked_bytes: metadata.Size,
        rootfs_layers: metadata.RootFS.Layers.length,
      },
    ];
  }),
);

for (const image of [baseline, candidate]) {
  run([
    "run",
    "--rm",
    "--cap-add=NET_BIND_SERVICE",
    image,
    "nginx",
    "-t",
  ]);
}

const runs = [];
for (let round = 0; round < samples; round += 1) {
  const order = round % 2 === 0 ? [baseline, candidate] : [candidate, baseline];
  for (const image of order) {
    const variant = image === baseline ? "baseline" : "candidate";
    const name = `element-benchmark-${process.pid}-${round}-${variant}`;
    try {
      const createStarted = performance.now();
      run([
        "create",
        "--cap-add=NET_BIND_SERVICE",
        "--name",
        name,
        "-p",
        "127.0.0.1::80",
        image,
      ], { quiet: true });
      const createMs = performance.now() - createStarted;

      const startStarted = performance.now();
      run(["start", name], { quiet: true });
      const startApiMs = performance.now() - startStarted;
      const address = run(["port", name, "80/tcp"], { quiet: true });
      const target = `http://${address}/config.json`;
      const deadline = performance.now() + 5_000;
      while (true) {
        try {
          const response = await fetch(target, { cache: "no-store" });
          if (response.ok) break;
        } catch {
          // The listener is not ready yet.
        }
        if (performance.now() >= deadline) {
          throw new Error(`${image} did not serve config.json within five seconds`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const healthMs = performance.now() - startStarted;
      runs.push({
        sample: round + 1,
        variant,
        image,
        create_ms: createMs,
        start_api_ms: startApiMs,
        start_to_health_ms: healthMs,
      });
      console.log(
        `${variant} ${round + 1}/${samples}: create=${createMs.toFixed(1)}ms health=${healthMs.toFixed(1)}ms`,
      );
    } finally {
      try {
        run(["rm", "-f", name], { quiet: true });
      } catch {
        // Preserve the benchmark error if container creation itself failed.
      }
    }
  }
}

const quantile = (values, fraction) => {
  const sorted = values.slice().sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};
const summarize = (values) => {
  const median = quantile(values, 0.5);
  const p25 = quantile(values, 0.25);
  const p75 = quantile(values, 0.75);
  return {
    n: values.length,
    min: Math.min(...values),
    p25,
    p50: median,
    p75,
    p95: quantile(values, 0.95),
    max: Math.max(...values),
    iqr: p75 - p25,
    mad: quantile(values.map((value) => Math.abs(value - median)), 0.5),
  };
};
const summary = Object.fromEntries(
  ["baseline", "candidate"].map((variant) => [
    variant,
    Object.fromEntries(
      ["create_ms", "start_api_ms", "start_to_health_ms"].map((metric) => [
        metric,
        summarize(
          runs.filter((run) => run.variant === variant).map((run) => run[metric]),
        ),
      ]),
    ),
  ]),
);
const report = {
  benchmark: "element-container-create-and-health",
  captured_at: new Date().toISOString(),
  engine: `${engine} ${enginePrefix.join(" ")}`.trim(),
  profile: "warm local images; alternating order; identical nginx /config.json health request",
  images: imageMetadata,
  summary,
  runs,
};
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
