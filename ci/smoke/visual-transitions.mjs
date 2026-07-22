// Focused visual-transition gate for the live assembled stack. Evidence is
// intentionally top-level and sanitized: never emit credentials, cookies,
// storage state, response bodies, or URL query values.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  assessElementHome,
  chooseCandidate,
  contractOutcome,
  enforceArtifactBudget,
  parseMode,
  sameDeepLink,
  sanitizeUrl,
} from "./visual-transition-helpers.mjs";

const { SMOKE_DOMAIN: domain, SMOKE_USER: user, SMOKE_PASS: pass } = process.env;
if (!domain || !user || !pass) {
  console.error("SMOKE_DOMAIN, SMOKE_USER and SMOKE_PASS are required");
  process.exit(2);
}

const mode = parseMode(process.env.SMOKE_VISUAL_CONTRACT);
const root = path.resolve(process.env.SMOKE_ARTIFACT_DIR || "smoke-visual-artifacts");
const maxArtifactBytes = Number.parseInt(process.env.SMOKE_ARTIFACT_MAX_BYTES || "78643200", 10);
if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) throw new Error("SMOKE_ARTIFACT_MAX_BYTES must be a positive integer");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const browser = await chromium.launch();
const reports = [];
let authenticatedState;
const safeName = (value) => value.replace(/[^a-z0-9-]/gi, "-").slice(0, 60);
const portalUrl = `https://bridge.${domain}/`;

