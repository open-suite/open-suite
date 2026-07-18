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

import { chromium, devices } from "playwright";

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

let sharedHeaderVersion;
const assertGlobalHeader = async (host) => {
  const header = page.locator("#ko-portal-header");
  try {
    await header.waitFor({ state: "visible", timeout: 15000 });
    const home = header.getByRole("link", { name: "Home", exact: true });
    const href = await home.getAttribute("href");
    const box = await header.boundingBox();
    const version = await header.getAttribute("data-version");
    if (href === `https://bridge.${DOMAIN}` && box && box.height >= 40 && box.y <= 1)
      ok(`${host}: rendered Open Suite navigation`);
    else fail(`${host} header`, `bad Home href or geometry: ${href}, ${JSON.stringify(box)}`);
    if (!version) {
      fail(`${host} header version`, "missing data-version");
    } else if (!sharedHeaderVersion) {
      sharedHeaderVersion = version;
      ok(`${host}: established shared header version ${version}`);
    } else if (version === sharedHeaderVersion) {
      ok(`${host}: shared header version matches ${version}`);
    } else {
      fail(`${host} header version`, `expected ${sharedHeaderVersion}, got ${version}`);
    }
  } catch (e) {
    fail(`${host} header`, e.message.slice(0, 120));
  }
};

