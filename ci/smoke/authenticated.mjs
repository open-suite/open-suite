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

import { createHash } from "node:crypto";
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
await page.addInitScript(() => {
  window.__openSuiteFirstPaint = [];
  const sample = () => {
    const shell = document.getElementById("ko-portal-header");
    const nativeHeader = document.getElementById("header");
    const content = document.getElementById("content");
    const pendingStyle = getComputedStyle(document.documentElement, "::before");
    window.__openSuiteFirstPaint.push({
      shell: shell && shell.getBoundingClientRect().toJSON(),
      shellColor: shell && getComputedStyle(shell).backgroundColor,
      pending: document.documentElement.classList.contains("ko-shell-pending") && {
        height: Number.parseFloat(pendingStyle.height),
        color: pendingStyle.backgroundColor,
      },
      nativeHeader: nativeHeader && nativeHeader.getBoundingClientRect().toJSON(),
      content: content && content.getBoundingClientRect().toJSON(),
    });
    if (window.__openSuiteFirstPaint.length < 120) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});
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
  const dashboard = page.locator(".dashboard-grid");
  const loginBtn = page.locator("text=Log in").last();
  await dashboard.or(loginBtn).first().waitFor({ timeout: 30000 });
  if (!(await dashboard.isVisible().catch(() => false))) {
    await loginBtn.click();
  }
  await dashboard.waitFor({ timeout: 30000 });
  ok("portal renders (dashboard widgets present)");

  await page.waitForTimeout(250);
  const portalFrames = await page.evaluate(() => window.__openSuiteFirstPaint);
  const hasValidShellRow = (frame) =>
    (frame.shell?.height === 48 && frame.shell?.y === 0 && frame.shellColor === "rgb(11, 31, 51)") ||
    (frame.pending?.height === 48 && frame.pending?.color === "rgb(11, 31, 51)");
  if (
    portalFrames.length > 0 &&
    portalFrames.every(hasValidShellRow) &&
    portalFrames.some((frame) => frame.shell && !frame.pending)
  )
    ok("portal first-frame filmstrip keeps the 48px Open Suite shell");
  else fail("portal first-frame shell", JSON.stringify(portalFrames));

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

  const chatHref = await page
    .locator("#ko-portal-header")
    .getByRole("link", { name: "Chat", exact: true })
    .getAttribute("href");
  if (chatHref === `https://element.${DOMAIN}/#/home`)
    ok("Chat uses Element's canonical home entry route");
  else fail("Chat entry route", `unexpected href: ${chatHref}`);

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
      logoutUrl.hostname === `messages.${DOMAIN}` &&
      logoutUrl.pathname === "/api/v1.0/logout/" &&
      logoutUrl.search === ""
    )
      ok("suite header starts coordinated logout at Messages");
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

  // Reproduce the lane-3 path before any direct Nextcloud warm-up. Native
  // user_oidc must return to Calendar, not its historical Files fallback.
  await page.goto(`https://bridge.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
  const suiteHeader = page.locator("#ko-portal-header");
  await suiteHeader.getByRole("link", { name: "Calendar", exact: true }).click();
  await page.waitForURL(`https://nextcloud.${DOMAIN}/apps/calendar**`, { timeout: 30000 });
  if (page.url().includes("/apps/calendar"))
    ok("Portal -> Calendar preserves the requested path through native OIDC");
  else fail("Portal -> Calendar return path", `landed on ${page.url()}`);

  // The same first-session must also retain existing Office deep links.
  await page.goto(`https://bridge.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
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
  //
  // Reproduce the Portal -> Element history path before warming Element by a
  // direct navigation. A fresh Element origin takes the immediate SSO path;
  // one Back must therefore skip every login/callback URL and return to the
  // meaningful Portal page. Forward must restore the usable canonical home.
  await page.goto(`https://bridge.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".dashboard-grid").waitFor({ state: "visible", timeout: 30000 });
  const chatLink = page
    .locator("#ko-portal-header")
    .getByRole("link", { name: "Chat", exact: true });
  await chatLink.click();
  await page.waitForURL(`https://element.${DOMAIN}/#/home`, { timeout: 45000 });
  await page.getByText("Send a Direct Message", { exact: true }).waitFor({
    state: "visible",
    timeout: 45000,
  });
  ok("Portal Chat opens usable Element home");

  await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForURL(`https://bridge.${DOMAIN}/**`, { timeout: 30000 });
  await page.locator(".dashboard-grid").waitFor({ state: "visible", timeout: 30000 });
  ok("Element home Back skips root/login/callback history and returns to Portal");

  await page.goForward({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForURL(`https://element.${DOMAIN}/#/home`, { timeout: 30000 });
  await page.getByText("Send a Direct Message", { exact: true }).waitFor({
    state: "visible",
    timeout: 45000,
  });
  ok("Element home Forward restores a usable destination");

  // Explicit room hashes are a separate supported entry contract. They must
  // remain intact (including across auth restoration), while Back/Forward must
  // still traverse directly between that room and Portal.
  const welcomeRoomUrl = `https://element.${DOMAIN}/#/room/#welcome:matrix.${DOMAIN}`;
  await page.goto(`https://bridge.${DOMAIN}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".dashboard-grid").waitFor({ state: "visible", timeout: 30000 });
  await page.goto(welcomeRoomUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
  await page.waitForURL(`https://element.${DOMAIN}/#/room/**`, { timeout: 30000 });
  const restoredRoomUrl = page.url();
  if (restoredRoomUrl.startsWith(`https://element.${DOMAIN}/#/room/`))
    ok("Element room deep link restores as a room route");
  else fail("Element room deep link", `landed on ${restoredRoomUrl}`);

  await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForURL(`https://bridge.${DOMAIN}/**`, { timeout: 30000 });
  await page.locator(".dashboard-grid").waitFor({ state: "visible", timeout: 30000 });
  ok("Element room Back skips login/callback history and returns to Portal");

  await page.goForward({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForURL((url) => url.toString() === restoredRoomUrl, { timeout: 30000 });
  ok("Element room Forward restores the deep link");

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
  await page.waitForURL(`https://nextcloud.${DOMAIN}/apps/calendar**`, { timeout: 30000 });
  await page.waitForTimeout(250);
  const calendarFrames = await page.evaluate(() => window.__openSuiteFirstPaint);
  const calendarViewportHeight = page.viewportSize().height;
  const calendarGeometry = calendarFrames.filter((frame) => frame.nativeHeader || frame.content);
  if (
    calendarGeometry.length > 0 &&
    calendarGeometry.every((frame) =>
      hasValidShellRow(frame) && frame.nativeHeader && frame.content &&
      frame.nativeHeader.y >= 48 &&
      frame.content.y >= frame.nativeHeader.y + frame.nativeHeader.height - 1 &&
      frame.content.y + frame.content.height <= calendarViewportHeight + 1
    ) && calendarGeometry.some((frame) => frame.shell && !frame.pending)
  )
    ok("Nextcloud Calendar filmstrip keeps suite and native controls in separate rows");
  else fail("Nextcloud Calendar first-frame geometry", JSON.stringify(calendarGeometry));
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

  // --- Whiteboard: create, edit, persist, reopen, and clean up --------------
  // app:list is not sufficient: this exercises template registration, the
  // canonical MIME, Viewer handler, editor assets, save path and WebDAV state.
  const whiteboardName = `Open Suite smoke ${Date.now()}`;
  const whiteboardFile = `${whiteboardName}.whiteboard`;
  const whiteboardMarker = "opensuite-whiteboard-smoke-marker";
  try {
    await page.goto(`https://nextcloud.${DOMAIN}/apps/files/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "New", exact: true }).waitFor({ state: "visible", timeout: 30000 });
    await page.getByRole("button", { name: "New", exact: true }).click();
    const newWhiteboard = page.getByRole("menuitem", { name: "New whiteboard", exact: true });
    await newWhiteboard.waitFor({ state: "visible", timeout: 15000 });
    await newWhiteboard.click();

    const createDialog = page.locator("[data-cy-files-new-node-dialog]").first();
    await createDialog.waitFor({ state: "visible", timeout: 15000 });
    const nameField = createDialog.getByRole("textbox", { name: /name/i }).first();
    await nameField.waitFor({ state: "visible", timeout: 10000 });
    await nameField.fill(whiteboardName);
    const create = createDialog.getByRole("button", { name: "Create", exact: true }).first();
    await create.waitFor({ state: "visible", timeout: 10000 });
    await create.click();

    const interactiveCanvas = page.locator(".excalidraw__canvas.interactive").first();
    await interactiveCanvas.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    const canvas = (await interactiveCanvas.count())
      ? interactiveCanvas
      : page.locator(".excalidraw__canvas").first();
    await canvas.waitFor({ state: "visible", timeout: 60000 });
    const viewerHandler = await page.evaluate(() => {
      const handlers = window.OCA?.Viewer?.availableHandlers;
      const whiteboard = Array.isArray(handlers)
        ? handlers.find((handler) => handler?.id === "whiteboard")
        : null;
      return whiteboard ? { id: whiteboard.id, mimes: whiteboard.mimes } : null;
    });
    if (viewerHandler?.mimes?.includes("application/vnd.excalidraw+json"))
      ok("Whiteboard Viewer handler owns application/vnd.excalidraw+json");
    else fail("Whiteboard Viewer handler", JSON.stringify(viewerHandler));

    const textTool = page.locator('[title^="Text"]').first();
    await textTool.waitFor({ state: "visible", timeout: 10000 });
    await textTool.click();
    const canvasBox = await canvas.boundingBox();
    if (!canvasBox) throw new Error("Whiteboard canvas has no interaction geometry");
    const whiteboardEditor = page.locator(".excalidraw-textEditorContainer textarea").first();
    for (let attempt = 0; attempt < 4 && !(await whiteboardEditor.isVisible()); attempt++) {
      await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      await page.waitForTimeout(300);
    }
    await whiteboardEditor.waitFor({ state: "visible", timeout: 10000 });
    await whiteboardEditor.fill(whiteboardMarker);
    await whiteboardEditor.press("Escape");
    await whiteboardEditor.waitFor({ state: "hidden", timeout: 5000 });

    const persisted = await page.evaluate(async ({ fileName, marker }) => {
      const uid = OC.getCurrentUser().uid;
      const url = `/remote.php/dav/files/${encodeURIComponent(uid)}/${encodeURIComponent(fileName)}`;
      for (let attempt = 0; attempt < 30; attempt++) {
        const propfind = await fetch(url, {
          method: "PROPFIND",
          headers: { requesttoken: OC.requestToken, Depth: "0" },
        });
        const properties = await propfind.text();
        const content = propfind.ok ? await fetch(url, {
          headers: { requesttoken: OC.requestToken },
        }) : null;
        const body = content?.ok ? await content.text() : "";
        if (properties.includes("application/vnd.excalidraw+json") && body.includes(marker)) {
          return { ok: true, status: propfind.status };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { ok: false };
    }, { fileName: whiteboardFile, marker: whiteboardMarker });
    if (persisted.ok) ok("Whiteboard edit persists with canonical WebDAV MIME");
    else fail("Whiteboard persistence/MIME", JSON.stringify(persisted));

    await page.reload({ waitUntil: "domcontentloaded" });
    await canvas.waitFor({ state: "visible", timeout: 60000 });
    if (await page.locator('[title^="Text"]').first().isVisible())
      ok("Whiteboard reopens as an editable canvas");
    else fail("Whiteboard reopen", "editor toolbar is not visible after reload");
  } catch (e) {
    fail("Whiteboard editable-board contract", e.message.slice(0, 180));
  } finally {
    const removed = await page.evaluate(async (fileName) => {
      if (!window.OC?.getCurrentUser) return false;
      const uid = OC.getCurrentUser().uid;
      const response = await fetch(
        `/remote.php/dav/files/${encodeURIComponent(uid)}/${encodeURIComponent(fileName)}`,
        { method: "DELETE", headers: { requesttoken: OC.requestToken } },
      );
      return response.ok || response.status === 404;
    }, whiteboardFile).catch(() => false);
    if (removed) ok("cleaned up smoke-created whiteboard");
    else fail("Whiteboard cleanup", `could not delete ${whiteboardFile}`);
  }

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
  const officeFixtureStamp = Date.now();
  const fixtureFolder = `OpenSuite-Smoke-InsertImage-${officeFixtureStamp}`;
  const fixtureImage = `OpenSuite-Real-JPEG-${officeFixtureStamp}.jpg`;
  const secondFixtureImage = `OpenSuite-Second-JPEG-${officeFixtureStamp}.jpg`;
  const smokeDocumentBase = `OpenSuite-Smoke-Office-${officeFixtureStamp}`;
  const smokeDocumentName = `${smokeDocumentBase}.docx`;
  let fixtureBase = "";
  let officeUserId = "";
  try {
    await page.goto(`https://nextcloud.${DOMAIN}/apps/files/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "New", exact: true }).waitFor({ timeout: 30000 });
    officeUserId = await page.evaluate(() => OC.getCurrentUser().uid);

    // Exercise the same path as a person selecting an ordinary camera-style
    // upload in Files. A large, two-colour JPEG makes Collabora rendering
    // measurable; the old synthetic 1x1 fixtures could deliver an error body
    // and still pass because the smoke stopped at postMessage delivery.
    const jpegBase64 = await page.evaluate(() => {
      const render = (left, right, label) => {
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 450;
        const context = canvas.getContext("2d");
        context.fillStyle = left;
        context.fillRect(0, 0, 400, 450);
        context.fillStyle = right;
        context.fillRect(400, 0, 400, 450);
        context.fillStyle = "#ffffff";
        context.font = "bold 56px sans-serif";
        context.textAlign = "center";
        context.fillText("Open Suite", 400, 205);
        context.font = "30px sans-serif";
        context.fillText(label, 400, 260);
        return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
      };
      return [
        render("#f15a29", "#00a6d6", "ordinary JPEG first insertion"),
        render("#39b54a", "#8a3ffc", "ordinary JPEG second insertion"),
      ];
    });
    const [jpeg, secondJpeg] = jpegBase64.map(value => Buffer.from(value, "base64"));
    const jpegHash = createHash("sha256").update(jpeg).digest("hex");
    const secondJpegHash = createHash("sha256").update(secondJpeg).digest("hex");
    for (const image of [jpeg, secondJpeg]) {
      if (
        image.length < 10000
        || !image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        || !image.subarray(-2).equals(Buffer.from([0xff, 0xd9]))
      ) throw new Error(`browser produced an invalid JPEG (${image.length} bytes)`);
    }

    await page.getByRole("button", { name: "New", exact: true }).click();
    const fileChooser = page.waitForEvent("filechooser");
    await page.getByText("Upload files", { exact: true }).first().click();
    await (await fileChooser).setFiles([
      { name: fixtureImage, mimeType: "image/jpeg", buffer: jpeg },
      { name: secondFixtureImage, mimeType: "image/jpeg", buffer: secondJpeg },
    ]);
    await page.waitForFunction(async ({ uid, fixtureImages }) => {
      const responses = await Promise.all(fixtureImages.map(fixtureImage => fetch(
        `/remote.php/dav/files/${encodeURIComponent(uid)}/${encodeURIComponent(fixtureImage)}`,
        { method: "HEAD", headers: { requesttoken: OC.requestToken } },
      )));
      return responses.every(response => response.ok);
    }, { uid: officeUserId, fixtureImages: [fixtureImage, secondFixtureImage] }, { timeout: 30000 });

    const fixtures = await page.evaluate(async ({ fixtureFolder, fixtureImages }) => {
      const uid = OC.getCurrentUser().uid;
      const root = `/remote.php/dav/files/${encodeURIComponent(uid)}/`;
      const base = `${root}${encodeURIComponent(fixtureFolder)}/`;
      const headers = { requesttoken: OC.requestToken };
      const mkdir = await fetch(base, { method: "MKCOL", headers });
      const files = [];
      for (const fixtureImage of fixtureImages) {
        const destination = new URL(`${base}${encodeURIComponent(fixtureImage)}`, location.origin).href;
        const move = await fetch(`${root}${encodeURIComponent(fixtureImage)}`, {
          method: "MOVE",
          headers: { ...headers, Destination: destination, Overwrite: "F" },
        });
        const content = await fetch(`${base}${encodeURIComponent(fixtureImage)}`, { headers });
        const bytes = new Uint8Array(await content.arrayBuffer());
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map(value => value.toString(16).padStart(2, "0")).join("");
        files.push({
          name: fixtureImage,
          statuses: { move: move.status, get: content.status },
          contentType: content.headers.get("content-type"),
          length: bytes.length,
          magic: [...bytes.slice(0, 3)],
          trailer: [...bytes.slice(-2)],
          digest,
        });
      }
      const favorite = await fetch(`${base}${encodeURIComponent(fixtureImages[0])}`, {
        method: "PROPPATCH",
        headers: { ...headers, "Content-Type": "application/xml; charset=utf-8" },
        body: '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set></d:propertyupdate>',
      });
      return {
        uid,
        root,
        base,
        statuses: { mkdir: mkdir.status, favorite: favorite.status },
        files,
      };
    }, { fixtureFolder, fixtureImages: [fixtureImage, secondFixtureImage] });
    fixtureBase = fixtures.base;
    const expectedFiles = new Map([
      [fixtureImage, { length: jpeg.length, digest: jpegHash }],
      [secondFixtureImage, { length: secondJpeg.length, digest: secondJpegHash }],
    ]);
    if (
      fixtures.statuses.mkdir === 201
      && fixtures.statuses.favorite === 207
      && fixtures.files.length === expectedFiles.size
      && fixtures.files.every(file => {
        const expected = expectedFiles.get(file.name);
        return expected
          && [201, 204].includes(file.statuses.move)
          && file.statuses.get === 200
          && file.contentType?.split(";", 1)[0] === "image/jpeg"
          && file.length === expected.length
          && JSON.stringify(file.magic) === "[255,216,255]"
          && JSON.stringify(file.trailer) === "[255,217]"
          && file.digest === expected.digest;
      })
    ) ok("ordinary JPEGs uploaded through Files retain exact DAV MIME, magic, and bytes");
    else throw new Error(`uploaded JPEG contracts failed: ${JSON.stringify(fixtures)}`);

    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.locator('[role="menuitem"], .v-popper__popper button, .v-popper__popper li')
      .filter({ hasText: /^\s*Document\s*$/ }).first().click({ timeout: 8000 });
    const documentDialog = page.locator("[data-cy-files-new-node-dialog]").first();
    await documentDialog.waitFor({ state: "visible", timeout: 15000 });
    const documentNameField = documentDialog.getByRole("textbox", { name: /name/i }).first();
    await documentNameField.fill(smokeDocumentBase);
    await documentDialog.getByRole("button", { name: "Create", exact: true }).first().click();
    await page.waitForFunction(async ({ uid, smokeDocumentName }) => {
      const response = await fetch(
        `/remote.php/dav/files/${encodeURIComponent(uid)}/${encodeURIComponent(smokeDocumentName)}`,
        { method: "HEAD", headers: { requesttoken: OC.requestToken } },
      );
      return response.ok;
    }, { uid: officeUserId, smokeDocumentName }, { timeout: 30000 });
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

    // richdocuments' Insert Image flow crosses three security boundaries:
    // Collabora asks the parent to open the picker, the authenticated parent
    // lists files over DAV, and the selected file is copied through the assets
    // endpoint before its URL is posted back to the cross-origin editor.
    if (editorUp && editorControlsVisible) {
      try {
        const missingAsset = await page.evaluate(async () => {
          const response = await fetch("/apps/richdocuments/assets", {
            method: "POST",
            credentials: "same-origin",
            headers: {
              requesttoken: OC.requestToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ path: "/OpenSuite-Smoke-Missing-Image.png" }),
          });
          return response.status;
        });
        if (missingAsset === 404) ok("richdocuments asset creation reports a missing-file error");
        else throw new Error(`missing richdocuments asset returned HTTP ${missingAsset}, expected 404`);

        const anonymous = await browser.newContext({
          ignoreHTTPSErrors: process.env.SMOKE_INSECURE === "1",
        });
        try {
          const validateAssetUrl = (value) => {
            const url = new URL(value);
            if (
              url.protocol !== "https:"
              || url.host !== `nextcloud.${DOMAIN}`
              || url.search
              || !/^\/(?:index\.php\/)?apps\/richdocuments\/assets\/[A-Za-z0-9]{64}$/.test(url.pathname)
            ) throw new Error(`richdocuments returned an invalid asset URL: ${value}`);
            return url;
          };

          const anonymousDav = await anonymous.request.fetch(
            `https://nextcloud.${DOMAIN}${fixtures.root}`,
            { method: "PROPFIND", headers: { Depth: "1" }, maxRedirects: 0 }
          );
          if ([401, 403].includes(anonymousDav.status()) || (anonymousDav.status() >= 300 && anonymousDav.status() < 400))
            ok(`unauthenticated DAV root listing is denied (HTTP ${anonymousDav.status()})`);
          else throw new Error(`unauthenticated PROPFIND returned HTTP ${anonymousDav.status()} (must never be 207)`);

          const anonymousAsset = await anonymous.request.post(
            `https://nextcloud.${DOMAIN}/apps/richdocuments/assets`,
            {
              data: { path: `/${fixtureFolder}/${fixtureImage}` },
              maxRedirects: 0,
            }
          );
          if (anonymousAsset.status() >= 300)
            ok(`unauthenticated richdocuments asset creation is denied (HTTP ${anonymousAsset.status()})`);
          else throw new Error(`unauthenticated asset POST returned HTTP ${anonymousAsset.status()}`);

          // Probe a separate one-use token before asking Collabora to consume
          // one. HEAD is non-consuming; GET must deliver the exact JPEG bytes,
          // never a 200 login/error page or generic octet-stream response.
          const probeAssetResponse = await page.evaluate(async (path) => {
            const response = await fetch("/apps/richdocuments/assets", {
              method: "POST",
              credentials: "same-origin",
              headers: {
                requesttoken: OC.requestToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ path }),
            });
            return {
              status: response.status,
              contentType: response.headers.get("content-type"),
              body: await response.text(),
            };
          }, `/${fixtureFolder}/${fixtureImage}`);
          if (
            probeAssetResponse.status < 200
            || probeAssetResponse.status >= 300
            || probeAssetResponse.contentType?.split(";", 1)[0] !== "application/json"
          ) throw new Error(`asset probe POST failed: ${JSON.stringify(probeAssetResponse)}`);
          let probeAsset;
          try {
            probeAsset = JSON.parse(probeAssetResponse.body);
          } catch {
            throw new Error(`asset probe POST returned invalid JSON: ${JSON.stringify(probeAssetResponse.body.slice(0, 160))}`);
          }
          validateAssetUrl(probeAsset.url);

          // LibreOffice's WebDAV UCB probes remote graphics with OPTIONS
          // before fetching them. The edge gate must pass this exact tokenized
          // route through without redirecting the kit to the login host.
          const assetOptions = await anonymous.request.fetch(probeAsset.url, {
            method: "OPTIONS",
            maxRedirects: 0,
          });
          if (
            assetOptions.status() >= 200
            && assetOptions.status() < 500
            && !assetOptions.headers().location
          ) ok(`extensionless asset OPTIONS stays on Nextcloud (HTTP ${assetOptions.status()})`);
          else {
            throw new Error(
              `asset OPTIONS contract failed: HTTP ${assetOptions.status()}, `
              + `location=${assetOptions.headers().location || "none"}`
            );
          }

          const assetHead = await anonymous.request.head(probeAsset.url, { maxRedirects: 0 });
          const headType = assetHead.headers()["content-type"]?.split(";", 1)[0];
          if (
            assetHead.status() !== 200
            || assetHead.headers().location
            || headType !== "image/jpeg"
            || !/^attachment(?:;|$)/i.test(assetHead.headers()["content-disposition"] || "")
            || assetHead.headers()["x-content-type-options"]?.toLowerCase() !== "nosniff"
          ) {
            throw new Error(
              `asset HEAD contract failed: HTTP ${assetHead.status()}, type=${headType || "none"}, `
              + `disposition=${assetHead.headers()["content-disposition"] || "none"}, `
              + `nosniff=${assetHead.headers()["x-content-type-options"] || "none"}, `
              + `location=${assetHead.headers().location || "none"}`
            );
          }
          ok("extensionless asset HEAD is anonymously reachable with image/jpeg and nosniff");

          const assetGet = await anonymous.request.get(probeAsset.url, { maxRedirects: 0 });
          const assetBody = await assetGet.body();
          const getType = assetGet.headers()["content-type"]?.split(";", 1)[0];
          const assetDigest = createHash("sha256").update(assetBody).digest("hex");
          if (
            assetGet.status() !== 200
            || assetGet.headers().location
            || getType !== "image/jpeg"
            || !/^attachment(?:;|$)/i.test(assetGet.headers()["content-disposition"] || "")
            || assetBody.length !== jpeg.length
            || !assetBody.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
            || !assetBody.subarray(-2).equals(Buffer.from([0xff, 0xd9]))
            || assetDigest !== jpegHash
          ) {
            throw new Error(
              `asset GET contract failed: HTTP ${assetGet.status()}, type=${getType || "none"}, `
              + `length=${assetBody.length}, sha256=${assetDigest}, location=${assetGet.headers().location || "none"}, `
              + `body=${JSON.stringify(assetBody.subarray(0, 160).toString("utf8"))}`
            );
          }
          ok("asset GET streams the exact real JPEG MIME, magic, length, and bytes");

          const consumedProbe = await anonymous.request.get(probeAsset.url, { maxRedirects: 0 });
          if (consumedProbe.status() >= 400 && !consumedProbe.headers().location)
            ok(`diagnostic asset token is one-use (HTTP ${consumedProbe.status()})`);
          else throw new Error(`consumed diagnostic asset returned HTTP ${consumedProbe.status()}`);

          const cool = page.frames().find(f => f.url().includes("cool.html"));
          if (!cool) throw new Error("Collabora frame disappeared before Insert Image automation");
          await cool.evaluate(() => {
            window.__openSuiteInsertGraphicMessages = [];
            window.addEventListener("message", event => {
              const value = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
              if (/Action_InsertGraphic/.test(value || "")) window.__openSuiteInsertGraphicMessages.push(value);
            });
          });

          const insertAndRender = async ({ imageName, palette, exerciseViews }) => {
            const previousMessageCount = await cool.evaluate(
              () => window.__openSuiteInsertGraphicMessages.length,
            );
            const allFilesDav = exerciseViews
              ? page.waitForResponse(response =>
                response.request().method() === "PROPFIND"
                && response.url().includes("/remote.php/dav/files/"), { timeout: 15000 })
              : null;
            try {
              await cool.locator("#menu-insert > a").click({ timeout: 5000 });
              await cool.locator("#menu-insertgraphicremote > a").click({ timeout: 5000 });
            } catch (error) {
              const visible = (await cool.locator("body").innerText().catch(() => "")).slice(0, 1000);
              throw new Error(`could not invoke Collabora Insert > Image: ${error.message}; frame text=${JSON.stringify(visible)}`);
            }

            const picker = page.getByRole("dialog").filter({ hasText: "Insert file from Open Suite" }).last();
            await picker.getByText("Insert file from Open Suite", { exact: true }).waitFor({ timeout: 15000 });
            await picker.getByText("All files", { exact: true }).waitFor({ state: "visible" });
            if (allFilesDav) {
              const allFilesResponse = await allFilesDav;
              if (allFilesResponse.status() !== 207)
                throw new Error(`All files PROPFIND returned HTTP ${allFilesResponse.status()}`);
              ok("Insert Image All files DAV listing succeeds");
            }

            await picker.getByText(fixtureFolder, { exact: true }).click();
            await picker.getByText(imageName, { exact: true }).waitFor({ state: "visible" });
            if (exerciseViews) {
              ok("Insert Image renders folder navigation and the Files-uploaded JPEG");

              const recentDav = page.waitForResponse(response =>
                response.request().method() === "SEARCH" && response.url().includes("/remote.php/dav/"),
                { timeout: 15000 });
              await picker.getByText("Recent", { exact: true }).click();
              const recentResponse = await recentDav;
              if (recentResponse.status() !== 207)
                throw new Error(`Recent DAV SEARCH returned HTTP ${recentResponse.status()}`);
              await picker.getByText(imageName, { exact: true }).waitFor({ state: "visible" });
              ok("Insert Image Recent DAV search succeeds and renders the uploaded JPEG");

              const favoritesDav = page.waitForResponse(response =>
                response.request().method() === "REPORT" && response.url().includes("/remote.php/dav/"),
                { timeout: 15000 });
              await picker.getByText("Favorites", { exact: true }).click();
              const favoritesResponse = await favoritesDav;
              if (favoritesResponse.status() !== 207)
                throw new Error(`Favorites DAV REPORT returned HTTP ${favoritesResponse.status()}`);
              await picker.getByText(imageName, { exact: true }).waitFor({ state: "visible" });
              ok("Insert Image Favorites DAV search succeeds and renders the favorited JPEG");

              const filter = picker.getByRole("textbox", { name: "Filter file list" });
              await filter.fill("guaranteed-no-match-opensuite-smoke");
              await picker.getByText(imageName, { exact: true }).waitFor({ state: "hidden" });
              await picker.getByText("No matching files", { exact: true }).waitFor({ state: "visible" });
              ok("Insert Image text filter renders a guaranteed empty listing");
              await filter.fill("");
            }
            await picker.getByText(imageName, { exact: true }).click();

            const assetPost = page.waitForResponse(response =>
              response.request().method() === "POST"
              && response.url().includes("/apps/richdocuments/assets"), { timeout: 15000 });
            await picker.getByRole("button", { name: "Insert file", exact: true }).click();
            const assetResponse = await assetPost;
            if (!assetResponse.ok())
              throw new Error(`richdocuments asset POST returned HTTP ${assetResponse.status()}`);
            const assetContentType = assetResponse.headers()["content-type"]?.split(";", 1)[0];
            const assetText = await assetResponse.text();
            if (assetContentType !== "application/json") {
              throw new Error(`richdocuments asset POST returned ${assetContentType || "no Content-Type"}, body=${JSON.stringify(assetText.slice(0, 160))}`);
            }
            let asset;
            try {
              asset = JSON.parse(assetText);
            } catch {
              throw new Error(`richdocuments asset POST returned invalid JSON: ${JSON.stringify(assetText.slice(0, 160))}`);
            }
            validateAssetUrl(asset.url);

            await cool.waitForFunction(
              (count) => window.__openSuiteInsertGraphicMessages?.length > count,
              previousMessageCount,
              { timeout: 15000 },
            );
            const actionRaw = await cool.evaluate(() => window.__openSuiteInsertGraphicMessages.at(-1));
            const action = JSON.parse(actionRaw);
            if (
              action.MessageId !== "Action_InsertGraphic"
              || action.Values?.filename !== imageName
              || action.Values?.url !== asset.url
            ) throw new Error(`wrong Action_InsertGraphic payload: ${actionRaw}`);

            // Rendering—not message delivery—is the contract. Each generated
            // JPEG has two large, distinct colour fields. A 200 HTML/error body,
            // wrong MIME/magic, blocked URL, or decoder failure instead shows
            // "Unknown image format" and never satisfies this assertion.
            let renderState = { first: 0, second: 0, unknown: false };
            for (let attempt = 0; attempt < 40; attempt++) {
              renderState = await cool.evaluate((expectedPalette) => {
                const unknown = /Unknown image format/i.test(document.body?.innerText || "");
                const canvas = document.querySelector("#document-canvas");
                if (!canvas) return { first: 0, second: 0, unknown, error: "missing document canvas" };
                try {
                  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
                  let first = 0;
                  let second = 0;
                  for (let offset = 0; offset < pixels.length; offset += 16) {
                    const red = pixels[offset];
                    const green = pixels[offset + 1];
                    const blue = pixels[offset + 2];
                    if (expectedPalette === "orange-cyan") {
                      if (red > 180 && green > 40 && green < 150 && blue < 120) first++;
                      if (red < 100 && green > 110 && blue > 130) second++;
                    } else {
                      if (red < 120 && green > 120 && blue < 140) first++;
                      if (red > 90 && red < 190 && green < 120 && blue > 150) second++;
                    }
                  }
                  return { first, second, unknown };
                } catch (error) {
                  return { first: 0, second: 0, unknown, error: error.message };
                }
              }, palette);
              if (renderState.unknown) throw new Error("Collabora displayed ‘Unknown image format’");
              if (renderState.first > 250 && renderState.second > 250) break;
              await page.waitForTimeout(500);
            }
            if (renderState.first <= 250 || renderState.second <= 250) {
              throw new Error(`${imageName} never rendered visibly in Collabora: ${JSON.stringify(renderState)}`);
            }

            const consumedAsset = await anonymous.request.get(asset.url, { maxRedirects: 0 });
            if (consumedAsset.status() < 400 || consumedAsset.headers().location) {
              throw new Error(
                `Collabora did not consume its asset URL: HTTP ${consumedAsset.status()}, `
                + `location=${consumedAsset.headers().location || "none"}`
              );
            }
            ok(`Collabora visibly renders ${imageName} (${renderState.first}/${renderState.second} sampled pixels)`);
            return asset.url;
          };

          const firstAssetUrl = await insertAndRender({
            imageName: fixtureImage,
            palette: "orange-cyan",
            exerciseViews: true,
          });
          const secondAssetUrl = await insertAndRender({
            imageName: secondFixtureImage,
            palette: "green-purple",
            exerciseViews: false,
          });
          if (firstAssetUrl === secondAssetUrl)
            throw new Error("second insertion reused the first one-use asset token");
          ok("a second picker insertion uses a fresh token and visibly renders a second JPEG");
        } finally {
          await anonymous.close();
        }
      } catch (error) {
        fail("Collabora Insert Image picker", error.message.slice(0, 1000));
      }
    }
  } catch (e) {
    fail("Collabora document open", e.message.slice(0, 100));
  } finally {
    // Leave the editor before deleting the exact uniquely named artifacts so
    // Collabora releases its lock. Never glob users' ordinary Document files.
    if (officeUserId) {
      await page.goto(`https://nextcloud.${DOMAIN}/apps/files/`, { waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForFunction(() => window.OC?.requestToken, null, { timeout: 30000 }).catch(() => null);
      const cleanup = await page.evaluate(async ({ uid, fixtureBase, fixtureImage, secondFixtureImage, smokeDocumentName }) => {
        const headers = { requesttoken: OC.requestToken };
        const root = `/remote.php/dav/files/${encodeURIComponent(uid)}/`;
        const favorite = fixtureBase
          ? await fetch(`${fixtureBase}${encodeURIComponent(fixtureImage)}`, {
            method: "PROPPATCH",
            headers: { ...headers, "Content-Type": "application/xml; charset=utf-8" },
            body: '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>0</oc:favorite></d:prop></d:set></d:propertyupdate>',
          }).then(response => response.status)
          : 404;
        const folder = fixtureBase
          ? await fetch(fixtureBase, { method: "DELETE", headers }).then(response => response.status)
          : 404;
        const document = await fetch(`${root}${encodeURIComponent(smokeDocumentName)}`, {
          method: "DELETE",
          headers,
        }).then(response => response.status);
        const rootImage = await fetch(`${root}${encodeURIComponent(fixtureImage)}`, {
          method: "DELETE",
          headers,
        }).then(response => response.status);
        const secondRootImage = await fetch(`${root}${encodeURIComponent(secondFixtureImage)}`, {
          method: "DELETE",
          headers,
        }).then(response => response.status);
        return { favorite, folder, document, rootImage, secondRootImage };
      }, { uid: officeUserId, fixtureBase, fixtureImage, secondFixtureImage, smokeDocumentName })
        .catch(() => ({ favorite: -1, folder: -1, document: -1, rootImage: -1, secondRootImage: -1 }));
      if (
        [207, 404].includes(cleanup.favorite)
        && [200, 204, 404].includes(cleanup.folder)
        && [200, 204, 404].includes(cleanup.document)
        && [200, 204, 404].includes(cleanup.rootImage)
        && [200, 204, 404].includes(cleanup.secondRootImage)
      ) {
        ok(`cleaned exact Insert Image artifacts (${cleanup.favorite}/${cleanup.folder}/${cleanup.document}/${cleanup.rootImage}/${cleanup.secondRootImage})`);
      } else {
        fail("Insert Image artifact cleanup", JSON.stringify(cleanup));
      }
    }
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
