// Authenticated smoke test of an assembled Open Suite stack.
//
// Usage:
//   npm i playwright && npx playwright install chromium   (one-time)
//   SMOKE_DOMAIN=demo.opensuite.online SMOKE_USER=johndoe SMOKE_PASS=... \
//     node ci/smoke/authenticated.mjs
//
// Asserts, with one real browser session through the edge gate + Keycloak:
//   - SSO login via the gate works
//   - the portal loads and shows content
//   - the shared Open Suite header is injected on the sidecar apps
//     (Nextcloud, Grist, Docs) — the thing a helmfile re-apply used to break
//   - the portal calendar API answers
//   - POST /apps/meetcal/room mints a joinable Meet room URL
//   - Docs, Grist and Element pages load
//
// Exit code 0 = pass. Failures are collected and all reported.

import { chromium } from "playwright";

const DOMAIN = process.env.SMOKE_DOMAIN;
const USER = process.env.SMOKE_USER;
const PASS = process.env.SMOKE_PASS;
if (!DOMAIN || !USER || !PASS) {
  console.error("set SMOKE_DOMAIN, SMOKE_USER, SMOKE_PASS");
  process.exit(2);
}

const failures = [];
const ok = (name) => console.log(`ok   ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

const browser = await chromium.launch();
// SMOKE_INSECURE=1: tolerate self-signed certs (local VM deploys).
const ctx = await browser.newContext({ ignoreHTTPSErrors: process.env.SMOKE_INSECURE === "1" });
const page = await ctx.newPage();

try {
  // --- SSO login through the gate ------------------------------------------
  await page.goto(`https://bridge.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
  if (page.url().includes(`id.${DOMAIN}`)) {
    await page.fill("#username", USER);
    await page.fill("#password", PASS);
    await page.click("#kc-login");
  }
  await page.waitForURL(`https://bridge.${DOMAIN}/**`, { timeout: 30000 });
  ok("SSO login via gate reaches the portal");

  // The portal has its own OIDC session; a fresh browser lands on its /login.
  // Wait for either the dashboard or the login stub, click through the latter
  // (round-trips Keycloak silently — the SSO session exists).
  const dashboard = page.locator("text=Start instant meeting").first();
  const loginBtn = page.locator("text=Log in").last();
  await dashboard.or(loginBtn).first().waitFor({ timeout: 30000 });
  if (!(await dashboard.isVisible().catch(() => false))) {
    await loginBtn.click();
  }
  await dashboard.waitFor({ timeout: 30000 });
  ok("portal renders (dashboard widgets present)");

  // --- Header injection on the sidecar apps ---------------------------------
  // Visiting nextcloud also establishes its user_oidc session (auto-SSO) and
  // stores the login token the meetcal/caldav token exchange needs.
  for (const host of ["nextcloud", "grist", "docs"]) {
    const r = await page.goto(`https://${host}.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
    const html = await page.content();
    if (html.includes("/opensuite-header.js")) ok(`${host}: header script injected`);
    else fail(`${host}: header script`, `not in HTML (HTTP ${r?.status()})`);
  }

  // --- Portal calendar API --------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const cal = await page.request.get(`https://bridge.${DOMAIN}/api/v1/caldav/calendars/${today}`);
  if (cal.ok()) ok(`calendar API answers (${cal.status()})`);
  else fail("calendar API", `HTTP ${cal.status()}`);

  // --- meetcal mints a joinable room ----------------------------------------
  // Needs the Nextcloud session (same browser context) + CSRF token.
  await page.goto(`https://nextcloud.${DOMAIN}/apps/calendar/`, { waitUntil: "domcontentloaded" });
  const room = await page.evaluate(async () => {
    const token = document.querySelector("head[data-requesttoken]")?.dataset.requesttoken ?? "";
    const res = await fetch("/apps/meetcal/room", {
      method: "POST",
      headers: { requesttoken: token, "Content-Type": "application/json" },
      body: "{}",
      credentials: "same-origin",
    });
    return { status: res.status, body: await res.text() };
  });
  let roomUrl = "";
  try { roomUrl = JSON.parse(room.body).url ?? ""; } catch {}
  if (room.status === 200 && /https:\/\/meet\..*\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}/.test(roomUrl))
    ok(`meetcal mints a joinable room (${roomUrl})`);
  else fail("meetcal room", `HTTP ${room.status}, body ${room.body.slice(0, 120)}`);

  // --- Matrix SSO flows through without a consent screen --------------------
  // (sso.client_whitelist; the Chat widget breaks UX without it)
  await page.goto(
    `https://matrix.${DOMAIN}/_matrix/client/v3/login/sso/redirect?redirectUrl=https%3A%2F%2Fbridge.${DOMAIN}%2F`,
    { waitUntil: "domcontentloaded" }
  ).catch(() => {});
  await page.waitForTimeout(3000);
  const ssoBody = await page.evaluate(() => document.body.innerText);
  if (page.url().includes("loginToken=") && !ssoBody.includes("Continue to your account"))
    ok("matrix SSO completes without consent screen");
  else fail("matrix SSO consent", `landed on ${page.url().slice(0, 80)}`);

  // --- Office: a document actually opens in Collabora ------------------------
  // (WOPI: gate pass-through + trusted_proxies/allowlist — three separate
  // breakages found here; the editor toolbar is the proof of life)
  try {
    await page.goto(`https://nextcloud.${DOMAIN}/apps/files/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.locator('[role="menuitem"], .v-popper__popper button, .v-popper__popper li').filter({ hasText: /document/i }).first().click({ timeout: 8000 });
    await page.waitForTimeout(1200);
    await page.keyboard.press("Enter");
    // The editor renders inside the cross-origin Collabora iframe; ask that
    // frame directly. Failure overlays render in the top document.
    let editorUp = false;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(3000);
      const txt = await page.evaluate(() => document.body.innerText);
      if (/Document loading failed|Unauthorized WOPI/i.test(txt)) break;
      const cool = page.frames().find(f => f.url().includes("cool.html"));
      if (cool) {
        const inner = await cool.evaluate(() => document.body?.innerText || "").catch(() => "");
        if (/Page 1 of|words|characters/i.test(inner)) { editorUp = true; break; }
      }
    }
    if (editorUp) ok("Collabora opens a document (WOPI chain works)");
    else fail("Collabora document open", "editor never became ready or WOPI failed");
  } catch (e) {
    fail("Collabora document open", e.message.slice(0, 100));
  }

  // --- Docs, Grist, Element load --------------------------------------------
  for (const [host, marker] of [
    ["docs", "docs"],
    ["grist", "grist"],
    ["element", "element"],
  ]) {
    const r = await page.goto(`https://${host}.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
    if (r && r.status() < 400) ok(`${host}: loads (HTTP ${r.status()})`);
    else fail(`${host}: load`, `HTTP ${r?.status()}`);
  }
} catch (e) {
  fail("unexpected error", e.message);
} finally {
  await browser.close();
}

console.log("");
if (failures.length === 0) {
  console.log("SMOKE PASS (authenticated)");
} else {
  console.log(`SMOKE FAIL: ${failures.length} check(s): ${failures.join(", ")}`);
  process.exit(1);
}
