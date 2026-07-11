import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

import { chromium } from "playwright";

const baseUrl =
  process.env.BENCHMARK_URL || "https://bridge.demo.opensuite.online";
const username = process.env.BENCHMARK_USER;
const password = process.env.BENCHMARK_PASS;
const attempts = Number(process.env.BENCHMARK_ATTEMPTS || 10);
const output =
  process.env.BENCHMARK_OUTPUT || "element-login-benchmark-result.json";
const label = process.env.BENCHMARK_LABEL || "unlabelled";

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
      rateLimits.push({ status: response.status(), url: response.url() });
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
        .then((response) => ({ ready: false, url: response.url() })),
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
    final_url: page.url(),
    error,
  });
  await context.close();
}

await browser.close();

const report = {
  label,
  captured_at: new Date().toISOString(),
  target: baseUrl,
  attempts,
  successes: results.filter((result) => result.success).length,
  rate_limited_attempts: results.filter((result) =>
    result.rate_limits.some(({ url }) => url.includes("/_matrix/client/")),
  ).length,
  results,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (report.successes !== attempts || report.rate_limited_attempts !== 0) {
  process.exitCode = 1;
}
