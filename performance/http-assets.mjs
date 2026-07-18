import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";

import {
  captureEnvironment,
  parsePositiveInteger,
  sanitizeUrl,
  summarizeValues,
} from "./reporting.mjs";

const baselineUrl = process.env.BENCHMARK_BASELINE_URL;
const candidateUrl = process.env.BENCHMARK_CANDIDATE_URL;
const manifestPath = process.env.BENCHMARK_RESOURCE_MANIFEST;
const samples = parsePositiveInteger(
  process.env.BENCHMARK_SAMPLES,
  30,
  "BENCHMARK_SAMPLES",
);
const warmups = parsePositiveInteger(
  process.env.BENCHMARK_WARMUPS,
  5,
  "BENCHMARK_WARMUPS",
);
const concurrency = parsePositiveInteger(
  process.env.BENCHMARK_CONCURRENCY,
  6,
  "BENCHMARK_CONCURRENCY",
);
const output =
  process.env.BENCHMARK_OUTPUT || "http-assets-benchmark-result.json";
const label = process.env.BENCHMARK_LABEL || "unlabelled";
const baseline = process.env.BENCHMARK_BASELINE || "unspecified";
const deploymentRevision =
  process.env.BENCHMARK_DEPLOYMENT_REVISION || "unspecified";
const runnerLabel = process.env.BENCHMARK_RUNNER_LABEL || "unspecified";
const runnerRegion = process.env.BENCHMARK_RUNNER_REGION || "unspecified";
const startedAt = new Date().toISOString();

if (!baselineUrl || !candidateUrl || !manifestPath) {
  console.error(
    "Set BENCHMARK_BASELINE_URL, BENCHMARK_CANDIDATE_URL, and BENCHMARK_RESOURCE_MANIFEST",
  );
  process.exit(2);
}

const manifest = await readFile(manifestPath, "utf8");
const resourcePaths = manifest
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
if (!resourcePaths.length) throw new Error("Resource manifest is empty");
if (new Set(resourcePaths).size !== resourcePaths.length) {
  throw new Error("Resource manifest contains duplicate paths");
}
for (const path of resourcePaths) {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new Error(
      `Resource paths must stay on the target origin and omit queries/fragments: ${path}`,
    );
  }
}

const request = (baseUrl, path, agent, nonce, captureBody = false) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    url.searchParams.set("benchmark_run", nonce);
    const client = url.protocol === "https:" ? https : http;
    const activeRequest = client.get(
      url,
      {
        agent,
        headers: { "Accept-Encoding": "gzip" },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (captureBody) chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            bytes,
            headers: {
              contentType: response.headers["content-type"] ?? null,
              contentEncoding: response.headers["content-encoding"] ?? null,
              cacheControl: response.headers["cache-control"] ?? null,
              vary: response.headers.vary ?? null,
              lastModified: response.headers["last-modified"] ?? null,
            },
            body: captureBody ? Buffer.concat(chunks) : null,
          });
        });
        response.on("error", reject);
      },
    );
    activeRequest.setTimeout(30_000, () => {
      activeRequest.destroy(new Error(`Timed out requesting ${path}`));
    });
    activeRequest.on("error", reject);
  });

const createAgent = (baseUrl) => {
  const Agent = new URL(baseUrl).protocol === "https:" ? https.Agent : http.Agent;
  return new Agent({ keepAlive: true, maxSockets: concurrency });
};

const run = async (baseUrl, nonce) => {
  const agent = createAgent(baseUrl);
  const runStarted = performance.now();
  const responses = await Promise.all(
    resourcePaths.map((path) => request(baseUrl, path, agent, nonce)),
  );
  const elapsedMs = performance.now() - runStarted;
  agent.destroy();

  if (responses.some(({ status }) => status !== 200)) {
    throw new Error(`Non-200 response in ${sanitizeUrl(baseUrl)} run`);
  }
  return {
    elapsed_ms: elapsedMs,
    encoded_bytes: responses.reduce((sum, response) => sum + response.bytes, 0),
    gzip_responses: responses.filter(
      ({ headers }) => headers.contentEncoding === "gzip",
    ).length,
  };
};

