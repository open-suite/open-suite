// First-user benchmark for a newly installed Messages stack. It intentionally
// uses the real edge gate, Keycloak, Mail silent login, and Element client.
import fs from "node:fs";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

const domain = process.env.MESSAGES_BENCHMARK_DOMAIN;
const username = process.env.MESSAGES_BENCHMARK_USER;
const password = process.env.MESSAGES_BENCHMARK_PASSWORD;
const output = process.argv[2];
if (!domain || !username || !password || !output) {
  throw new Error("set benchmark domain/user/password and pass an output path");
}

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const results = {};

try {
  const mailStarted = performance.now();
  const mailboxUrl = new RegExp(
    `^https://messages\\.${domain.replaceAll(".", "\\.")}/mailbox/`
  );
  const authenticationUrl = new RegExp(
    `^https://(?:id|messages)\\.${domain.replaceAll(".", "\\.")}/(?:realms/[^/]+/protocol/openid-connect/auth|api/v1\\.0/callback/)`
  );
  const callbackStatuses = [];
  page.on("response", (response) => {
    if (response.url().includes(`messages.${domain}/api/v1.0/callback/`)) {
      callbackStatuses.push(response.status());
    }
  });

  let mailAttempts = 0;
  while (!mailboxUrl.test(page.url()) && mailAttempts < 3) {
    mailAttempts += 1;
    await page.goto(`https://messages.${domain}/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(new RegExp(`${mailboxUrl.source}|${authenticationUrl.source}`), {
      timeout: 30_000,
    });
    if (page.url().includes(`id.${domain}`)) {
      const login = page.locator("#kc-login");
      if (await login.isVisible()) {
        await page.fill("#username", username);
        await page.fill("#password", password);
        await login.click();
      }
      await page.waitForURL(new RegExp(`${mailboxUrl.source}|messages\\.${domain.replaceAll(".", "\\.")}/api/v1\\.0/callback/`), {
        timeout: 30_000,
      });
    }
  }
  if (!mailboxUrl.test(page.url())) {
    throw new Error(
      `Mail did not become usable after ${mailAttempts} OIDC attempts; callback statuses: ${callbackStatuses.join(", ") || "none"}`
    );
  }
  await page.getByText("Inbox", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  results.mail_first_usable_ms = Math.round(performance.now() - mailStarted);
  results.mail_oidc_attempts = mailAttempts;
  results.mail_oidc_callback_statuses = callbackStatuses;

  const cookies = await context.cookies();
  const gateCookie = cookies.find((cookie) => cookie.name === "opensuite_auth");
  const mailSession = cookies.find(
    (cookie) =>
      cookie.domain.replace(/^\./, "") === `messages.${domain}` &&
      /sessionid$/.test(cookie.name)
  );
  if (gateCookie?.expires !== -1) {
    throw new Error("edge gate cookie is not scoped to the browser session");
  }
  if (!mailSession?.secure || !mailSession?.httpOnly) {
    throw new Error("Messages session cookie lost Secure or HttpOnly");
  }
  results.session_security_verified = true;

  const logoutLink = page
    .locator("#ko-portal-header")
    .getByRole("link", { name: "Logout", exact: true });
  await logoutLink.waitFor({ state: "visible", timeout: 15_000 });
  const logoutUrl = new URL(await logoutLink.getAttribute("href"));
  if (
    logoutUrl.hostname !== `auth.${domain}` ||
    logoutUrl.pathname !== "/logout" ||
    logoutUrl.searchParams.get("rd") !== `https://bridge.${domain}/`
  ) {
    throw new Error(`coordinated logout target changed: ${logoutUrl}`);
  }
  results.logout_contract_verified = true;

  let firstSyncStarted;
  let firstSyncStatus;
  let finishFirstSync;
  const firstSync = new Promise((resolve) => { finishFirstSync = resolve; });
  page.on("request", (request) => {
    if (firstSyncStarted === undefined && /\/_matrix\/client\/.*\/sync(?:\?|$)/.test(request.url())) {
      firstSyncStarted = performance.now();
    }
  });
  page.on("response", async (response) => {
    if (
      firstSyncStatus === undefined &&
      firstSyncStarted !== undefined &&
      /\/_matrix\/client\/.*\/sync(?:\?|$)/.test(response.url())
    ) {
      firstSyncStatus = response.status();
      await response.finished().catch(() => null);
      finishFirstSync(performance.now());
    }
  });

  const matrixStarted = performance.now();
  await page.goto(`https://element.${domain}/`, { waitUntil: "domcontentloaded" }).catch(() => null);
  const firstSyncFinished = await Promise.race([
    firstSync,
    new Promise((_, reject) => setTimeout(() => reject(new Error("first Matrix sync timed out")), 90_000)),
  ]);
  if (firstSyncStatus < 200 || firstSyncStatus >= 300) {
    throw new Error(`first Matrix sync returned HTTP ${firstSyncStatus}`);
  }
  results.matrix_first_sync_from_navigation_ms = Math.round(firstSyncFinished - matrixStarted);
  results.matrix_first_sync_request_ms = Math.round(firstSyncFinished - firstSyncStarted);
  results.matrix_first_sync_status = firstSyncStatus;

  fs.writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