async function journey(name, action) {
  const dir = path.join(root, safeName(name));
  await mkdir(dir, { recursive: true });
  const timeline = [];
  const layoutShifts = [];
  const headerTimeline = [];
  const surfaceTimeline = [];
  const rawDocumentRequests = new WeakMap();
  const pageLabels = new WeakMap();
  let popupPage;
  let context;
  let page;
  const observations = [];
  const blocking = [];
  let exists = true;
  const check = (label, ok, hard = true, detail = "") => observations.push({ label, ok: Boolean(ok), hard, detail });
  const contract = (label, ok, detail = "") => {
    const item = { label, ok: Boolean(ok), detail };
    blocking.push(item);
    return item;
  };

  try {
    const recordsVideo = Boolean(authenticatedState);
    context = await browser.newContext({
      ...(authenticatedState ? { storageState: authenticatedState } : {}),
      viewport: { width: 1280, height: 720 },
      locale: "en-GB",
      timezoneId: "Europe/Amsterdam",
      reducedMotion: "reduce",
      ignoreHTTPSErrors: process.env.SMOKE_INSECURE === "1",
      ...(recordsVideo ? { recordVideo: { dir, size: { width: 1280, height: 720 } } } : {}),
    });
    await context.exposeBinding("__osTransitionRecord", ({ page: sourcePage }, entry) => {
      const target = entry.type === "layout-shift" ? layoutShifts
        : entry.type === "header" ? headerTimeline : surfaceTimeline;
      target.push({ page: pageLabels.get(sourcePage) || "top", document: sanitizeUrl(sourcePage.url()), ...entry });
    });
    await context.addInitScript(() => {
      const send = (entry) => window.__osTransitionRecord({ at: performance.now(), ...entry }).catch(() => {});
      let lastHeader = "";
      let headerWasPresent = false;
      const seenSurfaces = new Set();
      const surface = (name) => {
        if (seenSurfaces.has(name)) return;
        seenSurfaces.add(name);
        send({ type: "surface", name });
      };
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      let rootResizeObserver;
      const sample = () => {
        const root = document.documentElement;
        if (root && !rootResizeObserver) {
          rootResizeObserver = new ResizeObserver(sample);
          rootResizeObserver.observe(root);
        }
        const header = document.querySelector("#ko-portal-header");
        const geometry = header ? header.getBoundingClientRect().toJSON() : null;
        const value = JSON.stringify({ present: Boolean(header), version: header?.dataset.version || null, geometry });
        if (value !== lastHeader) {
          send({ type: "header", event: header ? (headerWasPresent ? "geometry/version" : "inserted") : (headerWasPresent ? "removed" : "absent"), version: header?.dataset.version || null, geometry });
          lastHeader = value;
          headerWasPresent = Boolean(header);
        }
        const nativeTop = [...document.querySelectorAll("#header, header, .mx_MatrixChat_wrapper, [class*='app-navigation']")]
          .find((element) => element.id !== "ko-portal-header" && visible(element) && element.getBoundingClientRect().top < 48);
        if (!header && nativeTop) surface("native/headerless top strip");
        const text = document.body?.innerText || "";
        const pendingStyle = root?.classList.contains("ko-shell-pending")
          ? getComputedStyle(root, "::before") : null;
        const pendingContent = pendingStyle?.content?.replaceAll('"', "") || "";
        if (!header && pendingStyle && Number.parseFloat(pendingStyle.height) >= 40 && !/Open Suite/i.test(pendingContent)) {
          surface("unbranded pending shell");
        }
        if (visible(document.querySelector("#kc-form-login"))) surface("native/provider login");
        if (location.hostname.startsWith("nextcloud.")
          && visible(document.querySelector('form[name="login"], #login'))) surface("Nextcloud native login");
        if (/No office suite is deployed/i.test(text)) surface("No office suite is deployed");
        if (/received state has expired|Access forbidden/i.test(text)) surface("Nextcloud stale login state");
        if (/Unable to load|Failed to load|Something went wrong|Internal Server Error/i.test(text)) {
          surface("Office load error");
        }
        const activeOffice = document.querySelector('#app-navigation-vue [aria-current="page"]');
        const activeOfficeTitle = (activeOffice?.getAttribute("title") || activeOffice?.textContent || "").trim();
        if (/^(Documents|Spreadsheets|Presentations|Diagrams)$/.test(activeOfficeTitle)) {
          surface(`Office active section: ${activeOfficeTitle}`);
        }
        if (/Connecting to chat/i.test(text)) surface("Connecting to chat");
      };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) send({ type: "layout-shift", value: entry.value });
        }
      }).observe({ type: "layout-shift", buffered: true });
      new MutationObserver(sample).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "data-version", "aria-current"] });
      sample();
    });

    context.on("request", (request) => {
      const frame = request.frame();
      if (!request.isNavigationRequest() || frame !== frame.page().mainFrame()) return;
      const sourcePage = frame.page();
      const requests = rawDocumentRequests.get(sourcePage) || [];
      requests.push(request.url());
      rawDocumentRequests.set(sourcePage, requests);
      timeline.push({ page: pageLabels.get(sourcePage) || "top", event: "document-request", url: sanitizeUrl(request.url()) });
    });
    context.on("response", (response) => {
      const request = response.request();
      const frame = request.frame();
      if (!request.isNavigationRequest() || frame !== frame.page().mainFrame()) return;
      timeline.push({
        page: pageLabels.get(frame.page()) || "top",
        event: "document-response",
        status: response.status(),
        redirected: Boolean(request.redirectedFrom()),
        url: sanitizeUrl(response.url()),
      });
    });
    context.on("page", (candidate) => {
      pageLabels.set(candidate, page ? "popup" : "top");
      candidate.on("framenavigated", (frame) => {
        if (frame === candidate.mainFrame()) {
          timeline.push({ page: pageLabels.get(candidate) || "top", event: "committed", url: sanitizeUrl(frame.url()) });
        }
      });
    });

    page = await context.newPage();
    pageLabels.set(page, "top");
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);

    await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
    let submittedFreshCredentials = false;
    if (page.url().includes(`id.${domain}`) && !authenticatedState) {
      await page.locator("#username").fill(user);
      await page.locator("#password").fill(pass);
      await page.locator("#kc-login").click();
      submittedFreshCredentials = true;
    }
    if (page.url().includes(`id.${domain}`) && authenticatedState) {
      throw new Error("authenticated session unexpectedly returned to Keycloak");
    }
    await page.waitForURL(`${portalUrl}**`);
    const dashboard = page.locator(".dashboard-grid");
    const login = page.getByText("Log in", { exact: true }).last();
    await dashboard.or(login).first().waitFor({ timeout: 30_000 });
    const secondLogin = !(await dashboard.isVisible().catch(() => false));
    if (secondLogin) await login.click();
    await dashboard.waitFor({ timeout: 30_000 });
    check("authenticated dashboard visible", true);
    if (!authenticatedState) check("fresh browser authenticated through Keycloak", submittedFreshCredentials);
    contract("no Portal second login", !secondLogin);
    const portalHeaderVersion = await assertHeader(page, "Portal", check);
    if (!authenticatedState) authenticatedState = await context.storageState();

    await action({
      page,
      context,
      rawDocumentRequests,
      portalHeaderVersion,
      timeline,
      headerTimeline,
      surfaceTimeline,
      check,
      contract,
      setMissing: () => { exists = false; },
      setPopup: (candidate) => { popupPage = candidate; pageLabels.set(candidate, "popup"); },
    });

    contract("Connecting to chat never visible", !surfaceTimeline.some((item) => item.name === "Connecting to chat"));
    contract("native/headerless top strip never visible", !surfaceTimeline.some((item) => item.name === "native/headerless top strip"));
    contract("header is never removed after insertion", !headerTimeline.some((item) => item.event === "removed"));
  } catch (error) {
    // Playwright errors can embed full navigation URLs. Keep diagnostics in
    // screenshots/video and only record the non-sensitive error class here.
    check("journey completed", false, true, error?.name || "Error");
  }

  const outcome = contractOutcome({ mode, exists, observations, blocking });
  if (outcome.failed && context) {
    // Before authenticatedState exists, a failed Keycloak form can still hold
    // credentials. Never persist pixels from that context.
    if (authenticatedState) {
      await page?.screenshot({ path: path.join(dir, "failure-top.png"), fullPage: true }).catch(() => {});
      await popupPage?.screenshot({ path: path.join(dir, "failure-popup.png"), fullPage: true }).catch(() => {});
    }
    // A native Playwright trace serializes Cookie/Authorization headers. This
    // sanitized trace contains the deterministic browser evidence needed for
    // triage without ever persisting session secrets.
    await writeFile(path.join(dir, "trace-sanitized.json"), JSON.stringify({
      name,
      timeline,
      layoutShifts,
      headerTimeline,
      surfaceTimeline,
      observations,
      contract: blocking,
    }, null, 2));
  }
  await context?.close().catch(() => {});
  if (!outcome.failed) await rm(dir, { recursive: true, force: true });
  reports.push({
    name,
    mode,
    outcome,
    observations,
    contract: blocking,
    timeline,
    layoutShifts,
    layoutShiftTotal: layoutShifts.reduce((total, entry) => total + entry.value, 0),
    headerTimeline,
    surfaceTimeline,
  });
}

