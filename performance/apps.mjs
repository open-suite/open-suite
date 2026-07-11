import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

import { chromium } from "playwright";

const baseUrl =
  process.env.BENCHMARK_URL || "https://bridge.demo.opensuite.online";
const username = process.env.BENCHMARK_USER;
const password = process.env.BENCHMARK_PASS;
const samples = Number(process.env.BENCHMARK_SAMPLES || 5);
const pacingMs = Number(process.env.BENCHMARK_PACING_MS || 1000);
const traceResources = process.env.BENCHMARK_TRACE_RESOURCES === "true";
const output = process.env.BENCHMARK_OUTPUT || "app-benchmark-result.json";
const label = process.env.BENCHMARK_LABEL || "unlabelled";
const selectedApps = new Set(
  (process.env.BENCHMARK_APPS || "nextcloud,element").split(","),
);

if (!username || !password) {
  console.error("Set BENCHMARK_USER and BENCHMARK_PASS");
  process.exit(2);
}

const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.ceil(fraction * sorted.length) - 1];
};

const summarize = (runs) => {
  const keys = [...new Set(runs.flatMap((run) => Object.keys(run.metrics)))];
  return Object.fromEntries(
    keys.map((key) => {
      const values = runs
        .map((run) => run.metrics[key])
        .filter(Number.isFinite);
      return [
        key,
        {
          n: values.length,
          p50: percentile(values, 0.5),
          p75: percentile(values, 0.75),
          p95: percentile(values, 0.95),
          min: values.length ? Math.min(...values) : null,
          max: values.length ? Math.max(...values) : null,
        },
      ];
    }),
  );
};

const appDefinitions = {
  nextcloud: {
    hostname: "nextcloud.",
    async open(page) {
      const header = page.locator("#ko-portal-header");
      const office = header
        .locator(".ko-item > .ko-link")
        .filter({ hasText: "Office" });
      await office.click();
      await header
        .getByRole("link", { name: "Documents", exact: true })
        .click();
    },
    async waitUntilReady(page) {
      await page
        .getByText(/Documents found/)
        .waitFor({ state: "visible", timeout: 45_000 });
    },
  },
  element: {
    hostname: "element.",
    async open(page) {
      await page
        .locator("#ko-portal-header")
        .getByRole("link", { name: "Chat", exact: true })
        .click();
    },
    async waitUntilReady(page) {
      await page
        .locator(".mx_RoomListItemView")
        .first()
        .waitFor({ state: "visible", timeout: 45_000 });
    },
  },
};

for (const app of selectedApps) {
  if (!appDefinitions[app]) throw new Error(`Unknown app: ${app}`);
}

const browser = await chromium.launch({ headless: true });
const bootstrapContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  timezoneId: "Europe/Amsterdam",
});
const bootstrapPage = await bootstrapContext.newPage();
await bootstrapPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
if (new URL(bootstrapPage.url()).hostname.startsWith("id.")) {
  await bootstrapPage.locator("#username").fill(username);
  await bootstrapPage.locator("#password").fill(password);
  await bootstrapPage.locator("#kc-login").click();
}
await bootstrapPage.waitForURL(`${baseUrl}/**`, { timeout: 30_000 });
await bootstrapPage
  .locator(".dashboard-grid")
  .waitFor({ state: "visible", timeout: 30_000 });
const storageState = await bootstrapContext.storageState();
await bootstrapContext.close();

const installObservers = async (context) => {
  await context.addInitScript(() => {
    const state = {
      longTaskMs: 0,
      longTaskCount: 0,
      longestTaskMs: 0,
      lcpMs: null,
      spinnerStarted: null,
      spinnerMs: 0,
    };
    window.__openSuiteAppBenchmark = state;

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTaskMs += entry.duration;
        state.longTaskCount += 1;
        state.longestTaskMs = Math.max(state.longestTaskMs, entry.duration);
      }
    }).observe({ type: "longtask", buffered: true });

    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      state.lcpMs = entries.at(-1)?.startTime ?? state.lcpMs;
    }).observe({ type: "largest-contentful-paint", buffered: true });

    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    };
    const sampleSpinner = () => {
      const now = performance.now();
      const candidates = document.querySelectorAll(
        '[role="progressbar"], .icon-loading-small, .mx_Spinner, .loading, .spinner',
      );
      const active = [...candidates].some(visible);
      if (active && state.spinnerStarted === null) state.spinnerStarted = now;
      if (!active && state.spinnerStarted !== null) {
        state.spinnerMs += now - state.spinnerStarted;
        state.spinnerStarted = null;
      }
      requestAnimationFrame(sampleSpinner);
    };
    addEventListener(
      "DOMContentLoaded",
      () => requestAnimationFrame(sampleSpinner),
      { once: true },
    );
  });
};

