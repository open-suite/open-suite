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
const ctx = await browser.newContext({ ignoreHTTPSErrors: false });
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

  // Portal shows real content, not an error shell.
  await page.waitForSelector("text=Start instant meeting", { timeout: 30000 });
  ok("portal renders (instant-meeting control present)");

  // --- Portal calendar API --------------------------------------------------
  const cal = await page.request.get(`https://bridge.${DOMAIN}/api/v1/caldav/events`);
  if (cal.ok()) ok(`calendar API answers (${cal.status()})`);
  else fail("calendar API", `HTTP ${cal.status()}`);

  // --- Header injection on the sidecar apps ---------------------------------
  for (const host of ["nextcloud", "grist", "docs"]) {
    const r = await page.goto(`https://${host}.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
    const html = await page.content();
    if (html.includes("/opensuite-header.js")) ok(`${host}: header script injected`);
    else fail(`${host}: header script`, `not in HTML (HTTP ${r?.status()})`);
  }

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
