import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { chromium } from "playwright";

import { parsePositiveInteger, summarizeValues } from "./reporting.mjs";

const samples = parsePositiveInteger(
  process.env.BENCHMARK_SAMPLES,
  5,
  "BENCHMARK_SAMPLES",
);
const output =
  process.env.BENCHMARK_OUTPUT || "grist-upgrade-benchmark-result.json";
const sourceImage =
  process.env.BENCHMARK_SOURCE_IMAGE ||
  "gristlabs/grist@sha256:d9d35c82799bfa2e0438bb60385fb0b550465dabde2a6e0ceca8afec1aae3305";
const candidateImage =
  process.env.BENCHMARK_CANDIDATE_IMAGE ||
  "gristlabs/grist@sha256:0263064906e2fa88063129d1b84a6ae3d33acb090062e510b32f87b7a1c84917";
const postgresImage =
  process.env.BENCHMARK_POSTGRES_IMAGE ||
  "postgres@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4";
const expectedSourceVersion = "1.6.1";
const expectedCandidateVersion = "1.7.15";
const runId = `grist-upgrade-${randomUUID().slice(0, 8)}`;
const network = runId;
const postgres = `${runId}-postgres`;
const password = randomUUID();
const workloadMarker = `upgrade-marker-${randomUUID()}`;
const sourceDirectory = await mkdtemp(join(tmpdir(), "grist-1.6.1-source-"));
const dumpPath = join(sourceDirectory, "home-db.dump");
const browser = await chromium.launch({ headless: true });
const runs = [];

