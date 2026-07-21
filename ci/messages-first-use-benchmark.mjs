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
  const mailboxThreadsLoaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.hostname === `messages.${domain}` &&
      url.pathname === "/api/v1.0/threads/" &&
      url.searchParams.get("has_active") === "1"
    );
  }, { timeout: 90_000 });
  await page.goto(`https://messages.${domain}/`, { waitUntil: "domcontentloaded" });
  if (page.url().includes(`id.${domain}`)) {
    await page.fill("#username", username);
    await page.fill("#password", password);
    await page.click("#kc-login");
  }
  await page.waitForURL(new RegExp(`^https://messages\\.${domain.replaceAll(".", "\\.")}/mailbox/`), {
    timeout: 60_000,
  });
  const mailboxResponse = await mailboxThreadsLoaded;
  if (!mailboxResponse.ok()) {
    throw new Error(`first Mail thread list returned HTTP ${mailboxResponse.status()}`);
  }
  // An empty first-user mailbox renders .thread-view--empty without mounting
  // the thread panel. Either state means the authenticated mailbox data has
  // rendered; unlike translated folder text, these app-owned layout classes
  // are locale independent.
  await page.locator(".thread-view--empty, .thread-panel").first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  results.mail_first_usable_ms = Math.round(performance.now() - mailStarted);

  const cookies = await context.cookies();
  const gateCookie = cookies.find((cookie) => cookie.name === "opensuite_auth");
  const mailSession = cookies.find(
    (cookie) =>
      cookie.domain.replace(/^\./, "") === `messages.${domain}` &&
      /sessionid$/.test(cookie.name)
  );
  if (!gateCookie || !gateCookie.secure || !gateCookie.httpOnly || gateCookie.expires !== -1) {
    throw new Error("edge gate cookie is missing Secure, HttpOnly, or browser-session scope");
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
    logoutUrl.origin !== `https://messages.${domain}` ||
    logoutUrl.pathname !== "/api/v1.0/logout/" ||
    logoutUrl.search
  ) {
    throw new Error(`first-party Messages logout target changed: ${logoutUrl}`);
  }
  results.logout_contract_verified = true;

  const matrixPage = await context.newPage();
  try {
    let firstSyncStarted;
    let firstSyncStatus;
    let finishFirstSync;
    const firstSync = new Promise((resolve) => { finishFirstSync = resolve; });
    matrixPage.on("request", (request) => {
      if (firstSyncStarted === undefined && /\/_matrix\/client\/.*\/sync(?:\?|$)/.test(request.url())) {
        firstSyncStarted = performance.now();
      }
    });
    matrixPage.on("response", async (response) => {
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
    await matrixPage.goto(`https://element.${domain}/`, { waitUntil: "domcontentloaded" }).catch(() => null);
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
  } finally {
    await matrixPage.close();
  }

  // Messages keeps its session only long enough to validate the random state
  // on the main-frame RP logout callback. The callback then clears that
  // session and redirects through auth-gate, which clears the edge session and
  // returns to the protected bridge. Both protected hosts must fail closed at
  // Keycloak's login page rather than silently signing back in.
  const logoutCallback = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().isNavigationRequest() &&
      response.request().frame() === page.mainFrame() &&
      url.hostname === `messages.${domain}` &&
      url.pathname === "/api/v1.0/logout-callback/"
    );
  }, { timeout: 60_000 });
  const [callbackResponse] = await Promise.all([
    logoutCallback,
    page.waitForURL((url) =>
      url.hostname === `id.${domain}` &&
      url.pathname === "/realms/mijnbureau/protocol/openid-connect/auth" &&
      url.searchParams.get("client_id") === "opensuite-auth-gate", {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    }),
    logoutLink.click(),
  ]);
  const callbackUrl = new URL(callbackResponse.url());
  if (callbackResponse.status() !== 302 || !callbackUrl.searchParams.get("state")) {
    throw new Error(`stateful Messages logout callback failed: ${callbackResponse.status()} ${callbackUrl}`);
  }
  results.logout_callback_state_verified = true;
  await page.locator("#kc-login").waitFor({ state: "visible", timeout: 15_000 });
  results.protected_bridge_requires_login = true;
  const postLogoutCookies = await context.cookies();
  const postLogoutGateCookie = postLogoutCookies.find((cookie) => cookie.name === "opensuite_auth");
  const postLogoutMailSession = postLogoutCookies.find(
    (cookie) =>
      cookie.domain.replace(/^\./, "") === `messages.${domain}` &&
      /sessionid$/.test(cookie.name)
  );
  if (postLogoutGateCookie || postLogoutMailSession) {
    throw new Error("coordinated logout did not clear the edge and Messages sessions");
  }

  await page.goto(`https://messages.${domain}/`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) =>
    url.hostname === `id.${domain}` &&
    url.pathname === "/realms/mijnbureau/protocol/openid-connect/auth" &&
    url.searchParams.get("client_id") === "opensuite-auth-gate", {
    timeout: 30_000,
    waitUntil: "domcontentloaded",
  });
  await page.locator("#kc-login").waitFor({ state: "visible", timeout: 15_000 });
  results.protected_messages_requires_login = true;
  results.logout_completed = true;

  fs.writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
