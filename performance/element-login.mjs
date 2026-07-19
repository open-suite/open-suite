import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

import { chromium } from "playwright";

import {
  captureEnvironment,
  parsePositiveInteger,
  sanitizeUrl,
  summarizeValues,
} from "./reporting.mjs";

const baseUrl =
  process.env.BENCHMARK_URL || "https://bridge.demo.opensuite.online";
const username = process.env.BENCHMARK_USER;
const password = process.env.BENCHMARK_PASS;
const attempts = parsePositiveInteger(
  process.env.BENCHMARK_ATTEMPTS,
  10,
  "BENCHMARK_ATTEMPTS",
);
const output =
  process.env.BENCHMARK_OUTPUT || "element-login-benchmark-result.json";
const label = process.env.BENCHMARK_LABEL || "unlabelled";
const baseline = process.env.BENCHMARK_BASELINE || "unspecified";
const deploymentRevision =
  process.env.BENCHMARK_DEPLOYMENT_REVISION || "unspecified";
const runnerLabel = process.env.BENCHMARK_RUNNER_LABEL || "unspecified";
const runnerRegion = process.env.BENCHMARK_RUNNER_REGION || "unspecified";
const startedAt = new Date().toISOString();

if (!username || !password) {
  console.error("Set BENCHMARK_USER and BENCHMARK_PASS");
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const bootstrapContext = await browser.newContext();
const bootstrapPage = await bootstrapContext.newPage();
await bootstrapPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
if (new URL(bootstrapPage.url()).hostname.startsWith("id.")) {
  await bootstrapPage.locator("#username").fill(username);
  await bootstrapPage.locator("#password").fill(password);
  await bootstrapPage.locator("#kc-login").click();
}
await bootstrapPage.waitForURL(`${baseUrl}/**`, { timeout: 30_000 });
await bootstrapPage.locator(".dashboard-grid").waitFor({ timeout: 30_000 });
const portalState = await bootstrapContext.storageState();
await bootstrapContext.close();

const results = [];
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const context = await browser.newContext({
    storageState: portalState,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const rateLimits = [];
  page.on("response", (response) => {
    if (response.status() === 429) {
      rateLimits.push({
        status: response.status(),
        url: sanitizeUrl(response.url()),
      });
    }
  });

  const started = performance.now();
  let error = null;
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".dashboard-grid").waitFor({ timeout: 30_000 });
    await page
      .locator("#ko-portal-header")
      .getByRole("link", { name: "Chat", exact: true })
      .click();
    const outcome = await Promise.race([
      page
        .locator(".mx_RoomListItemView")
        .first()
        .waitFor({ state: "visible", timeout: 45_000 })
        .then(() => ({ ready: true })),
      page
        .waitForResponse(
          (response) =>
            response.status() === 429 &&
            response.url().includes("/_matrix/client/"),
          { timeout: 45_000 },
        )
        .then((response) => ({
          ready: false,
          url: sanitizeUrl(response.url()),
        })),
    ]);
    if (!outcome.ready) throw new Error(`Matrix login rate limited: ${outcome.url}`);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  results.push({
    attempt,
    success: error === null,
    elapsed_ms: Math.round(performance.now() - started),
    rate_limits: rateLimits,
    final_url: sanitizeUrl(page.url()),
    error,
  });
  await context.close();
}

const browserVersion = await browser.version();
await browser.close();

const successfulResults = results.filter((result) => result.success);
const failedResults = results.filter((result) => !result.success);
const rateLimitedAttempts = results.filter((result) =>
  result.rate_limits.some(({ url }) => url?.includes("/_matrix/client/")),
).length;
const report = {
  schemaVersion: 2,
  benchmark: {
    name: "element-isolated-login",
    label,
    baseline,
    deploymentRevision,
    workload: "isolated-context-portal-sso-to-element-room-list",
    startedAt,
    finishedAt: new Date().toISOString(),
    targetOrigin: new URL(baseUrl).origin,
  },
  sampling: {
    attempts,
    successes: successfulResults.length,
    failures: failedResults.length,
    successRate: successfulResults.length / attempts,
    rateLimitedAttempts,
    rateLimitedRate: rateLimitedAttempts / attempts,
  },
  environment: captureEnvironment({
    browserVersion,
    viewport: { width: 1440, height: 900 },
    locale: "browser default",
    timezone: "browser default",
    runnerLabel,
    runnerRegion,
  }),
  elapsedMs: {
    all: summarizeValues(results.map((result) => result.elapsed_ms)),
    successful: summarizeValues(
      successfulResults.map((result) => result.elapsed_ms),
    ),
    failed: summarizeValues(failedResults.map((result) => result.elapsed_ms)),
  },
  results,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (
  report.sampling.successes !== attempts ||
  report.sampling.rateLimitedAttempts !== 0
) {
  process.exitCode = 1;
}