const docker = (...args) =>
  execFileSync("sudo", ["docker", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const removeContainerOwnedPath = (target) => {
  const resolved = resolve(target);
  const expectedPrefix = `${resolve(tmpdir())}${sep}grist-`;
  if (!resolved.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to remove unexpected path: ${resolved}`);
  }
  execFileSync("sudo", ["rm", "-rf", "--", resolved]);
};

const imageVersion = (image) =>
  docker(
    "run",
    "--rm",
    "--entrypoint",
    "node",
    image,
    "-p",
    "require('./package.json').version",
  );

const dockerLogs = (container) => {
  const result = spawnSync(
    "sudo",
    ["docker", "logs", "--timestamps", container],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return `${result.stdout}${result.stderr}`.trim().split("\n");
};

const waitFor = async (probe, timeoutMs, description) => {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${description} timed out${lastError ? `: ${lastError.message}` : ""}`,
  );
};

const publishedUrl = (container) => {
  const port = docker("port", container, "8484/tcp").match(/:(\d+)$/)?.[1];
  if (!port) throw new Error(`No published Grist port for ${container}`);
  return `http://127.0.0.1:${port}`;
};

const waitUntilReady = (baseUrl) =>
  waitFor(
    async () => {
      const response = await fetch(`${baseUrl}/status?ready=1`, {
        signal: AbortSignal.timeout(1_000),
      });
      return response.ok;
    },
    50_000,
    "Grist ready endpoint",
  );

const gristEnvironment = (database) => [
  "TYPEORM_TYPE=postgres",
  `TYPEORM_HOST=${postgres}`,
  "TYPEORM_PORT=5432",
  `TYPEORM_DATABASE=${database}`,
  "TYPEORM_USERNAME=grist",
  `TYPEORM_PASSWORD=${password}`,
  "TYPEORM_LOGGING=true",
  "GRIST_SANDBOX_FLAVOR=gvisor",
  "GRIST_TEST_LOGIN=1",
  "GRIST_IN_SERVICE=true",
  "GRIST_DEFAULT_EMAIL=upgrade@example.test",
  "GRIST_LOG_LEVEL=info",
  "GRIST_ALLOW_AUTOMATIC_VERSION_CHECKING=false",
];

const startGrist = ({ container, database, image, persist, direct }) => {
  const environment = gristEnvironment(database);
  if (direct) environment.push("GRIST_RESTART_SHELL=false");
  docker(
    "run",
    "-d",
    "--name",
    container,
    "--network",
    network,
    "-p",
    "127.0.0.1::8484",
    "-v",
    `${persist}:/persist`,
    ...environment.flatMap((value) => ["-e", value]),
    image,
  );
};

const loginUrl = (baseUrl, next) => {
  const url = new URL("/test/login", baseUrl);
  url.searchParams.set("username", "upgrade@example.test");
  url.searchParams.set("name", "Upgrade Benchmark");
  url.searchParams.set("next", next);
  return url.href;
};

const query = (database, sql) =>
  docker(
    "exec",
    postgres,
    "psql",
    "-U",
    "grist",
    "-d",
    database,
    "-At",
    "-c",
    sql,
  );

const schemaState = (database) => {
  const [migrations, users, orgs, workspaces, docs] = query(
    database,
    "SELECT (SELECT count(*) FROM migrations), (SELECT count(*) FROM users), (SELECT count(*) FROM orgs), (SELECT count(*) FROM workspaces), (SELECT count(*) FROM docs);",
  )
    .split("|")
    .map(Number);
  if (![migrations, users, orgs, workspaces, docs].every(Number.isInteger)) {
    throw new Error(`Could not read schema state for ${database}`);
  }
  return { migrations, users, orgs, workspaces, docs };
};

const assertDocumentMarker = async (request, baseUrl, documentId) => {
  const response = await request.get(
    `${baseUrl}/api/docs/${encodeURIComponent(documentId)}/tables/Table1/records`,
  );
  if (!response.ok()) {
    throw new Error(`Could not read persisted document: HTTP ${response.status()}`);
  }
  const body = await response.json();
  if (
    body.records?.length !== 1 ||
    body.records[0]?.fields?.A !== workloadMarker
  ) {
    throw new Error("Persisted document marker was not preserved");
  }
};

const parseTimestamp = (line) => Date.parse(line.match(/^(\S+)\s/)?.[1] || "");

try {
  docker("pull", sourceImage);
  docker("pull", candidateImage);
  docker("pull", postgresImage);
  const actualSourceVersion = imageVersion(sourceImage);
  const actualCandidateVersion = imageVersion(candidateImage);
  if (actualSourceVersion !== expectedSourceVersion) {
    throw new Error(
      `Source digest is Grist ${actualSourceVersion}, expected ${expectedSourceVersion}`,
    );
  }
  if (actualCandidateVersion !== expectedCandidateVersion) {
    throw new Error(
      `Candidate digest is Grist ${actualCandidateVersion}, expected ${expectedCandidateVersion}`,
    );
  }
  docker("network", "create", network);
  docker(
    "run",
    "-d",
    "--name",
    postgres,
    "--network",
    network,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
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
    "PostgreSQL",
  );

  const sourceDatabase = "source_1_6_1";
  await waitFor(
    () => {
      try {
        docker("exec", postgres, "createdb", "-U", "grist", sourceDatabase);
        return true;
      } catch {
        return false;
      }
    },
    30_000,
    "creating source database",
  );
  const sourceContainer = `${runId}-source`;
  const sourcePersist = join(sourceDirectory, "persist");
  startGrist({
    container: sourceContainer,
    database: sourceDatabase,
    image: sourceImage,
    persist: sourcePersist,
    direct: false,
  });
  const sourceUrl = publishedUrl(sourceContainer);
  await waitUntilReady(sourceUrl);

  const sourcePage = await browser.newPage();
  const sourceDocsUrl = `${sourceUrl}/o/docs/`;
  await sourcePage.goto(loginUrl(sourceUrl, sourceDocsUrl), {
    waitUntil: "domcontentloaded",
  });
  await sourcePage
    .getByRole("button", { name: "Blank document" })
    .waitFor({ state: "visible", timeout: 30_000 });
  await sourcePage.getByRole("button", { name: "Blank document" }).click();
  await sourcePage.waitForURL(/\/o\/docs\/[^/]+\//, { timeout: 30_000 });
  await sourcePage
    .locator(".gridview_data_pane")
    .waitFor({ state: "visible", timeout: 30_000 });
  const documentId = new URL(sourcePage.url()).pathname.split("/")[3];
  if (!documentId) throw new Error("1.6.1 source document has no id");
  const seedResponse = await sourcePage.request.post(
    `${sourceUrl}/api/docs/${encodeURIComponent(documentId)}/tables/Table1/records`,
    { data: { records: [{ fields: { A: workloadMarker } }] } },
  );
  if (!seedResponse.ok()) {
    throw new Error(`Could not seed source document: HTTP ${seedResponse.status()}`);
  }
  await assertDocumentMarker(sourcePage.request, sourceUrl, documentId);
  await sourcePage.close();
  docker("stop", "--time", "15", sourceContainer);
  docker("rm", sourceContainer);

  const sourceState = schemaState(sourceDatabase);
  if (sourceState.users < 5 || sourceState.orgs < 2 || sourceState.docs !== 1) {
    throw new Error(`1.6.1 representative schema is incomplete: ${JSON.stringify(sourceState)}`);
  }
  docker(
    "exec",
    postgres,
    "pg_dump",
    "-U",
    "grist",
    "-d",
    sourceDatabase,
    "-Fc",
    "-f",
    "/tmp/grist-1.6.1.dump",
  );
  docker("cp", `${postgres}:/tmp/grist-1.6.1.dump`, dumpPath);
  docker("cp", dumpPath, `${postgres}:/tmp/grist-1.6.1.dump`);

  for (let sample = 1; sample <= samples; sample += 1) {
    const database = `upgrade_${sample}`;
    const container = `${runId}-candidate-${sample}`;
    const persist = join(sourceDirectory, `persist-${sample}`);
    await cp(sourcePersist, persist, { recursive: true });
    docker("exec", postgres, "createdb", "-U", "grist", database);
    docker(
      "exec",
      postgres,
      "pg_restore",
      "-U",
      "grist",
      "-d",
      database,
      "--no-owner",
      "/tmp/grist-1.6.1.dump",
    );

    startGrist({
      container,
      database,
      image: candidateImage,
      persist,
      direct: true,
    });
    const baseUrl = publishedUrl(container);
    const containerStartedAt = Date.parse(
      docker("inspect", "--format", "{{.State.StartedAt}}", container),
    );
    await waitUntilReady(baseUrl);
    const backendReadyAt = Date.now();
    const upgradedState = schemaState(database);
    for (const key of ["users", "orgs", "workspaces", "docs"]) {
      if (upgradedState[key] !== sourceState[key]) {
        throw new Error(`${key} changed during upgrade: ${sourceState[key]} -> ${upgradedState[key]}`);
      }
    }
    if (upgradedState.migrations <= sourceState.migrations) {
      throw new Error("1.7.15 applied no migrations to the 1.6.1 schema");
    }

    const page = await browser.newPage();
    const documentStarted = performance.now();
    const documentUrl = `${baseUrl}/o/docs/${documentId}/`;
    await page.goto(loginUrl(baseUrl, documentUrl), {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator(".gridview_data_pane")
      .waitFor({ state: "visible", timeout: 30_000 });
    await assertDocumentMarker(page.request, baseUrl, documentId);
    const existingDocumentOpenMs = performance.now() - documentStarted;
    await page.close();

    const logs = dockerLogs(container);
    const databaseStart = logs.find((line) => line.includes("Setting up database..."));
    const databaseComplete = logs.find((line) => line.includes("Database setup complete."));
    if (!databaseStart || !databaseComplete) {
      throw new Error("Upgrade database markers are missing");
    }
    runs.push({
      sample,
      container_backend_ready_ms: backendReadyAt - containerStartedAt,
      home_database_setup_ms:
        parseTimestamp(databaseComplete) - parseTimestamp(databaseStart),
      existing_document_open_ms: existingDocumentOpenMs,
      source_state: sourceState,
      upgraded_state: upgradedState,
    });
    console.log(
      `${sample}/${samples}: ready=${runs.at(-1).container_backend_ready_ms}ms db-setup=${runs.at(-1).home_database_setup_ms}ms doc=${Math.round(existingDocumentOpenMs)}ms`,
    );
    docker("rm", "-f", container);
    docker("exec", postgres, "dropdb", "-U", "grist", "--if-exists", database);
    removeContainerOwnedPath(persist);
  }

  const report = {
    schemaVersion: 1,
    benchmark: {
      name: "grist-1.6.1-to-1.7.15-upgrade",
      sourceImage,
      candidateImage,
      postgresImage,
      expectedSourceVersion,
      expectedCandidateVersion,
      sourceState,
      representativeWorkload:
        "1.6.1 initialized home schema, test user/personal org/workspace, and one opened document containing a verified marker; copied DB and persist directory per sample",
    },
    sampling: { requested: samples, completed: runs.length, complete: runs.length === samples },
    summary: {
      container_backend_ready_ms: summarizeValues(
        runs.map((run) => run.container_backend_ready_ms),
      ),
      home_database_setup_ms: summarizeValues(
        runs.map((run) => run.home_database_setup_ms),
      ),
      existing_document_open_ms: summarizeValues(
        runs.map((run) => run.existing_document_open_ms),
      ),
    },
    runs,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (!report.sampling.complete) process.exitCode = 1;
} finally {
  await browser.close();
  try {
    docker("rm", "-f", ...docker("ps", "-aq", "--filter", `name=${runId}`).split("\n").filter(Boolean));
  } catch {}
  try {
    docker("network", "rm", network);
  } catch {}
  removeContainerOwnedPath(sourceDirectory);
}
