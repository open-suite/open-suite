import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const imageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(imageDir, "../..");
const appDir = path.resolve(process.env.ELEMENT_APP_DIR || "/tmp/element-image/app");
const samples = Number(process.env.ELEMENT_BROWSER_SAMPLES || 10);
const output =
  process.env.ELEMENT_BENCHMARK_OUTPUT || "/tmp/element-browser-startup.json";

if (!Number.isInteger(samples) || samples < 1) {
  throw new Error("ELEMENT_BROWSER_SAMPLES must be a positive integer");
}
if (!fs.existsSync(path.join(appDir, "index.html"))) {
  throw new Error(`Element app not found at ${appDir}; extract the image's /app first`);
}

const playwrightModule = path.join(
  repoRoot,
  "performance/node_modules/playwright/index.mjs",
);
if (!fs.existsSync(playwrightModule)) {
  throw new Error("Run `npm ci --prefix performance` and `npx --prefix performance playwright install chromium`");
}
const { chromium } = await import(pathToFileURL(playwrightModule));

const mimeTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

let port;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://element.test");
  const sendJson = (value) => {
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify(value));
  };

  if (url.pathname === "/config.json") {
    sendJson({
      default_server_config: {
        "m.homeserver": {
          base_url: `http://127.0.0.1:${port}`,
          server_name: `127.0.0.1:${port}`,
        },
      },
      disable_custom_urls: true,
      disable_guests: true,
      setting_defaults: { language: "en" },
      sso_redirect_options: { immediate: false },
    });
    return;
  }
  if (url.pathname.endsWith("/_matrix/client/versions")) {
    sendJson({ versions: ["v1.1", "v1.6", "v1.11"], unstable_features: {} });
    return;
  }
  if (
    url.pathname.endsWith("/_matrix/client/v3/login") ||
    url.pathname.endsWith("/_matrix/client/r0/login")
  ) {
    sendJson({
      flows: [
        {
          type: "m.login.sso",
          identity_providers: [{ id: "mock-oidc", name: "Open Suite SSO" }],
        },
      ],
    });
    return;
  }
  if (url.pathname === "/.well-known/matrix/client") {
    sendJson({
      "m.homeserver": { base_url: `http://127.0.0.1:${port}` },
    });
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.resolve(appDir, `.${pathname}`);
  if (
    !file.startsWith(`${appDir}${path.sep}`) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    response.writeHead(404);
    response.end();
    return;
  }

  const compressed = `${file}.gz`;
  const useGzip =
    request.headers["accept-encoding"]?.includes("gzip") &&
    fs.existsSync(compressed);
  response.writeHead(200, {
    "cache-control": pathname.startsWith("/bundles/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "content-type": mimeTypes[path.extname(file)] || "application/octet-stream",
    ...(useGzip
      ? { "content-encoding": "gzip", vary: "Accept-Encoding" }
      : {}),
  });
  fs.createReadStream(useGzip ? compressed : file).pipe(response);
});
await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    port = server.address().port;
    resolve();
  });
});

const runs = [];
let browserVersion;
try {
  for (let sample = 1; sample <= samples; sample += 1) {
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-background-networking"],
    });
    browserVersion = await browser.version();
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript(() => {
      window.__elementBenchmarkLongTasks = [];
      new PerformanceObserver((list) => {
        window.__elementBenchmarkLongTasks.push(
          ...list.getEntries().map(({ startTime, duration }) => ({
            startTime,
            duration,
          })),
        );
      }).observe({ type: "longtask", buffered: true });
    });
    const page = await context.newPage();

    const started = performance.now();
    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const signIn = page.getByText("Sign in", { exact: true }).first();
    await signIn.waitFor({ state: "visible", timeout: 30_000 });
    await signIn.click();
    await page
      .getByText(/Open Suite SSO|Continue with Open Suite SSO/i)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    const readyMs = performance.now() - started;
    await page.waitForTimeout(100);

    const metrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const resources = performance.getEntriesByType("resource");
      const fcp = performance
        .getEntriesByType("paint")
        .find(({ name }) => name === "first-contentful-paint");
      const longTasks = window.__elementBenchmarkLongTasks;
      const responseEnd = (pattern) =>
        resources.find(({ name }) => new URL(name).pathname.match(pattern))
          ?.responseEnd ?? null;
      return {
        dcl_ms: navigation?.domContentLoadedEventEnd ?? null,
        fcp_ms: fcp?.startTime ?? null,
        load_ms: navigation?.loadEventEnd ?? null,
        bundle_response_end_ms: responseEnd(/\/bundle\.js$/),
        wasm_response_end_ms: responseEnd(/\/e5ee[^/]*\.wasm$/),
        long_task_ms: longTasks.reduce((total, task) => total + task.duration, 0),
        longest_task_ms: Math.max(0, ...longTasks.map(({ duration }) => duration)),
        request_count: resources.length + 1,
        decoded_bytes: resources.reduce(
          (total, resource) => total + resource.decodedBodySize,
          navigation?.decodedBodySize ?? 0,
        ),
      };
    });
    runs.push({ sample, ready_ms: readyMs, ...metrics });
    console.log(
      `browser ${sample}/${samples}: ready=${readyMs.toFixed(1)}ms long-tasks=${metrics.long_task_ms.toFixed(1)}ms`,
    );
    await browser.close();
  }
} finally {
  server.close();
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
  const deviations = values.map((value) => Math.abs(value - median));
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
    mad: quantile(deviations, 0.5),
  };
};
const metrics = Object.keys(runs[0]).filter(
  (key) => key !== "sample" && runs.every((run) => Number.isFinite(run[key])),
);
const report = {
  benchmark: "element-cold-browser-to-visible-sso-action",
  captured_at: new Date().toISOString(),
  app_dir: appDir,
  browser: browserVersion,
  profile: "fresh Chromium process and context per sample; local loopback; no throttling",
  summary: Object.fromEntries(
    metrics.map((metric) => [metric, summarize(runs.map((run) => run[metric]))]),
  ),
  runs,
};
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