async function assertHeader(page, label, check, expectedVersion) {
  const header = page.locator("#ko-portal-header");
  await header.waitFor({ state: "visible", timeout: 30_000 });
  const version = await header.getAttribute("data-version");
  const box = await header.boundingBox();
  check(`${label} shared header visible/versioned/geometric`, Boolean(version && box && box.y <= 1 && box.height >= 40));
  if (expectedVersion) check(`${label} shared header version matches Portal`, version === expectedVersion);
  return version;
}

async function sameTab({ page, rawDocumentRequests, portalHeaderVersion, check, contract }, linkName, destination) {
  const link = page.locator("#ko-portal-header").getByRole("link", { name: linkName, exact: true });
  const href = await link.getAttribute("href");
  if (!href) throw new Error(`${linkName} has no href`);
  await link.click();
  await page.waitForURL((url) => url.hostname === destination.hostname, { timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  check(`${destination.label} final host`, new URL(page.url()).hostname === destination.hostname);
  contract("exact deep link requested", (rawDocumentRequests.get(page) || []).some((url) => sameDeepLink(url, href, portalUrl)));
  await assertHeader(page, destination.label, check, portalHeaderVersion);
  await destination.ready(page);

  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForURL(`${portalUrl}**`);
  await page.locator(".dashboard-grid").waitFor();
  check("Back returns authenticated Portal", true);
  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.hostname === destination.hostname, { timeout: 30_000 });
  await destination.ready(page);
  contract("Forward restores usable destination", true);
  // Interact only after history traversal: selecting a Chat room can create
  // its own hash-history entry and would otherwise make Back test the room
  // router rather than the Portal -> Chat transition.
  await destination.interact(page);
  check(`${destination.label} interaction marker usable`, true);
}

async function officeDocuments({ page, rawDocumentRequests, portalHeaderVersion, timeline, surfaceTimeline, check, contract }) {
  const timelineStart = timeline.length;
  const surfaceStart = surfaceTimeline.length;
  const header = page.locator("#ko-portal-header");
  await header.getByRole("button", { name: "Office ▾", exact: true }).click();
  const link = header.getByRole("link", { name: "Documents", exact: true });
  const href = await link.getAttribute("href");
  if (!href) throw new Error("Documents has no href");
  await link.click();

  await page.waitForURL((url) => url.hostname === `nextcloud.${domain}`
    && url.pathname === "/apps/office/documents" && !url.search && !url.hash, { timeout: 45_000 });
  await assertHeader(page, "Office Documents", check, portalHeaderVersion);
  const activeDocuments = page.locator('#app-navigation-vue a[aria-current="page"][title="Documents"]');
  await activeDocuments.waitFor({ state: "visible", timeout: 45_000 });
  const resultHeading = page.locator("#files-section-heading");
  await resultHeading.waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForFunction(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return ![...document.querySelectorAll('.icon-loading, .loading, [class*="loading-icon"], [role="progressbar"]')]
      .some(visible);
  }, null, { timeout: 45_000 });
  const officeContent = page.locator("#app-content-vue");
  contract("Office Documents active section and result list usable",
    await activeDocuments.isVisible() && await resultHeading.isVisible() && await officeContent.isVisible());

  const transition = timeline.slice(timelineStart);
  const surfaces = surfaceTimeline.slice(surfaceStart);
  const officeCommits = transition.filter((item) => {
    if (item.event !== "committed") return false;
    try {
      const url = new URL(item.url);
      return url.hostname === `nextcloud.${domain}` && url.pathname.startsWith("/apps/office/");
    } catch {
      return false;
    }
  });
  const officeResponses = transition.filter((item) => {
    if (item.event !== "document-response" || item.status !== 200) return false;
    try {
      const url = new URL(item.url);
      return url.hostname === `nextcloud.${domain}` && url.pathname === "/apps/office/";
    } catch {
      return false;
    }
  });
  const nextcloudSurfaces = surfaces.filter((item) => {
    try { return new URL(item.document).hostname === `nextcloud.${domain}`; } catch { return false; }
  });
  const forbiddenSurfaces = new Set([
    "unbranded pending shell",
    "native/headerless top strip",
    "Nextcloud native login",
    "Nextcloud stale login state",
    "No office suite is deployed",
    "Office load error",
  ]);

  contract("Office Documents exact deep link requested", (rawDocumentRequests.get(page) || []).some(
    (url) => sameDeepLink(url, href, portalUrl)));
  contract("Office Documents final route is exact and stable", page.url() === `https://nextcloud.${domain}/apps/office/documents`);
  // Do not cap redirect responses: user_oidc intentionally self-redirects once
  // while probing SameSite cookie support. Only extra destination documents or
  // same-document URL churn represent avoidable user-visible transitions.
  contract("Office renders one successful destination document", officeResponses.length === 1, `count=${officeResponses.length}`);
  contract("Office performs at most one route canonicalization without hash churn",
    officeCommits.length <= 2 && officeCommits.every((item) => !new URL(item.url).hash),
    `commits=${officeCommits.length}`);
  contract("Office never paints native login, error, or unbranded shell surfaces",
    !nextcloudSurfaces.some((item) => forbiddenSurfaces.has(item.name))
      && !surfaces.some((item) => item.name === "native/provider login"),
    nextcloudSurfaces.map((item) => item.name).join(","));
  contract("Office never paints the wrong section",
    !nextcloudSurfaces.some((item) => item.name.startsWith("Office active section:")
      && item.name !== "Office active section: Documents"));
}

