// Focused visual-transition gate for the live assembled stack. Evidence is
// intentionally top-level and sanitized: never emit credentials, cookies,
// storage state, response bodies, or URL query values.
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  assessElementHome,
  chooseCandidate,
  contractOutcome,
  durableNextcloudFile,
  enforceArtifactBudget,
  officeLifecycleFixtureName,
  parseMode,
  sameDeepLink,
  sanitizeDiagnostic,
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

async function journey(name, action, { metadataOnly = false, beforePortal, cleanup } = {}) {
  const dir = path.join(root, safeName(name));
  await mkdir(dir, { recursive: true });
  const timeline = [];
  const layoutShifts = [];
  const headerTimeline = [];
  const surfaceTimeline = [];
  const runtimeErrors = [];
  const rawDocumentRequests = new WeakMap();
  const pageLabels = new WeakMap();
  let popupPage;
  let context;
  let page;
  const observations = [];
  const blocking = [];
  let exists = true;
  let portalHeaderVersion;
  const check = (label, ok, hard = true, detail = "") => observations.push({ label, ok: Boolean(ok), hard, detail });
  const contract = (label, ok, detail = "") => {
    const item = { label, ok: Boolean(ok), detail };
    blocking.push(item);
    return item;
  };

  try {
    const recordsVideo = Boolean(authenticatedState) && !metadataOnly;
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
      window.__osOfficeLifecycle = [];
      window.addEventListener("message", (event) => {
        const fromActiveCollabora = [...document.querySelectorAll('iframe[data-cy="coolframe"], #loleafletframe')]
          .some((frame) => frame.contentWindow === event.source);
        if (!fromActiveCollabora) return;
        let data = event.data;
        try {
          if (typeof data === "string") data = JSON.parse(data);
        } catch {
          return;
        }
        if (data?.MessageId === "App_LoadingStatus" && data?.Values?.Status) {
          window.__osOfficeLifecycle.push({
            at: performance.now(),
            messageId: data.MessageId,
            status: data.Values.Status,
          });
          if (data.Values.Status === "Document_Loaded") {
            const count = Number.parseInt(document.documentElement.dataset.osOfficeDocumentLoadedCount || "0", 10) + 1;
            document.documentElement.dataset.osOfficeDocumentLoadedCount = String(count);
            document.documentElement.setAttribute(`data-os-office-document-loaded-${count}`, "");
          }
        }
      });
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
      if (!request.isNavigationRequest()) return;
      let frame;
      try {
        frame = request.frame();
      } catch {
        timeline.push({ page: "popup-pending", event: "document-request", url: sanitizeUrl(request.url()) });
        return;
      }
      if (frame !== frame.page().mainFrame()) return;
      const sourcePage = frame.page();
      const requests = rawDocumentRequests.get(sourcePage) || [];
      requests.push(request.url());
      rawDocumentRequests.set(sourcePage, requests);
      timeline.push({ page: pageLabels.get(sourcePage) || "top", event: "document-request", url: sanitizeUrl(request.url()) });
    });
    context.on("response", (response) => {
      const request = response.request();
      if (!request.isNavigationRequest()) return;
      let frame;
      try {
        frame = request.frame();
      } catch {
        timeline.push({
          page: "popup-pending",
          event: "document-response",
          status: response.status(),
          redirected: Boolean(request.redirectedFrom()),
          url: sanitizeUrl(response.url()),
        });
        return;
      }
      if (frame !== frame.page().mainFrame()) return;
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
      candidate.on("pageerror", (error) => {
        runtimeErrors.push({
          page: pageLabels.get(candidate) || "top",
          type: "pageerror",
          name: error.name || "Error",
          message: sanitizeDiagnostic(error.message, [user, pass]),
        });
      });
      candidate.on("console", (message) => {
        if (message.type() !== "error") return;
        runtimeErrors.push({
          page: pageLabels.get(candidate) || "top",
          type: "console",
          message: sanitizeDiagnostic(message.text(), [user, pass]),
        });
      });
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

    if (beforePortal) await beforePortal({ page, context, check, contract });

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
    portalHeaderVersion = await assertHeader(page, "Portal", check);
    if (!authenticatedState) authenticatedState = await context.storageState();

    await action({
      page,
      context,
      rawDocumentRequests,
      portalHeaderVersion,
      timeline,
      headerTimeline,
      surfaceTimeline,
      runtimeErrors,
      check,
      contract,
      setMissing: () => { exists = false; },
      setPopup: (candidate) => { popupPage = candidate; pageLabels.set(candidate, "popup"); },
    });

    contract("Connecting to chat never visible", !surfaceTimeline.some((item) => item.name === "Connecting to chat"));
    contract("native/headerless top strip never visible", !surfaceTimeline.some((item) => item.name === "native/headerless top strip"));
    contract("header is never removed after insertion", !headerTimeline.some((item) => item.event === "removed"));
  } catch (error) {
    // Playwright errors can embed navigation URLs or application diagnostics.
    // Persist only the bounded, credential- and capability-redacted message.
    check("journey completed", false, true,
      `${error?.name || "Error"}: ${sanitizeDiagnostic(error?.message, [user, pass])}`);
  }

  if (cleanup && context && page) {
    try {
      await cleanup({ page, context, check, contract });
    } catch (error) {
      check("journey cleanup completed", false, true,
        `${error?.name || "Error"}: ${sanitizeDiagnostic(error?.message, [user, pass])}`);
    }
  }

  const outcome = contractOutcome({ mode, exists, observations, blocking });
  if (outcome.failed && context) {
    // Before authenticatedState exists, a failed Keycloak form can still hold
    // credentials. Never persist pixels from that context.
    if (authenticatedState && !metadataOnly) {
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
      runtimeErrors,
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
    runtimeErrors,
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
      return url.hostname === `nextcloud.${domain}`
        && (url.pathname === "/apps/office/" || url.pathname === "/apps/office/documents");
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

function isExpandedFilesRoute(value, fileId) {
  try {
    const url = new URL(value);
    return url.origin === `https://nextcloud.${domain}`
      && url.pathname === `/apps/files/files/${fileId}`;
  } catch {
    return false;
  }
}

async function waitForCollaboraFrame(page) {
  return page.frames().find((frame) => frame.parentFrame() === page.mainFrame() && frame.url().includes("/cool.html"))
    ?? page.waitForEvent("framenavigated", {
      predicate: (frame) => frame.parentFrame() === page.mainFrame() && frame.url().includes("/cool.html"),
      timeout: 45_000,
    });
}

async function documentLoadedCount(page) {
  return Number.parseInt(await page.locator("html").getAttribute("data-os-office-document-loaded-count") || "0", 10);
}

async function waitForDocumentLoaded(page, previousCount = 0) {
  await page.locator(`html[data-os-office-document-loaded-${previousCount + 1}]`)
    .waitFor({ state: "attached", timeout: 45_000 });
}

async function assertOfficeHeaderGeometry(page, label, portalHeaderVersion, check, contract) {
  await assertHeader(page, label, check, portalHeaderVersion);
  const header = await page.locator("#ko-portal-header").boundingBox();
  const editor = await page.locator(".office-viewer:not(.widget-file)").last().boundingBox();
  const viewport = page.viewportSize();
  const near = (left, right) => Math.abs(left - right) <= 2;
  contract(`${label} starts below shared header and fills remaining viewport`, Boolean(
    header && editor && viewport
      && near(header.x, 0)
      && near(header.y, 0)
      && near(header.width, viewport.width)
      && near(editor.x, 0)
      && near(editor.y, header.y + header.height)
      && near(editor.width, viewport.width)
      && near(editor.y + editor.height, viewport.height)
  ), `header=${JSON.stringify(header)},editor=${JSON.stringify(editor)}`);
}

async function invokeFirstInsertImage(page, editor, label, contract) {
  await editor.locator("#menu-insert > a").click({ timeout: 30_000 });
  await editor.locator("#menu-insertgraphicremote > a").click();
  const picker = page.getByRole("dialog").filter({ hasText: "Insert file from Open Suite" }).last();
  await picker.waitFor({ state: "visible", timeout: 15_000 });
  contract(`${label} first Insert Image click opens picker`, true);
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });
}

async function closeOfficeToFiles(page, editor, fileId, label, portalHeaderVersion, check, contract) {
  const frame = page.locator('iframe[data-cy="coolframe"], #loleafletframe');
  await editor.locator("#closebutton").click();
  await frame.waitFor({ state: "detached", timeout: 30_000 });
  const files = page.locator("#app-content-files, .files-list, [data-testid='files-list']").first();
  await files.waitFor({ state: "visible", timeout: 30_000 });
  await assertHeader(page, `${label} closed Files view`, check, portalHeaderVersion);
  const url = new URL(page.url());
  contract(`${label} close returns to exact Files view`,
    isExpandedFilesRoute(url, fileId) && !url.searchParams.has("openfile"));
  contract(`${label} close removes Collabora frame`,
    !page.frames().some((candidate) => candidate.url().includes("/cool.html")));
}

async function openNextcloudFiles(page) {
  await page.goto(`https://nextcloud.${domain}/apps/files/files`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.origin === `https://nextcloud.${domain}`
    && url.pathname.startsWith("/apps/files/"), { timeout: 45_000 });
  await page.locator("#app-content-files, .files-list, [data-testid='files-list']").first()
    .waitFor({ state: "visible", timeout: 45_000 });
}

async function createOfficeLifecycleFixture({ page, check }, fixture) {
  await openNextcloudFiles(page);
  const absentStatus = await page.evaluate(async (fileName) => {
    const uid = OC.getCurrentUser().uid;
    const response = await fetch(
      `/remote.php/dav/files/${encodeURIComponent(uid)}/${encodeURIComponent(fileName)}`,
      { method: "HEAD", headers: { requesttoken: OC.requestToken } },
    );
    return response.status;
  }, fixture.name);
  check("unique DOCX fixture path is unused", absentStatus === 404, true, `status=${absentStatus}`);
  if (absentStatus !== 404) throw new Error("refusing to replace an existing DOCX fixture path");

  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.locator('[role="menuitem"], .v-popper__popper button, .v-popper__popper li')
    .filter({ hasText: /^\s*Document\s*$/ }).first().click();
  const dialog = page.locator("[data-cy-files-new-node-dialog]").first();
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("textbox", { name: /name/i }).fill(fixture.name.slice(0, -".docx".length));
  fixture.cleanupRequired = true;
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  const editor = await waitForCollaboraFrame(page);
  await waitForDocumentLoaded(page);
  const created = await page.evaluate(async (fileName) => {
    const uid = OC.getCurrentUser().uid;
    const response = await fetch(
      `/remote.php/dav/files/${encodeURIComponent(uid)}/${encodeURIComponent(fileName)}`,
      { method: "HEAD", headers: { requesttoken: OC.requestToken } },
    );
    return {
      status: response.status,
      contentType: response.headers.get("content-type")?.split(";", 1)[0] || "",
      length: Number.parseInt(response.headers.get("content-length") || "0", 10),
    };
  }, fixture.name);
  const valid = created.status === 200
    && created.contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    && created.length > 0;
  check("supported UI creates an ordinary valid DOCX fixture", valid, true,
    `status=${created.status},type=${created.contentType},length=${created.length}`);
  if (!valid) throw new Error("created DOCX fixture failed DAV validation");

  await editor.locator("#closebutton").click();
  await page.locator('iframe[data-cy="coolframe"], #loleafletframe')
    .waitFor({ state: "detached", timeout: 30_000 });
  await page.locator("#app-content-files, .files-list, [data-testid='files-list']").first()
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function cleanupOfficeLifecycleFixture({ page, context, check }, fixture) {
  for (const candidate of context.pages()) {
    if (candidate !== page) await candidate.close().catch(() => {});
  }
  if (!fixture.cleanupRequired) return;

  await openNextcloudFiles(page);
  const cleanup = await page.evaluate(async (fileName) => {
    const uid = OC.getCurrentUser().uid;
    const url = `/remote.php/dav/files/${encodeURIComponent(uid)}/${encodeURIComponent(fileName)}`;
    const headers = { requesttoken: OC.requestToken };
    const before = await fetch(url, { method: "HEAD", headers });
    const deleted = await fetch(url, { method: "DELETE", headers });
    const after = await fetch(url, { method: "HEAD", headers });
    return { before: before.status, deleted: deleted.status, after: after.status };
  }, fixture.name);
  const clean = [200, 404].includes(cleanup.before)
    && [200, 204, 404].includes(cleanup.deleted)
    && cleanup.after === 404;
  check("exact owned DOCX fixture is deleted and absent", clean, true,
    `before=${cleanup.before},delete=${cleanup.deleted},after=${cleanup.after}`);
  if (!clean) throw new Error("exact DOCX fixture cleanup failed");
  fixture.cleanupRequired = false;
}

async function portalFilesOfficeLifecycle({ page, rawDocumentRequests, portalHeaderVersion, timeline, check, contract, setPopup }, fixture) {
  const widget = page.locator(".dashboard-item").filter({ has: page.getByRole("link", { name: "Files", exact: true }) }).first();
  const links = widget.locator('a[target="_blank"]');
  const target = links.getByText(fixture.name, { exact: true });
  await target.waitFor({ state: "visible", timeout: 45_000 });
  contract("Files widget renders the exact owned DOCX activity row", true);
  const href = await target.getAttribute("href");
  const parsedDurable = href && durableNextcloudFile(href, portalUrl);
  const durable = parsedDurable && new URL(parsedDurable.url).origin === `https://nextcloud.${domain}`
    ? parsedDurable
    : null;
  contract("Files widget Office link is an exact durable Nextcloud /f/{id} URL", Boolean(durable));
  // Baseline mode observes the currently deployed portal until its separately
  // owned production change lands. Enforce mode fails the contract above.
  if (!durable) return;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const timelineStart = timeline.length;
    const [popup] = await Promise.all([page.waitForEvent("popup"), target.click()]);
    setPopup(popup);
    popup.setDefaultTimeout(15_000);
    popup.setDefaultNavigationTimeout(45_000);
    await popup.waitForURL((url) => isExpandedFilesRoute(url, durable.fileId), { timeout: 45_000 });
    contract(`Office attempt ${attempt} requests exact durable deep link`,
      (rawDocumentRequests.get(popup) || []).some((url) => sameDeepLink(url, durable.url, portalUrl))
        || timeline.slice(timelineStart).some((item) => item.event === "document-request" && sameDeepLink(item.url, durable.url, portalUrl)));
    contract(`Office attempt ${attempt} never requests directEditing`,
      !(rawDocumentRequests.get(popup) || []).some((url) => /\/apps\/files\/directEditing\//.test(new URL(url).pathname))
        && !timeline.slice(timelineStart).some((item) => item.event === "document-request" && /\/apps\/files\/directEditing\//.test(new URL(item.url).pathname)));
    check(`Office attempt ${attempt} source Portal remains dashboard`, await page.locator(".dashboard-grid").isVisible());

    let editor = await waitForCollaboraFrame(popup);
    await waitForDocumentLoaded(popup);
    await assertOfficeHeaderGeometry(popup, `Office attempt ${attempt}`, portalHeaderVersion, check, contract);

    if (attempt === 1) {
      await invokeFirstInsertImage(popup, editor, "Office attempt 1", contract);
      const routeBeforeReload = sanitizeUrl(popup.url());
      await popup.reload({ waitUntil: "domcontentloaded" });
      await popup.waitForURL((url) => isExpandedFilesRoute(url, durable.fileId), { timeout: 45_000 });
      editor = await waitForCollaboraFrame(popup);
      await waitForDocumentLoaded(popup);
      contract("Office refresh reopens the exact file route", sanitizeUrl(popup.url()) === routeBeforeReload);
      contract("Office refresh does not render not-found",
        !/Page not found|could not be found/i.test(await popup.locator("body").innerText()));
      await assertOfficeHeaderGeometry(popup, "Office refreshed", portalHeaderVersion, check, contract);
    }

    await closeOfficeToFiles(popup, editor, durable.fileId, `Office attempt ${attempt}`, portalHeaderVersion, check, contract);

    if (attempt === 1) {
      const history = [{ state: "closed", url: sanitizeUrl(popup.url()) }];
      const loadedBeforeBack = await documentLoadedCount(popup);
      await popup.goBack({ waitUntil: "commit" });
      editor = await waitForCollaboraFrame(popup);
      await waitForDocumentLoaded(popup, loadedBeforeBack);
      history.push({ state: "back-open", url: sanitizeUrl(popup.url()) });
      contract("Office Back deterministically reopens exact file",
        isExpandedFilesRoute(popup.url(), durable.fileId)
          && new URL(popup.url()).searchParams.has("openfile"));
      await assertOfficeHeaderGeometry(popup, "Office Back", portalHeaderVersion, check, contract);

      await popup.goForward({ waitUntil: "commit" });
      await popup.locator('iframe[data-cy="coolframe"], #loleafletframe').waitFor({ state: "detached", timeout: 30_000 });
      await popup.locator("#app-content-files, .files-list, [data-testid='files-list']").first()
        .waitFor({ state: "visible", timeout: 30_000 });
      history.push({ state: "forward-closed", url: sanitizeUrl(popup.url()) });
      const historyContract = contract("Office Forward deterministically restores closed Files view",
        isExpandedFilesRoute(popup.url(), durable.fileId)
          && !new URL(popup.url()).searchParams.has("openfile")
          && !popup.frames().some((frame) => frame.url().includes("/cool.html")));
      historyContract.detail = JSON.stringify(history);
      await assertHeader(popup, "Office Forward Files view", check, portalHeaderVersion);
    }

    await popup.close();
  }
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
    const officeFixture = {
      name: officeLifecycleFixtureName(Date.now(), randomUUID()),
      cleanupRequired: false,
    };
    await journey(
      "portal-files-office-lifecycle",
      (state) => portalFilesOfficeLifecycle(state, officeFixture),
      {
        metadataOnly: true,
        beforePortal: (state) => createOfficeLifecycleFixture(state, officeFixture),
        cleanup: (state) => cleanupOfficeLifecycleFixture(state, officeFixture),
      },
    );

    await journey("portal-files-whiteboard", async ({ page, rawDocumentRequests, portalHeaderVersion, check, contract, setMissing, setPopup }) => {
        const fixture = process.env.SMOKE_WHITEBOARD_FILE;
        const widget = page.locator(".dashboard-item").filter({ has: page.getByRole("link", { name: "Files", exact: true }) }).first();
        const links = widget.locator('a[target="_blank"]');
        const names = (await links.allTextContents()).map((name) => name.trim()).filter(Boolean);
        const candidate = chooseCandidate(names, fixture, "whiteboard");
        if (!candidate) {
          setMissing();
          contract("whiteboard fixture/candidate exists", false);
          return;
        }
        const target = links.getByText(candidate, { exact: true });
        const href = await target.getAttribute("href");
        if (!href) throw new Error("whiteboard candidate has no deep link");
        const [popup] = await Promise.all([page.waitForEvent("popup"), target.click()]);
        setPopup(popup);
        popup.setDefaultTimeout(15_000);
        popup.setDefaultNavigationTimeout(30_000);
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        await popup.waitForURL((url) => url.hostname === `nextcloud.${domain}`, { timeout: 30_000 });
        check("whiteboard final host", new URL(popup.url()).hostname === `nextcloud.${domain}`);
        contract("popup exact deep link requested", (rawDocumentRequests.get(popup) || []).some((url) => sameDeepLink(url, href, portalUrl)));
        await assertHeader(popup, "Whiteboard", check, portalHeaderVersion);
        check("source Portal remains authenticated dashboard", await page.locator(".dashboard-grid").isVisible());

        const marker = popup.locator("canvas, [class*='whiteboard'][class*='toolbar'], [data-testid*='canvas']").first();
        const visible = await marker.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
        contract("whiteboard canvas/tool marker usable", visible);

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
} finally {
  await browser.close();
}

await writeFile(path.join(root, "report.json"), JSON.stringify({ schema: 1, mode, reports }, null, 2));
const budget = await enforceArtifactBudget(root, maxArtifactBytes);
for (const report of reports) console.log(`${report.outcome.failed ? "FAIL" : "INFO"} ${report.name}: ${report.outcome.classification}`);
if (budget.removed.length) console.log(`INFO artifact budget removed ${budget.removed.length} capture(s)`);
if (reports.some((report) => report.outcome.failed)) process.exitCode = 1;