const collectMetrics = async (page, journeyMs) =>
  page.evaluate(({ measuredJourneyMs, includeResources }) => {
    const state = window.__openSuiteAppBenchmark;
    const now = performance.now();
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const scripts = resources.filter(
      (resource) => resource.initiatorType === "script",
    );
    const styles = resources.filter(
      (resource) =>
        resource.initiatorType === "link" &&
        new URL(resource.name).pathname.endsWith(".css"),
    );
    const sum = (entries, key) =>
      entries.reduce((total, entry) => total + (entry[key] || 0), 0);
    const fcp = performance
      .getEntriesByType("paint")
      .find((entry) => entry.name === "first-contentful-paint");
    const metrics = {
      journey_ready_ms: measuredJourneyMs,
      ttfb_ms: navigation?.responseStart,
      dom_interactive_ms: navigation?.domInteractive,
      dcl_ms: navigation?.domContentLoadedEventEnd,
      load_ms: navigation?.loadEventEnd,
      fcp_ms: fcp?.startTime,
      lcp_ms: state?.lcpMs,
      long_task_ms: state?.longTaskMs ?? 0,
      long_task_count: state?.longTaskCount ?? 0,
      longest_task_ms: state?.longestTaskMs ?? 0,
      spinner_ms:
        (state?.spinnerMs ?? 0) +
        (state?.spinnerStarted == null ? 0 : now - state.spinnerStarted),
      request_count: resources.length + 1,
      transfer_kib:
        (sum(resources, "transferSize") + (navigation?.transferSize || 0)) /
        1024,
      encoded_kib:
        (sum(resources, "encodedBodySize") +
          (navigation?.encodedBodySize || 0)) /
        1024,
      decoded_kib:
        (sum(resources, "decodedBodySize") +
          (navigation?.decodedBodySize || 0)) /
        1024,
      script_count: scripts.length,
      script_encoded_kib: sum(scripts, "encodedBodySize") / 1024,
      script_decoded_kib: sum(scripts, "decodedBodySize") / 1024,
      style_count: styles.length,
      style_encoded_kib: sum(styles, "encodedBodySize") / 1024,
    };
    if (includeResources) {
      metrics.resources = resources.map((resource) => ({
        url: resource.name,
        initiator: resource.initiatorType,
        start_ms: resource.startTime,
        duration_ms: resource.duration,
        response_end_ms: resource.responseEnd,
        encoded_kib: resource.encodedBodySize / 1024,
        decoded_kib: resource.decodedBodySize / 1024,
      }));
    }
    return metrics;
  }, { measuredJourneyMs: journeyMs, includeResources: traceResources });

const results = {};
const sessionBootstrapMs = {};
for (const [appName, definition] of Object.entries(appDefinitions)) {
  if (!selectedApps.has(appName)) continue;
  const coldRuns = [];
  const warmRuns = [];
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "Europe/Amsterdam",
  });
  await installObservers(context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page
    .locator(".dashboard-grid")
    .waitFor({ state: "visible", timeout: 30_000 });

  const bootstrapStarted = performance.now();
  await definition.open(page);
  await definition.waitUntilReady(page);
  sessionBootstrapMs[appName] = performance.now() - bootstrapStarted;

  let attempts = 0;
  const maxAttempts = samples + 3;
  while (coldRuns.length < samples && attempts < maxAttempts) {
    attempts += 1;
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page
      .locator(".dashboard-grid")
      .waitFor({ state: "visible", timeout: 30_000 });
    await cdp.send("Network.clearBrowserCache");

    try {
      const coldStarted = performance.now();
      await definition.open(page);
      await definition.waitUntilReady(page);
      const coldReadyMs = performance.now() - coldStarted;
      await page.waitForTimeout(250);
      const coldMetrics = await collectMetrics(page, coldReadyMs);

      const warmStarted = performance.now();
      await page.reload({ waitUntil: "domcontentloaded" });
      await definition.waitUntilReady(page);
      const warmReadyMs = performance.now() - warmStarted;
      await page.waitForTimeout(250);
      const warmMetrics = await collectMetrics(page, warmReadyMs);
      coldRuns.push({ index: coldRuns.length + 1, metrics: coldMetrics });
      warmRuns.push({ index: warmRuns.length + 1, metrics: warmMetrics });

      console.log(
        `${appName} ${coldRuns.length}/${samples}: cold=${Math.round(coldReadyMs)}ms warm=${Math.round(warmReadyMs)}ms cold-js=${Math.round(coldMetrics.script_encoded_kib)}KiB`,
      );
    } catch (error) {
      const diagnostic = await page
        .locator("body")
        .innerText()
        .then((body) => body.replace(/\s+/g, " ").slice(0, 160))
        .catch(() => "body unavailable");
      console.warn(
        `discarded ${appName} attempt ${attempts}: ${error.message.split("\n")[0]} url=${page.url()} body=${diagnostic}`,
      );
    }
    if (pacingMs > 0)
      await new Promise((resolve) => setTimeout(resolve, pacingMs));
  }

  results[appName] = {
    discardedAttempts: attempts - coldRuns.length,
    cold: { summary: summarize(coldRuns), runs: coldRuns },
    warm: { summary: summarize(warmRuns), runs: warmRuns },
  };
  await context.close();
}

const result = {
  schemaVersion: 1,
  label,
  capturedAt: new Date().toISOString(),
  target: baseUrl,
  browser: await browser.version(),
  profile: {
    viewport: "1440x900",
    locale: "en-US",
    timezone: "Europe/Amsterdam",
    cold: "cleared HTTP cache with established portal and application sessions; app origin is unloaded between samples",
    warm: "same-context reload after the app establishes its own session and cache",
  },
  sessionBootstrapMs,
  samples,
  pacingMs,
  apps: results,
};

await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result.apps, null, 2));
await browser.close();
