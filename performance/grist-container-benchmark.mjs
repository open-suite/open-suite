import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { chromium } from "playwright";

import {
  captureEnvironment,
  parsePositiveInteger,
  summarizeValues,
} from "./reporting.mjs";

const samples = parsePositiveInteger(
  process.env.BENCHMARK_SAMPLES,
  10,
  "BENCHMARK_SAMPLES",
);
const output =
  process.env.BENCHMARK_OUTPUT || "grist-container-benchmark-result.json";
const gristImage =
  process.env.BENCHMARK_GRIST_IMAGE ||
  "gristlabs/grist@sha256:0263064906e2fa88063129d1b84a6ae3d33acb090062e510b32f87b7a1c84917";
const postgresImage =
  process.env.BENCHMARK_POSTGRES_IMAGE ||
  "postgres@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4";
const label = process.env.BENCHMARK_LABEL || "restart-shell-isolation";
const runnerLabel = process.env.BENCHMARK_RUNNER_LABEL || "unspecified";
const runnerRegion = process.env.BENCHMARK_RUNNER_REGION || "unspecified";
const runId = `grist-bench-${randomUUID().slice(0, 8)}`;
const network = runId;
const postgres = `${runId}-postgres`;
const databasePassword = randomUUID();
const startedAt = new Date().toISOString();