const chat = {
  label: "Chat",
  hostname: `element.${domain}`,
  roomLabels: ["Jane Doe", "Team", `#welkom:matrix.${domain}`],
  room(page) {
    // The daily demo seed guarantees this direct room and the authenticated
    // failure evidence confirms it is visible in Element's sidebar.
    return page.getByText("Jane Doe", { exact: true }).first();
  },
  composer: (page) => page.locator('[contenteditable="true"][role="textbox"], textarea').first(),
  async interact(page) {
    const room = this.room(page);
    await room.waitFor({ state: "visible", timeout: 45_000 });
    await room.click();
    await this.composer(page).waitFor({ state: "visible", timeout: 30_000 });
    const editable = await this.composer(page).isEditable().catch(() => false);
    if (!editable) throw new Error("Chat composer is not editable");
  },
  async ready(page) {
    await page.getByText("Send a Direct Message", { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
    await this.room(page).waitFor({ state: "visible", timeout: 45_000 });
    const bodyText = await page.locator("body").innerText();
    const visibleRoomLabels = [];
    for (const label of this.roomLabels) {
      if (await page.getByText(label, { exact: true }).first().isVisible().catch(() => false)) visibleRoomLabels.push(label);
    }
    const marker = assessElementHome({ bodyText, visibleRoomLabels });
    if (!marker.ok) throw new Error("authenticated Element home marker not satisfied");
  },
};
const calendar = {
  label: "Calendar",
  hostname: `nextcloud.${domain}`,
  today: (page) => page.getByRole("button", { name: /^Today$/i }).first(),
  async interact(page) {
    await this.today(page).waitFor({ state: "visible", timeout: 45_000 });
    await this.today(page).click();
  },
  async ready(page) { await this.today(page).waitFor({ state: "visible", timeout: 45_000 }); },
};

try {
  await journey("fresh-login-portal", async () => {});
  if (authenticatedState) {
    await journey("portal-chat", (state) => sameTab(state, "Chat", chat));
    await journey("portal-office-documents", officeDocuments);
    await journey("portal-calendar", (state) => sameTab(state, "Calendar", calendar));

    for (const kind of ["whiteboard", "office"]) {
      await journey(`portal-files-${kind}`, async ({ page, rawDocumentRequests, portalHeaderVersion, check, contract, setMissing, setPopup }) => {
        const fixture = kind === "whiteboard" ? process.env.SMOKE_WHITEBOARD_FILE : process.env.SMOKE_OFFICE_FILE;
        const widget = page.locator(".dashboard-item").filter({ has: page.getByRole("link", { name: "Files", exact: true }) }).first();
        const links = widget.locator('a[target="_blank"]');
        const names = (await links.allTextContents()).map((name) => name.trim()).filter(Boolean);
        const candidate = chooseCandidate(names, fixture, kind);
        if (!candidate) {
          setMissing();
          contract(`${kind} fixture/candidate exists`, false);
          return;
        }
        const target = links.getByText(candidate, { exact: true });
        const href = await target.getAttribute("href");
        if (!href) throw new Error(`${kind} candidate has no deep link`);
        const [popup] = await Promise.all([page.waitForEvent("popup"), target.click()]);
        setPopup(popup);
        popup.setDefaultTimeout(15_000);
        popup.setDefaultNavigationTimeout(30_000);
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        await popup.waitForURL((url) => url.hostname === `nextcloud.${domain}`, { timeout: 30_000 });
        check(`${kind} final host`, new URL(popup.url()).hostname === `nextcloud.${domain}`);
        contract("popup exact deep link requested", (rawDocumentRequests.get(popup) || []).some((url) => sameDeepLink(url, href, portalUrl)));
        await assertHeader(popup, kind === "whiteboard" ? "Whiteboard" : "Office editor", check, portalHeaderVersion);
        check("source Portal remains authenticated dashboard", await page.locator(".dashboard-grid").isVisible());

        if (kind === "whiteboard") {
          const marker = popup.locator("canvas, [class*='whiteboard'][class*='toolbar'], [data-testid*='canvas']").first();
          const visible = await marker.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
          contract("whiteboard canvas/tool marker usable", visible);
        } else {
          let editor;
          for (let attempt = 0; attempt < 15 && !editor; attempt += 1) {
            editor = popup.frames().find((frame) => frame.url().includes("cool.html"));
            if (!editor) await popup.waitForTimeout(2_000);
          }
          const file = editor?.getByText("File", { exact: true }).first();
          const insert = editor?.getByText("Insert", { exact: true }).first();
          const [fileReady, insertReady] = await Promise.all([
            file?.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false),
            insert?.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false),
          ]);
          const usable = Boolean(editor && fileReady && insertReady);
          if (usable) {
            await file.click();
            await popup.keyboard.press("Escape");
          }
          check("Collabora File/Insert interaction marker usable", usable);
        }

        const filesListVisible = await popup.locator("#app-content-files, .files-list, [data-testid='files-list']").first().isVisible().catch(() => false);
        contract("editor shown instead of Files list", !filesListVisible);
        const beforeBackUrl = popup.url();
        await popup.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
        const backUrl = popup.url();
        let historyOutcome = "no-popup-history-source-preserved";
        if (backUrl !== beforeBackUrl) {
          await popup.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
          const restored = await popup.waitForURL((url) => url.toString() === beforeBackUrl, { timeout: 30_000 }).then(() => true, () => false);
          historyOutcome = restored ? "popup-forward-restored" : "popup-forward-unavailable";
        }
        const historyContract = contract("Back/Forward outcome preserves source or restores popup", historyOutcome !== "popup-forward-unavailable" && await page.locator(".dashboard-grid").isVisible());
        historyContract.detail = historyOutcome;
      });
    }
  }
} finally {
  await browser.close();
}

await writeFile(path.join(root, "report.json"), JSON.stringify({ schema: 1, mode, reports }, null, 2));
const budget = await enforceArtifactBudget(root, maxArtifactBytes);
for (const report of reports) console.log(`${report.outcome.failed ? "FAIL" : "INFO"} ${report.name}: ${report.outcome.classification}`);
if (budget.removed.length) console.log(`INFO artifact budget removed ${budget.removed.length} capture(s)`);
if (reports.some((report) => report.outcome.failed)) process.exitCode = 1;