const decode = ({ body, headers }) =>
  headers.contentEncoding === "gzip" ? gunzipSync(body) : body;
const digest = (body) => createHash("sha256").update(body).digest("hex");

const baselineAgent = createAgent(baselineUrl);
const candidateAgent = createAgent(candidateUrl);
const correctness = [];
for (const [index, path] of resourcePaths.entries()) {
  const [baselineResponse, candidateResponse] = await Promise.all([
    request(baselineUrl, path, baselineAgent, `verify-${index}`, true),
    request(candidateUrl, path, candidateAgent, `verify-${index}`, true),
  ]);
  if (baselineResponse.status !== 200 || candidateResponse.status !== 200) {
    throw new Error(`Correctness request failed for ${path}`);
  }
  const baselineDigest = digest(decode(baselineResponse));
  const candidateDigest = digest(decode(candidateResponse));
  if (baselineDigest !== candidateDigest) {
    throw new Error(`Decoded response changed for ${path}`);
  }
  for (const header of [
    "contentType",
    "contentEncoding",
    "cacheControl",
    "vary",
    "lastModified",
  ]) {
    if (baselineResponse.headers[header] !== candidateResponse.headers[header]) {
      throw new Error(`${header} changed for ${path}`);
    }
  }
  if (
    baselineResponse.headers.contentEncoding === "gzip" &&
    !baselineResponse.headers.vary?.toLowerCase().includes("accept-encoding")
  ) {
    throw new Error(`Compressed response does not vary on Accept-Encoding: ${path}`);
  }
  correctness.push({ path, decodedSha256: baselineDigest });
}
baselineAgent.destroy();
candidateAgent.destroy();

for (let index = 0; index < warmups; index += 1) {
  await run(baselineUrl, `warmup-baseline-${index}`);
  await run(candidateUrl, `warmup-candidate-${index}`);
}

const runs = { baseline: [], candidate: [] };
for (let pair = 0; pair < samples; pair += 1) {
  const order =
    pair % 2 === 0
      ? [
          ["baseline", baselineUrl],
          ["candidate", candidateUrl],
        ]
      : [
          ["candidate", candidateUrl],
          ["baseline", baselineUrl],
        ];
  for (const [name, url] of order) {
    runs[name].push({ index: pair + 1, ...(await run(url, `${pair}-${name}`)) });
  }
}

const summarize = (variantRuns) =>
  Object.fromEntries(
    ["elapsed_ms", "encoded_bytes", "gzip_responses"].map((metric) => [
      metric,
      summarizeValues(variantRuns.map((run) => run[metric])),
    ]),
  );

const report = {
  schemaVersion: 2,
  benchmark: {
    name: "paired-http-assets",
    label,
    baseline,
    deploymentRevision,
    workload: "fetch-resource-manifest-with-gzip",
    startedAt,
    finishedAt: new Date().toISOString(),
    targets: {
      baselineOrigin: new URL(baselineUrl).origin,
      candidateOrigin: new URL(candidateUrl).origin,
    },
  },
  sampling: {
    samplesPerVariant: samples,
    warmupsPerVariant: warmups,
    concurrency,
    order: "alternating paired baseline/candidate runs",
  },
  environment: captureEnvironment({
    browser: null,
    browserVersion: null,
    headless: null,
    viewport: null,
    locale: null,
    timezone: null,
    runnerLabel,
    runnerRegion,
  }),
  resourceManifest: {
    path: manifestPath,
    sha256: digest(Buffer.from(manifest)),
    resources: resourcePaths.length,
  },
  correctness,
  results: {
    baseline: { summary: summarize(runs.baseline), runs: runs.baseline },
    candidate: { summary: summarize(runs.candidate), runs: runs.candidate },
  },
};

await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.results, null, 2));
