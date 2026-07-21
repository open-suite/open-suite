import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";

import { chromium } from "./performance/node_modules/playwright/index.mjs";

function positiveInteger(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const samples = positiveInteger(
  process.env.MEET_BENCHMARK_SAMPLES,
  20,
  "MEET_BENCHMARK_SAMPLES",
);
const exerciseEffect = process.env.MEET_BENCHMARK_EFFECT === "true";
const exerciseJoin = process.env.MEET_BENCHMARK_JOIN === "true";
const variants = (
  process.env.MEET_BENCHMARK_VARIANTS ||
  (exerciseEffect ? "candidate" : "baseline,candidate")
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const roots = {
  baseline: process.env.MEET_BASELINE_DIST,
  candidate: process.env.MEET_CANDIDATE_DIST,
};

for (const variant of variants) {
  if (!(variant in roots)) throw new Error(`Unknown Meet variant: ${variant}`);
  if (!roots[variant] || !existsSync(path.join(roots[variant], "index.html"))) {
    throw new Error(`Set MEET_${variant.toUpperCase()}_DIST to a Meet dist directory`);
  }
}
if (exerciseEffect && variants.some((variant) => variant !== "candidate")) {
  throw new Error("Run the effect regression against the candidate only");
}

const mimeTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tflite": "application/octet-stream",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const apiConfig = {
  feedback: { url: "" },
  background_image: {
    upload_is_enabled: false,
    max_size: 2_097_152,
    max_count_by_user: 10,
    allowed_extensions: [".jpeg", ".jpg", ".png"],
    allowed_mimetypes: ["image/jpeg", "image/png"],
  },
  subtitle: { enabled: false },
  telephony: { enabled: false },
  livekit: {
    force_wss_protocol: false,
    enable_firefox_proxy_workaround: false,
    default_sources: ["camera", "microphone"],
  },
  is_silent_login_enabled: false,
  use_french_gov_footer: false,
  use_proconnect_button: false,
};
const encodeTokenPart = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeLiveKitToken = [
  encodeTokenPart({ alg: "HS256", typ: "JWT" }),
  encodeTokenPart({
    sub: "benchmark",
    video: { room: "meet-benchmark-room", roomJoin: true },
  }),
  "benchmark-signature",
].join(".");

function createServer(root) {
  return new Promise((resolve) => {
    const events = [];
    const server = http.createServer(async (request, response) => {
      const pathname = new URL(request.url, "http://meet.local").pathname;
      const livekitUrl = `http://${request.headers.host}/livekit`;
      if (pathname === "/api/v1.0/config/") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            ...apiConfig,
            livekit: { ...apiConfig.livekit, url: livekitUrl },
          }),
        );
        return;
      }
      if (pathname === "/api/v1.0/users/me") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "00000000-0000-0000-0000-000000000001",
            email: "benchmark@example.test",
            full_name: "Meet Benchmark",
            short_name: "Benchmark",
          }),
        );
        return;
      }
      if (pathname === "/api/v1.0/rooms/abc-defg-hij") {
        events.push({ type: "room-api", at: performance.now() });
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "00000000-0000-0000-0000-000000000002",
            name: "Meet benchmark room",
            slug: "abc-defg-hij",
            pin_code: "",
            is_administrable: false,
            access_level: "public",
            livekit: {
              url: livekitUrl,
              room: "meet-benchmark-room",
              token: fakeLiveKitToken,
            },
          }),
        );
        return;
      }
      if (pathname === "/livekit") {
        events.push({ type: "livekit-head", at: performance.now() });
        response.statusCode = 200;
        response.end();
        return;
      }

      const relative = pathname.replace(/^\/+/, "");
      let file = path.resolve(root, relative);
      if (
        !file.startsWith(`${path.resolve(root)}${path.sep}`) ||
        !existsSync(file) ||
        !statSync(file).isFile()
      ) {
        file = path.join(root, "index.html");
      }
      const body = await readFile(file);
      const type = mimeTypes[path.extname(file)] || "application/octet-stream";
      response.setHeader("content-type", type);
      response.setHeader(
        "cache-control",
        file.endsWith("index.html") ? "no-store" : "public, max-age=2592000",
      );
      if (
        /^(text\/|application\/(javascript|json))/.test(type) &&
        /\bgzip\b/.test(request.headers["accept-encoding"] || "")
      ) {
        response.setHeader("content-encoding", "gzip");
        response.setHeader("vary", "Accept-Encoding");
        response.end(gzipSync(body, { level: 6 }));
      } else {
        response.end(body);
      }
    });
    server.on("upgrade", (request, socket) => {
      events.push({
        type: "signal-attempt",
        at: performance.now(),
        path: new URL(request.url, "http://meet.local").pathname,
      });
      socket.destroy();
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        events,
        url: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

const percentile = (values, fraction) =>
  values[Math.ceil(values.length * fraction) - 1];

function summarize(runs) {
  const metrics = Object.keys(runs[0]).filter(
    (key) => key !== "sample" && typeof runs[0][key] === "number",
  );
  return Object.fromEntries(
    metrics.map((metric) => {
      const values = runs.map((run) => run[metric]).sort((a, b) => a - b);
      return [
        metric,
        {
          min: values[0],
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          max: values.at(-1),
        },
      ];
    }),
  );
}

const servers = Object.fromEntries(
  await Promise.all(
    variants.map(async (variant) => [variant, await createServer(roots[variant])]),
  ),
);
const browser = await chromium.launch({
  headless: true,
  args: exerciseEffect
    ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
    : [],
});
const runs = Object.fromEntries(variants.map((variant) => [variant, []]));

async function run(variant, sample) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });
  await context.addInitScript((effectEnabled) => {
    localStorage.setItem(
      "lk-user-choices",
      JSON.stringify({
        audioEnabled: false,
        videoEnabled: effectEnabled,
        audioDeviceId: "default",
        videoDeviceId: "default",
        username: "Benchmark",
      }),
    );
    window.__meetBenchmark = { longTaskMs: 0, longestTaskMs: 0 };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__meetBenchmark.longTaskMs += entry.duration;
        window.__meetBenchmark.longestTaskMs = Math.max(
          window.__meetBenchmark.longestTaskMs,
          entry.duration,
        );
      }
    }).observe({ type: "longtask", buffered: true });
  }, exerciseEffect);

  const page = await context.newPage();
  const errors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: (10 * 1024 * 1024) / 8,
    uploadThroughput: (5 * 1024 * 1024) / 8,
    connectionType: "wifi",
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  await page.goto(`${servers[variant].url}/abc-defg-hij`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#input-name").waitFor({ state: "visible", timeout: 30_000 });
  const submit = page.locator('button[type="submit"]');
  await submit.waitFor({ state: "visible", timeout: 30_000 });
  const prejoinUsableMs = await page.evaluate(() => performance.now());

  let joinMetrics = {};
  if (exerciseJoin) {
    servers[variant].events.length = 0;
    const joinStarted = performance.now();
    await submit.click();
    while (
      !servers[variant].events.some(({ type }) => type === "signal-attempt") &&
      performance.now() - joinStarted < 15_000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const eventAt = (type) =>
      servers[variant].events.find((event) => event.type === type)?.at;
    if (!eventAt("signal-attempt")) {
      throw new Error(
        `${variant} did not attempt signaling: ${JSON.stringify({ events: servers[variant].events, consoleErrors })}`,
      );
    }
    joinMetrics = {
      join_api_request_ms: eventAt("room-api") - joinStarted,
      livekit_preconnect_ms: eventAt("livekit-head") - joinStarted,
      signal_attempt_ms: eventAt("signal-attempt") - joinStarted,
    };
  }

  let effectSelectedMs;
  if (exerciseEffect) {
    await page
      .getByRole("button", { name: "Apply backgrounds and effects" })
      .click();
    const blur = page
      .getByRole("button", { name: "Slightly blur your background" })
      .first();
    await blur.waitFor({ state: "visible", timeout: 30_000 });
    const effectStarted = performance.now();
    await blur.click();
    await page.waitForFunction(
      (element) => element?.getAttribute("aria-pressed") === "true",
      await blur.elementHandle(),
      { timeout: 60_000 },
    );
    effectSelectedMs = performance.now() - effectStarted;
  }

  await page.waitForTimeout(100);
  const metrics = await page.evaluate(() => {
    const resources = performance.getEntriesByType("resource");
    const navigation = performance.getEntriesByType("navigation")[0];
    const scripts = resources.filter((entry) =>
      new URL(entry.name).pathname.endsWith(".js"),
    );
    const sum = (entries, key) =>
      entries.reduce((total, entry) => total + (entry[key] || 0), 0);
    const room = scripts.find((entry) =>
      /\/assets\/Room-[^/]+\.js$/.test(new URL(entry.name).pathname),
    );
    const fcp = performance
      .getEntriesByType("paint")
      .find((entry) => entry.name === "first-contentful-paint");
    const optional = resources.filter((entry) =>
      /vision_bundle|UnifiedBackgroundTrackProcessor/.test(entry.name),
    );
    return {
      ttfb_ms: navigation?.responseStart,
      dcl_ms: navigation?.domContentLoadedEventEnd,
      fcp_ms: fcp?.startTime,
      long_task_ms: window.__meetBenchmark.longTaskMs,
      longest_task_ms: window.__meetBenchmark.longestTaskMs,
      room_response_end_ms: room?.responseEnd,
      script_count: scripts.length,
      script_encoded_kib: sum(scripts, "encodedBodySize") / 1024,
      script_decoded_kib: sum(scripts, "decodedBodySize") / 1024,
      optional_processor_requests: optional.length,
      vision_requests: optional.filter((entry) => /vision_bundle/.test(entry.name))
        .length,
    };
  });
  await context.close();
  if (errors.length) throw new Error(`${variant} page errors: ${errors.join("; ")}`);

  const result = {
    sample,
    prejoin_usable_ms: prejoinUsableMs,
    room_to_usable_ms: prejoinUsableMs - metrics.room_response_end_ms,
    ...(effectSelectedMs === undefined ? {} : { effect_selected_ms: effectSelectedMs }),
    ...joinMetrics,
    ...metrics,
  };
  console.error(`${variant} ${sample}: ${JSON.stringify(result)}`);
  return result;
}

try {
  for (let sample = 1; sample <= samples; sample += 1) {
    const order =
      variants.length === 2 && sample % 2 === 0
        ? [...variants].reverse()
        : variants;
    for (const variant of order) runs[variant].push(await run(variant, sample));
  }

  if (
    !exerciseEffect &&
    runs.candidate?.some((run) => run.optional_processor_requests !== 0)
  ) {
    throw new Error("Ordinary candidate prejoin requested an optional processor");
  }
  if (exerciseEffect && runs.candidate.some((run) => run.vision_requests < 2)) {
    throw new Error("Background effect did not load the MediaPipe chunks");
  }

  const result = {
    schema: "open-suite-meet-performance-v1",
    methodology: {
      samples,
      cpu_throttle: 4,
      latency_ms: 40,
      download_mbps: 10,
      upload_mbps: 5,
      fresh_browser_context_per_run: true,
      effect_scenario: exerciseEffect,
      join_setup_scenario: exerciseJoin,
    },
    summaries: Object.fromEntries(
      Object.entries(runs).map(([variant, values]) => [variant, summarize(values)]),
    ),
    runs,
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.MEET_BENCHMARK_OUTPUT) {
    await writeFile(process.env.MEET_BENCHMARK_OUTPUT, output);
  }
  process.stdout.write(output);
} finally {
  await browser.close();
  await Promise.all(
    Object.values(servers).map(
      ({ server }) => new Promise((resolve) => server.close(resolve)),
    ),
  );
}