const docker = (...args) =>
  execFileSync("sudo", ["docker", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const dockerLogs = (container) => {
  const result = spawnSync(
    "sudo",
    ["docker", "logs", "--timestamps", container],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`docker logs failed: ${result.stderr.trim()}`);
  }
  return `${result.stdout}${result.stderr}`.trim();
};

const waitFor = async (probe, timeoutMs, description) => {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${description} timed out${lastError ? `: ${lastError.message}` : ""}`,
  );
};

const parseTimestamp = (line) => {
  const timestamp = line.match(/^(\S+)\s/)?.[1];
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const browser = await chromium.launch({ headless: true });
const results = { baseline: [], candidate: [] };

const runProfile = async (profile, sample) => {
  const database = `${profile}_${sample}`;
  const container = `${runId}-${profile}-${sample}`;
  await waitFor(
    () => {
      try {
        docker("exec", postgres, "createdb", "-U", "grist", database);
        return true;
      } catch {
        return false;
      }
    },
    30_000,
    `creating PostgreSQL database ${database}`,
  );

  const environment = [
    "TYPEORM_TYPE=postgres",
    `TYPEORM_HOST=${postgres}`,
    "TYPEORM_PORT=5432",
    `TYPEORM_DATABASE=${database}`,
    "TYPEORM_USERNAME=grist",
    `TYPEORM_PASSWORD=${databasePassword}`,
    // Match the deployed chart. Query logging is intentionally held constant.
    "TYPEORM_LOGGING=true",
    "GRIST_SANDBOX_FLAVOR=gvisor",
    "GRIST_TEST_LOGIN=1",
    "GRIST_IN_SERVICE=true",
    "GRIST_DEFAULT_EMAIL=benchmark@example.test",
    "GRIST_LOG_LEVEL=info",
  ];
  if (profile === "candidate") environment.push("GRIST_RESTART_SHELL=false");

  const commandStarted = performance.now();
  docker(
    "run",
    "-d",
    "--name",
    container,
    "--network",
    network,
    "-p",
    "127.0.0.1::8484",
    ...environment.flatMap((value) => ["-e", value]),
    gristImage,
  );
  const dockerRunMs = performance.now() - commandStarted;
  const containerStartedAt = Date.parse(
    docker("inspect", "--format", "{{.State.StartedAt}}", container),
  );
  const port = docker("port", container, "8484/tcp").match(/:(\d+)$/)?.[1];
  if (!port) throw new Error(`Could not determine published port for ${container}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  const preReadyStatuses = new Set();

  try {
    await waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/status?ready=1`, {
          signal: AbortSignal.timeout(1_000),
        });
        preReadyStatuses.add(response.status);
        return response.ok;
      },
      30_000,
      `${profile} backend readiness`,
    );
    const backendReadyAt = Date.now();

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "Europe/Amsterdam",
    });
    const page = await context.newPage();
    const docsUrl = `${baseUrl}/o/docs/`;
    const loginUrl = new URL("/test/login", baseUrl);
    loginUrl.searchParams.set("username", "benchmark@example.test");
    loginUrl.searchParams.set("name", "Benchmark User");
    loginUrl.searchParams.set("next", docsUrl);

    const pageStarted = performance.now();
    await page.goto(loginUrl.href, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Blank document" })
      .waitFor({ state: "visible", timeout: 30_000 });
    const authenticatedPageUsableMs = performance.now() - pageStarted;

    const documentStarted = performance.now();
    await page.getByRole("button", { name: "Blank document" }).click();
    await page.waitForURL(/\/o\/docs\/[^/]+\//, { timeout: 30_000 });
    await page
      .locator(".gridview_data_pane")
      .waitFor({ state: "visible", timeout: 30_000 });
    const firstDocumentCreateOpenMs = performance.now() - documentStarted;
    const documentId = new URL(page.url()).pathname.split("/")[3];
    if (!documentId) throw new Error("Created document URL had no document id");
    await context.close();

    const logs = dockerLogs(container).split("\n");
    const databaseStart = logs.find((line) =>
      line.includes("Setting up database..."),
    );
    const databaseComplete = logs.find((line) =>
      line.includes("Database setup complete."),
    );
    const databaseStartAt = databaseStart
      ? parseTimestamp(databaseStart)
      : null;
    const databaseCompleteAt = databaseComplete
      ? parseTimestamp(databaseComplete)
      : null;
    if (databaseStartAt === null || databaseCompleteAt === null) {
      throw new Error("Database initialization markers missing from Grist logs");
    }

    const result = {
      sample,
      docker_run_ms: dockerRunMs,
      container_backend_ready_ms: backendReadyAt - containerStartedAt,
      database_initialization_ms: databaseCompleteAt - databaseStartAt,
      authenticated_page_usable_ms: authenticatedPageUsableMs,
      first_document_create_open_ms: firstDocumentCreateOpenMs,
      sql_log_lines: logs.filter((line) => line.includes("query:")).length,
      pre_ready_http_statuses: [...preReadyStatuses].sort(),
    };
    console.log(
      `${profile} ${sample}/${samples}: backend=${Math.round(result.container_backend_ready_ms)}ms db=${Math.round(result.database_initialization_ms)}ms page=${Math.round(result.authenticated_page_usable_ms)}ms doc=${Math.round(result.first_document_create_open_ms)}ms`,
    );
    return result;
  } finally {
    docker("rm", "-f", container);
    docker("exec", postgres, "dropdb", "-U", "grist", "--if-exists", database);
  }
};

const summarize = (runs) =>
  Object.fromEntries(
    [
      "docker_run_ms",
      "container_backend_ready_ms",
      "database_initialization_ms",
      "authenticated_page_usable_ms",
      "first_document_create_open_ms",
      "sql_log_lines",
    ].map((metric) => [
      metric,
      summarizeValues(runs.map((run) => run[metric])),
    ]),
  );

try {
  docker("pull", gristImage);
  docker("pull", postgresImage);
  docker("network", "create", network);
  docker(
    "run",
    "-d",
    "--name",
    postgres,
    "--network",
    network,
    "-e",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "-e",
    "POSTGRES_USER=grist",
    "-e",
    "POSTGRES_DB=postgres",
    postgresImage,
  );
  await waitFor(
    () => {
      try {
        docker("exec", postgres, "pg_isready", "-U", "grist");
        return true;
      } catch {
        return false;
      }
    },
    30_000,
    "PostgreSQL readiness",
  );

  for (let sample = 1; sample <= samples; sample += 1) {
    const order = sample % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const profile of order) {
      results[profile].push(await runProfile(profile, sample));
    }
  }
} finally {
  await browser.close();
  try {
    docker("rm", "-f", postgres);
  } catch {}
  try {
    docker("network", "rm", network);
  } catch {}
}

const browserVersion = await chromium.launch({ headless: true }).then(async (instance) => {
  const version = await instance.version();
  await instance.close();
  return version;
});
const report = {
  schemaVersion: 1,
  benchmark: {
    name: "grist-container-first-use",
    label,
    startedAt,
    finishedAt: new Date().toISOString(),
    image: gristImage,
    postgresImage,
    resolvedGristImage: docker(
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      gristImage,
    ),
    resolvedPostgresImage: docker(
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      postgresImage,
    ),
    workload:
      "fresh PostgreSQL database; gVisor; authenticated home usable; first blank document usable; database discarded after each run",
  },
  sampling: {
    samplesPerProfile: samples,
    pairedAlternatingOrder: true,
    complete:
      results.baseline.length === samples && results.candidate.length === samples,
  },
  profiles: {
    baseline: "stock Grist 1.7.15 Linux default restart shell",
    candidate: "GRIST_RESTART_SHELL=false; Kubernetes owns process restarts",
  },
  environment: captureEnvironment({
    browserVersion,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezone: "Europe/Amsterdam",
    runnerLabel,
    runnerRegion,
  }),
  results: Object.fromEntries(
    Object.entries(results).map(([profile, runs]) => [
      profile,
      { summary: summarize(runs), runs },
    ]),
  ),
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.results, null, 2));
