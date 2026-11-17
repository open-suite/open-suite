// Suite session conformance test of an assembled Open Suite stack.
//
// Usage:
//   npm i playwright && npx playwright install chromium   (one-time)
//   SMOKE_DOMAIN=demo.opensuite.online SMOKE_USER=johndoe SMOKE_PASS=... \
//     SMOKE_USER2=janedoe SMOKE_PASS2=... node ci/smoke/session-conformance.mjs
//
// One rule, asserted for every application: a person is signed in to the
// whole suite or to none of it, and an application never shows anyone but
// the person who holds the suite login.
//
//   1. An application session goes missing while the suite login is alive:
//      the application opens for the same person without a sign-in form.
//   2. The suite login ends on the server while the browser still holds
//      every application session: every application asks to sign in.
//   3. A second person signs in on that browser: no application shows the
//      first person.
//   4. The person signs out from the suite header: every application asks
//      to sign in, and the first person can sign in again everywhere.
//
// Exit code 0 = pass. Failures are collected and all reported.

import { chromium } from "playwright";

const DOMAIN = process.env.SMOKE_DOMAIN;
const USER = process.env.SMOKE_USER;
const PASS = process.env.SMOKE_PASS;
const USER2 = process.env.SMOKE_USER2 || "janedoe";
const PASS2 = process.env.SMOKE_PASS2 || PASS;
const REALM = process.env.SMOKE_REALM || "mijnbureau";
if (!DOMAIN || !USER || !PASS) {
  console.error("set SMOKE_DOMAIN, SMOKE_USER, SMOKE_PASS");
  process.exit(2);
}
if (USER === USER2 || USER.includes(USER2) || USER2.includes(USER)) {
  console.error("SMOKE_USER and SMOKE_USER2 must be distinguishable");
  process.exit(2);
}

// The gate re-validates the suite login against Keycloak at most this often.
const GATE_VALIDATION_SECONDS = 15;
const BIND_COOKIE = "opensuite_bind";

const failures = [];
const ok = (name) => console.log(`ok   ${name}`);
const fail = (name, detail) => {
  console.log(`FAIL ${name}: ${detail}`);
  failures.push(name);
};

const json = (path, pick, headers = {}) => async (page) =>
  page.evaluate(
    async ({ path, headers }) => {
      const response = await fetch(path, { headers });
      return response.ok ? response.json() : null;
    },
    { path, headers },
  ).then((body) => (body ? pick(body) : null));

// `identity` returns the signed-in person as the application itself reports
// it, or null while the application has no session yet.
const APPS = [
  {
    name: "portal",
    url: `https://bridge.${DOMAIN}/`,
    identity: json("/api/v1/auth/profile", (body) => body.email),
  },
  {
    name: "docs",
    url: `https://docs.${DOMAIN}/`,
    identity: json("/api/v1.0/users/me/", (body) => body.email),
  },
  {
    name: "meet",
    url: `https://meet.${DOMAIN}/`,
    identity: json("/api/v1.0/users/me/", (body) => body.email),
  },
  {
    name: "mail",
    url: `https://messages.${DOMAIN}/`,
    identity: json("/api/v1.0/users/me/", (body) => body.email),
  },
  {
    name: "files",
    url: `https://nextcloud.${DOMAIN}/apps/files/`,
    identity: json(
      "/ocs/v2.php/cloud/user?format=json",
      (body) => body.ocs.data.email || body.ocs.data.id,
      { "OCS-APIRequest": "true" },
    ),
  },
  {
    name: "grist",
    url: `https://grist.${DOMAIN}/`,
    identity: json("/api/profile/user", (body) => body.email),
  },
  {
    name: "chat",
    url: `https://element.${DOMAIN}/`,
    identity: (page) => page.evaluate(() => localStorage.getItem("mx_user_id")),
    // Element keeps its session in browser storage, not in a cookie.
    storageSession: true,
  },
];

const onSignInForm = async (page) =>
  new URL(page.url()).hostname === `id.${DOMAIN}` && (await page.locator("#username").count()) > 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Open an application and report who it shows: a person, "SIGN-IN FORM", or