const browser = await chromium.launch();
// SMOKE_INSECURE=1: tolerate self-signed certs (local VM deploys).
const ctx = await browser.newContext({ ignoreHTTPSErrors: process.env.SMOKE_INSECURE === "1" });
const page = await ctx.newPage();
const elementRuntimeErrors = [];
const recordElementError = (message) => {
  if (
    page.url().startsWith(`https://element.${DOMAIN}/`) &&
    /before initialization|before initialisation/i.test(message)
  ) {
    elementRuntimeErrors.push(message);
  }
};
page.on("pageerror", (error) => recordElementError(error.stack || error.message));
page.on("console", (message) => {
  if (message.type() === "error") recordElementError(message.text());
});

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

  const gateCookie = (await ctx.cookies()).find((cookie) => cookie.name === "opensuite_auth");
  if (gateCookie?.expires === -1)
    ok("edge gate session lifetime matches Keycloak's browser session");
  else
    fail(
      "edge gate session lifetime",
      `expected a browser-session cookie, got expires=${gateCookie?.expires ?? "missing"}`
    );

  // --- Rendered global navigation on every app surface -----------------------
  await assertGlobalHeader("bridge");

  const expectedTopLevel = ["Home", "Mail", "Chat", "Meet", "Office", "Calendar", "More"];
  const desktopTopLevel = await page
    .locator("#ko-portal-header .ko-desktop-nav > .ko-item > .ko-link")
    .evaluateAll((items) => items.map((item) => item.textContent.replace("▾", "").trim()));
  if (JSON.stringify(desktopTopLevel) === JSON.stringify(expectedTopLevel))
    ok("suite navigation has the canonical desktop order");
  else fail("suite navigation order", `expected ${expectedTopLevel}, got ${desktopTopLevel}`);

  const moreButton = page
    .locator("#ko-portal-header .ko-desktop-nav")
    .getByRole("button", { name: "More ▾", exact: true });
  await moreButton.click();
  const moreItems = await moreButton.locator("..").locator(".ko-menu a").allTextContents();
  if (JSON.stringify(moreItems) === JSON.stringify(["Tables", "Wiki", "Contacts"]))
    ok("suite More menu has the canonical order");
  else fail("suite More menu order", `got ${moreItems}`);

  const logoutLink = page
    .locator("#ko-portal-header")
    .getByRole("link", { name: "Logout", exact: true });
  try {
    await logoutLink.waitFor({ state: "visible", timeout: 5000 });
    const logoutHref = await logoutLink.getAttribute("href");
    const logoutUrl = new URL(logoutHref);
    if (
      logoutUrl.hostname === `auth.${DOMAIN}` &&
      logoutUrl.pathname === "/logout" &&
      logoutUrl.searchParams.get("rd") === `https://bridge.${DOMAIN}/`
    )
      ok("suite header exposes the coordinated logout action");
    else fail("portal logout action", `unexpected href: ${logoutHref}`);
  } catch (e) {
    fail("portal logout action", e.message.slice(0, 120));
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileToggle = page
    .locator("#ko-portal-header")
    .getByRole("button", { name: "Open navigation", exact: true });
  const desktopVisible = await page.locator("#ko-portal-header .ko-desktop-nav").isVisible();
  const hasHorizontalOverflow = await page.locator("#ko-portal-header").evaluate(
    (header) => header.scrollWidth > header.clientWidth || header.getBoundingClientRect().right > window.innerWidth
  );
  if ((await mobileToggle.isVisible()) && !desktopVisible && !hasHorizontalOverflow)
    ok("mobile header uses a hamburger without horizontal overflow");
  else
    fail(
      "mobile header layout",
      `toggle=${await mobileToggle.isVisible()}, desktop=${desktopVisible}, overflow=${hasHorizontalOverflow}`
    );
  await mobileToggle.click();
  const mobileMenu = page.locator("#ko-portal-header .ko-mobile-menu");
  await mobileMenu.waitFor({ state: "visible" });
  const mobileTopLevel = await mobileMenu
    .locator(":scope > a, :scope > details > summary")
    .allTextContents();
  const expectedMobile = [...expectedTopLevel, "Log out"];
  if (JSON.stringify(mobileTopLevel) === JSON.stringify(expectedMobile))
    ok("mobile menu exposes every canonical destination and logout");
  else fail("mobile navigation order", `expected ${expectedMobile}, got ${mobileTopLevel}`);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Mail must use its native silent-login mode and enter the mailbox on the
  // first load. The old header-side redirect rendered the upstream marketing
  // splash before it noticed the 401, while the smoke only checked the header.
  await ctx.addInitScript(() => {
    if (!window.location.hostname.startsWith("messages.")) return;
    const scan = () => {
      if (/Simple and intuitive messaging|ProConnect/i.test(document.body?.innerText || "")) {
        sessionStorage.setItem("__openSuiteMailSplashSeen", "1");
      }
    };
    new MutationObserver(scan).observe(document, { childList: true, subtree: true });
    window.addEventListener("DOMContentLoaded", scan);
  });
  await page.goto(`https://messages.${DOMAIN}/`, { waitUntil: "domcontentloaded" }).catch(() => null);
  await page.waitForURL(new RegExp(`^https://messages\\.${DOMAIN.replaceAll(".", "\\.")}/mailbox/`), {
    timeout: 30000,
  });
  await page.getByText("Inbox", { exact: true }).first().waitFor({ state: "visible", timeout: 15000 });
  const mailSplashSeen = await page.evaluate(
    () => sessionStorage.getItem("__openSuiteMailSplashSeen") === "1"
  );
  const mailConfig = await page.request
    .get(`https://messages.${DOMAIN}/api/v1.0/config/`)
    .then((response) => response.json());
  if (!mailSplashSeen && mailConfig.FRONTEND_SILENT_LOGIN_ENABLED === true)
    ok("Mail enters the inbox through native silent login without its marketing splash");
  else
    fail(
      "Mail first-load contract",
      `splashSeen=${mailSplashSeen}, silentLogin=${mailConfig.FRONTEND_SILENT_LOGIN_ENABLED}`
    );
  await assertGlobalHeader("messages");

  // Reproduce the real first-session path before any direct Nextcloud warm-up:
  // Mail -> portal -> Office -> Spreadsheets must remain one SSO session.
  await page.goto(`https://bridge.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
  const suiteHeader = page.locator("#ko-portal-header");
  const officeButton = suiteHeader.getByRole("button", { name: "Office ▾", exact: true });
  await officeButton.click();
  const spreadsheetsLink = suiteHeader.getByRole("link", { name: "Spreadsheets", exact: true });
  const spreadsheetsHref = await spreadsheetsLink.getAttribute("href");
  if (spreadsheetsHref?.includes("/apps/user_oidc/login/")) {
    fail("Mail -> Office auth continuity", `navigation forces OIDC: ${spreadsheetsHref}`);
  } else {
    await spreadsheetsLink.click();
    await page.waitForURL(`https://nextcloud.${DOMAIN}/apps/office/spreadsheets`, { timeout: 30000 });
    if (page.url().includes(`id.${DOMAIN}`) || page.url().includes("/login")) {
      fail("Mail -> Office auth continuity", `landed on login: ${page.url()}`);
    } else {
      ok("Mail -> Office -> Spreadsheets stays in the authenticated suite session");
    }
  }

  // The Office path above establishes Nextcloud's user_oidc session and stores
  // the login token the meetcal/caldav token exchange needs.
  for (const host of ["nextcloud", "grist", "docs", "meet", "element"]) {
    // Some OIDC SPAs replace the initial navigation while Playwright is still
    // awaiting it, which surfaces as net::ERR_ABORTED even though the redirect
    // succeeds. The rendered-header assertion below remains the acceptance
    // signal, so tolerate that navigation exception and continue waiting.
    const r = await page
      .goto(`https://${host}.${DOMAIN}/`, { waitUntil: "domcontentloaded" })
      .catch(() => null);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    if (r && r.status() >= 400) fail(`${host}: load`, `HTTP ${r.status()}`);
    await assertGlobalHeader(host);
    if (host === "element") {
      await page
        .goto(`https://element.${DOMAIN}/#/room/#welcome:matrix.${DOMAIN}`, {
          waitUntil: "domcontentloaded",
        })
        .catch(() => null);
      await page.waitForURL(`https://element.${DOMAIN}/#/room/**`, { timeout: 30000 });
      await page.waitForTimeout(2000);
      if (elementRuntimeErrors.length === 0)
        ok("Element room starts without temporal-dead-zone runtime errors");
      else fail("Element room runtime", elementRuntimeErrors[0].slice(0, 180));

      const elementConfig = await page.request
        .get(`https://element.${DOMAIN}/config.json`)
        .then((response) => response.json());
      if (elementConfig.mobile_guide_toast === false)
        ok("Element native-app guide toast is disabled");
      else fail("Element mobile guide config", `mobile_guide_toast=${elementConfig.mobile_guide_toast}`);
    }
  }

  // Element redirects mobile user agents before loading config.json. Verify a
  // clean Element cookie jar receives the server-side web-client opt-out and
  // never renders or lands on the native-app guide.
  const mobileState = await ctx.storageState();
  mobileState.cookies = mobileState.cookies.filter(
    (cookie) => cookie.name !== "element_mobile_redirect_to_guide"
  );
  const elementMobileCtx = await browser.newContext({
    ...devices["iPhone 13"],
    ignoreHTTPSErrors: process.env.SMOKE_INSECURE === "1",
    storageState: mobileState,
  });
  const elementMobilePage = await elementMobileCtx.newPage();
  await elementMobilePage
    .goto(`https://element.${DOMAIN}/`, { waitUntil: "domcontentloaded" })
    .catch(() => null);
  await elementMobilePage.waitForTimeout(2000);
  const mobileGuideText = elementMobilePage.getByText("The desktop site does not work on mobile", {
    exact: false,
  });
  if (!elementMobilePage.url().includes("/mobile_guide") && !(await mobileGuideText.isVisible()))
    ok("Element mobile browsers stay in the Open Suite web client");
  else fail("Element mobile entry", `landed on ${elementMobilePage.url()}`);
  await elementMobileCtx.close();

  // --- Portal widgets answer AND carry seeded content -----------------------
  // The empty-widget incident (Jul 2026) passed every "widget renders" check
  // while the widgets were empty because the seed had silently died. These
  // assert the seeded data is actually present, so a dead seed turns CI red.
  const today = new Date().toISOString().slice(0, 10);
  const cal = await page.request.get(`https://bridge.${DOMAIN}/api/v1/caldav/calendars/${today}`);
  if (!cal.ok()) {
    fail("calendar API", `HTTP ${cal.status()}`);
  } else {
    const events = await cal.json().catch(() => []);
    const standup = (events || []).find((e) => /Team standup/i.test(e.title || ""));
    if (!standup) {
      fail("calendar widget content", `no seeded "Team standup" event (widget empty? seed dead?)`);
    } else {
      ok("calendar widget shows seeded event");
      // Freshness: the seed recomputes event dates on every run to stay in the
      // near future, so a live seed puts the standup in the future. A stale
      // seed (not run in days) leaves it in the past.
      if (new Date(standup.start) > new Date()) ok("seed is fresh (standup is upcoming)");
      else fail("seed freshness", `standup start ${standup.start} is not in the future — seed stale`);
    }
  }

  const docsW = await page.request.get(`https://bridge.${DOMAIN}/api/v1/docs/documents`);
  const docsBody = await docsW.json().catch(() => ({}));
  if (docsW.ok() && (docsBody.results || []).some((d) => /Q3 plan|Welcome to Open Suite/i.test(d.title || "")))
    ok("docs widget shows seeded documents");
  else fail("docs widget content", `HTTP ${docsW.status()}, ${(docsBody.results || []).length} docs`);

  const meetW = await page.request.get(`https://bridge.${DOMAIN}/api/v1/meet/rooms`);
  const meetBody = await meetW.json().catch(() => ({}));
  if (meetW.ok() && (meetBody.results || []).length > 0) ok("meet widget shows rooms");
  else fail("meet widget content", `HTTP ${meetW.status()}, ${(meetBody.results || []).length} rooms`);

  // --- meetcal mints a joinable room ----------------------------------------
  // Needs the Nextcloud session (same browser context) + CSRF token.
  await page.goto(`https://nextcloud.${DOMAIN}/apps/calendar/`, { waitUntil: "domcontentloaded" });
  const room = await page.evaluate(async () => {
    const token = document.querySelector("head[data-requesttoken]")?.dataset.requesttoken ?? "";
    const create = async () => {
      const res = await fetch("/apps/meetcal/room", {
        method: "POST",
        headers: { requesttoken: token, "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "opensuite-smoke-room-v1" }),
        credentials: "same-origin",
      });
      return { status: res.status, body: await res.text() };
    };
    return { first: await create(), second: await create() };
  });
  let firstRoomUrl = "";
  let secondRoomUrl = "";
  try { firstRoomUrl = JSON.parse(room.first.body).url ?? ""; } catch {}
  try { secondRoomUrl = JSON.parse(room.second.body).url ?? ""; } catch {}
  if (
    room.first.status === 200 &&
    room.second.status === 200 &&
    firstRoomUrl === secondRoomUrl &&
    /https:\/\/meet\..*\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}/.test(firstRoomUrl)
  )
    ok(`meetcal retries reuse one joinable room (${firstRoomUrl})`);
  else
    fail(
      "meetcal room idempotency",
      `HTTP ${room.first.status}/${room.second.status}, URLs ${firstRoomUrl}/${secondRoomUrl}`
    );

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
    let editorControlsVisible = false;
    let editorDiagnostic = {};
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(3000);
      const txt = await page.evaluate(() => document.body.innerText);
      if (/Document loading failed|Unauthorized WOPI/i.test(txt)) break;
      const cool = page.frames().find(f => f.url().includes("cool.html"));
      if (cool) {
        const inner = await cool.evaluate(() => document.body?.innerText || "").catch(() => "");
        // A status bar proves the WOPI chain loaded, but it does not prove the
        // editor is usable: the suite header once covered Collabora's entire
        // File/Insert row while this check still passed.
        editorUp = /Page 1 of|words|characters/i.test(inner) || (inner.includes("File") && inner.includes("Insert"));
        const controls = await cool.evaluate(() => {
          const visibleExactText = (label) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              if ((node.nodeValue || "").trim() !== label) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              const rect = range.getBoundingClientRect();
              const style = getComputedStyle(node.parentElement);
              if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
                && style.display !== "none" && style.visibility !== "hidden") return true;
            }
            return false;
          };
          return { file: visibleExactText("File"), insert: visibleExactText("Insert") };
        }).catch(() => ({ file: false, insert: false }));
        const officeBox = await page.locator(".office-viewer:not(.office-viewer__embedding)").last().boundingBox().catch(() => null);
        const parentStyle = await page.locator(".office-viewer:not(.office-viewer__embedding)").last().evaluate((el) => ({
          htmlClass: document.documentElement.className,
          transform: getComputedStyle(el).transform,
          height: getComputedStyle(el).height,
          top: getComputedStyle(el).top,
        })).catch(() => null);
        const suiteHeaderBox = await page.locator("#ko-portal-header").boundingBox().catch(() => null);
        editorDiagnostic = { controls, officeBox, suiteHeaderBox, parentStyle, viewport: page.viewportSize() };
        editorControlsVisible = Boolean(
          controls.file && controls.insert && officeBox && suiteHeaderBox
            && Math.abs(officeBox.y - (suiteHeaderBox.y + suiteHeaderBox.height)) <= 2
            && officeBox.y + officeBox.height <= page.viewportSize().height + 2
        );
        if (editorUp && editorControlsVisible) break;
      }
    }
    if (editorUp && editorControlsVisible) ok("Collabora opens with visible File and Insert controls");
    else if (editorUp) fail("Collabora editor controls", `File/Insert row is hidden or overlapped: ${JSON.stringify(editorDiagnostic)}`);
    else fail("Collabora document open", "editor never became ready or WOPI failed");

    if (editorUp && editorControlsVisible) {
      for (const viewport of [
        { width: 1024, height: 768 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(250);
        const headerBox = await page.locator("#ko-portal-header").boundingBox();
        const officeBox = await page.locator(".office-viewer:not(.office-viewer__embedding)").last().boundingBox();
        if (
          headerBox && officeBox
          && Math.abs(officeBox.y - (headerBox.y + headerBox.height)) <= 2
          && officeBox.y + officeBox.height <= viewport.height + 2
        ) ok(`Collabora/header geometry at ${viewport.width}x${viewport.height}`);
        else fail(
          `Collabora/header geometry at ${viewport.width}x${viewport.height}`,
          `header=${JSON.stringify(headerBox)}, office=${JSON.stringify(officeBox)}`,
        );
      }
      await page.setViewportSize({ width: 1280, height: 720 });
    }

    // Clean up: the New→Document click above creates a real file every run
    // (nightly + each push), which once littered the demo with 21 copies of
    // "Document (n).docx". Delete anything matching that pattern via the
    // session's own WebDAV access.
    const cleaned = await page.evaluate(async () => {
      const uid = OC.getCurrentUser().uid;
      const base = `/remote.php/dav/files/${encodeURIComponent(uid)}/`;
      const res = await fetch(base, {
        method: "PROPFIND",
        headers: { requesttoken: OC.requestToken, Depth: "1" },
      });
      const xml = await res.text();
      const names = [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)]
        .map(m => decodeURIComponent(m[1].split("/").pop() || ""))
        .filter(n => /^Document( \(\d+\))?\.docx$/.test(n));
      for (const n of names) {
        await fetch(base + encodeURIComponent(n), {
          method: "DELETE",
          headers: { requesttoken: OC.requestToken },
        });
      }
      return names.length;
    }).catch(() => -1);
    if (cleaned >= 0) ok(`cleaned up ${cleaned} smoke-created document(s)`);
    else fail("smoke document cleanup", "could not delete the created file");
  } catch (e) {
    fail("Collabora document open", e.message.slice(0, 100));
  }

  // --- Docs, Grist, Element load --------------------------------------------
  for (const host of ["docs", "grist", "element"]) {
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