// null when it never settled.
const whoIsShown = async (page, app, timeoutMs = 60000) => {
  await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await onSignInForm(page)) return "SIGN-IN FORM";
    if (new URL(page.url()).origin === new URL(app.url).origin) {
      // A sign-in round trip navigates away and destroys this context.
      const person = await app.identity(page).catch(() => null);
      if (person) return person;
    }
    await sleep(1000);
  }
  return null;
};

const signIn = async (page, user, password) => {
  await page.goto(`https://bridge.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
  await page.locator("#username").waitFor({ state: "visible", timeout: 30000 });
  await page.fill("#username", user);
  await page.fill("#password", password);
  await page.click("#kc-login");
  await page.waitForURL(`https://bridge.${DOMAIN}/**`, { timeout: 30000 });
};

const expectEveryAppShows = async (page, user, otherUser, label) => {
  for (const app of APPS) {
    const person = await whoIsShown(page, app);
    if (person && person.includes(user) && !person.includes(otherUser)) ok(`${label}: ${app.name} shows ${user}`);
    else fail(`${label}: ${app.name}`, `expected ${user}, got ${person}`);
  }
};

const expectEveryAppAsksToSignIn = async (page, label, graceSeconds = 0) => {
  for (const app of APPS) {
    // Only the first application waits out the gate's validation interval.
    const deadline = Date.now() + (app === APPS[0] ? graceSeconds * 1000 : 0);
    let person;
    do {
      person = await whoIsShown(page, app, 20000);
      if (person === "SIGN-IN FORM") break;
      await sleep(3000);
    } while (Date.now() < deadline);
    if (person === "SIGN-IN FORM") ok(`${label}: ${app.name} asks to sign in`);
    else fail(`${label}: ${app.name}`, `expected the sign-in form, got ${person}`);
  }
};

const browser = await chromium.launch();
const contextOptions = { ignoreHTTPSErrors: process.env.SMOKE_INSECURE === "1" };
const ctx = await browser.newContext(contextOptions);
const page = await ctx.newPage();

try {
  await signIn(page, USER, PASS);
  await expectEveryAppShows(page, USER, USER2, "signed in");

  // 1. Each application loses its own session; the suite login stays.
  for (const app of APPS) {
    const cookies = await ctx.cookies(app.url);
    for (const cookie of cookies) {
      if (cookie.domain.startsWith(".") || cookie.name === BIND_COOKIE) continue;
      await ctx.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    }
    if (app.storageSession) {
      await page.goto(app.url, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => localStorage.clear());
    }
  }
  await expectEveryAppShows(page, USER, USER2, "application session missing");

  // 2. The suite login ends on the server. A second browser that shares only
  // the Keycloak cookies ends it, so this browser keeps every application
  // session and its gate cookie.
  const elsewhere = await browser.newContext(contextOptions);
  await elsewhere.addCookies((await ctx.cookies()).filter((cookie) => cookie.domain === `id.${DOMAIN}`));
  const elsewherePage = await elsewhere.newPage();
  await elsewherePage.goto(`https://id.${DOMAIN}/realms/${REALM}/protocol/openid-connect/logout`);
  await elsewherePage.locator("#kc-logout").click();
  await elsewherePage.waitForLoadState("domcontentloaded");
  await elsewhere.close();
  await expectEveryAppAsksToSignIn(page, "suite login ended", GATE_VALIDATION_SECONDS + 15);

  // 3. Another person signs in on this browser, which still holds the first
  // person's application cookies and storage.
  await signIn(page, USER2, PASS2);
  await expectEveryAppShows(page, USER2, USER, "second person");

  // 4. Sign out from the suite header.
  await page.goto(`https://bridge.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
  await page.locator("#ko-portal-header").getByRole("link", { name: "Logout", exact: true }).click();
  await page.locator("#username").waitFor({ state: "visible", timeout: 45000 });
  await expectEveryAppAsksToSignIn(page, "signed out");

  await signIn(page, USER, PASS);
  await expectEveryAppShows(page, USER, USER2, "first person again");
} catch (error) {
  fail("session conformance", String(error?.message || error).slice(0, 300));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nsession conformance passed");
