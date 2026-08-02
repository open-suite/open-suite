import assert from "node:assert/strict";
import { createRequire } from "node:module";

const baseUrl = new URL(process.env.NEXTCLOUD_URL || "http://127.0.0.1:18080");
const moduleRoot = process.env.PLAYWRIGHT_MODULE_ROOT;
if (!moduleRoot) throw new Error("PLAYWRIGHT_MODULE_ROOT is required");
const require = createRequire(`${moduleRoot}/package.json`);
const { chromium } = require("playwright");
const fileName = `opensuite-template-picker-${Date.now()}.docx`;
const chunkRequest = (request) => {
  const url = new URL(request.url());
  return url.origin === baseUrl.origin
    && url.pathname === "/dist/7497-7497.js"
    && url.searchParams.get("v") === "94a5bd32402d33b444dc";
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let release;
let createPosts = 0;
const distRequests = [];
const diagnosticErrors = [];
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith("/dist/")) distRequests.push(`${url.pathname}${url.search}`);
  if (request.method() === "POST"
      && url.pathname === "/ocs/v2.php/apps/files/api/v1/templates/create") createPosts += 1;
});
page.on("pageerror", (error) => diagnosticErrors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") diagnosticErrors.push(`console: ${message.text()}`);
});

async function login() {
  await page.goto(new URL("/login", baseUrl).href);
  if (await page.locator("#user").isVisible().catch(() => false)) {
    await page.locator("#user").fill(process.env.NEXTCLOUD_ADMIN_USER);
    const password = page.locator("#password");
    await password.fill(process.env.NEXTCLOUD_ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => url.pathname !== "/login", { timeout: 30_000 }),
      password.press("Enter"),
    ]);
  }
}

async function openFiles() {
  await page.goto(new URL("/apps/files/files", baseUrl).href, { waitUntil: "domcontentloaded" });
  await page.locator("#app-content-files, .files-list, [data-testid='files-list']").first()
    .waitFor({ state: "visible", timeout: 45_000 });
}

async function initiateDocument() {
  await page.getByRole("button", { name: "New", exact: true }).click();
  const menuItems = page.locator('[role="menuitem"]:visible');
  const documentItem = menuItems.filter({ hasText: /^\s*Document\s*$/ });
  await documentItem.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await documentItem.count(), 1, `New menu=${JSON.stringify(await menuItems.evaluateAll((items) => items.map((item) => ({
    text: item.textContent?.trim(),
    tag: item.tagName.toLowerCase(),
    role: item.getAttribute("role"),
    id: item.id,
    attributes: Object.fromEntries(Array.from(item.attributes, ({ name, value }) => [name, value])),
  }))))}`);
  console.log(`initiating Office action=${JSON.stringify(await documentItem.evaluate((item) => {
    const ancestors = [];
    let parent = item.parentElement;
    for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
      ancestors.push({ tag: parent.tagName.toLowerCase(), role: parent.getAttribute("role"), class: parent.className });
    }
    return {
      text: item.textContent?.trim(),
      tag: item.tagName.toLowerCase(),
      role: item.getAttribute("role"),
      id: item.id,
      attributes: Object.fromEntries(Array.from(item.attributes, ({ name, value }) => [name, value])),
      ancestors,
    };
  }))}; visible New menu=${JSON.stringify(await menuItems.allTextContents())}`);
  distRequests.length = 0;
  await documentItem.click();
}

async function waitForExactChunk(requestPromise) {
  try {
    return await requestPromise;
  } catch (error) {
    const menuItems = await page.locator('[role="menuitem"], .v-popper__popper button, .v-popper__popper li')
      .evaluateAll((items) => items.map((item) => ({
        text: item.textContent?.trim(),
        tag: item.tagName.toLowerCase(),
        role: item.getAttribute("role"),
        id: item.id,
        attributes: Object.fromEntries(Array.from(item.attributes, ({ name, value }) => [name, value])),
      })));
    const dialogVisible = await page.locator("[data-cy-files-new-node-dialog]").first()
      .isVisible().catch(() => false);
    throw new Error(`exact TemplatePicker chunk was not requested; dialogVisible=${dialogVisible}; New menu=${JSON.stringify(menuItems)}; observed dist requests=${JSON.stringify(distRequests)}; errors=${JSON.stringify(diagnosticErrors)}`, { cause: error });
  }
}

async function dav(method) {
  return page.evaluate(async ({ method, fileName }) => {
    const uid = OC.getCurrentUser().uid;
    const response = await fetch(`/remote.php/dav/files/${encodeURIComponent(uid)}/${encodeURIComponent(fileName)}`, {
      method,
      headers: { requesttoken: OC.requestToken },
    });
    return {
      status: response.status,
      type: response.headers.get("content-type")?.split(";", 1)[0] || "",
      length: Number.parseInt(response.headers.get("content-length") || "0", 10),
    };
  }, { method, fileName });
}

try {
  await login();
  const templateDirectory = await page.evaluate(async () => {
    const response = await fetch("/ocs/v2.php/apps/files/api/v1/templates/path?format=json", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
        requesttoken: OC.requestToken,
      },
      body: JSON.stringify({
        templatePath: "IntegrationTemplates",
        copySystemTemplates: false,
      }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(templateDirectory.status, 200,
    `template directory response=${JSON.stringify(templateDirectory.body)}`);
  assert.deepEqual(templateDirectory.body.ocs.meta, {
    status: "ok",
    statuscode: 200,
    message: "OK",
  });
  assert.equal(templateDirectory.body.ocs.data.template_path, "IntegrationTemplates");
  assert.ok(Array.isArray(templateDirectory.body.ocs.data.templates));
  await openFiles();
  assert.equal((await dav("HEAD")).status, 404);
  const providers = await page.evaluate(() => OCP.InitialState.loadState("files", "templates", []));
  const documents = providers.filter((provider) => provider.app === "richdocuments"
    && provider.label === "Document" && provider.extension === ".docx");
  assert.equal(documents.length, 1, `template providers=${JSON.stringify(providers)}`);
  assert.deepEqual(templateDirectory.body.ocs.data.templates, providers);
  const templates = await page.evaluate(async () => {
    const response = await fetch("/ocs/v2.php/apps/files/api/v1/templates?format=json", {
      headers: { "OCS-APIRequest": "true", requesttoken: OC.requestToken },
    });
    if (!response.ok) throw new Error(`template fixture request failed: ${response.status}`);
    return (await response.json()).ocs.data;
  });
  const documentTemplates = templates.find((provider) => provider.app === "richdocuments"
    && provider.label === "Document");
  assert.deepEqual(documentTemplates?.templates.map((template) => template.basename).sort(), [
    "Calendar.odt",
    "Certificate.odt",
    "Invoice.odt",
    "Letter.odt",
    "Menu.odt",
    "Mother's day.odt",
    "Party invitation.odt",
    "Photo book.odt",
    "Report.odt",
    "Resume.odt",
    "Syllabus.odt",
  ]);
  assert.ok(documentTemplates.templates.every((template) =>
    template.templateType === "OCA\\Richdocuments\\Template\\CollaboraTemplateProvider"
      && template.mime === "application/vnd.oasis.opendocument.text"
      && template.size > 0));
  assert.equal(new Set(documentTemplates.templates.map((template) => template.templateId)).size,
    documentTemplates.templates.length);

  let aborted = 0;
  let finishAbort;
  const abortFinished = new Promise((resolve) => { finishAbort = resolve; });
  await page.route("**/dist/7497-7497.js*", async (route) => {
    assert.equal(chunkRequest(route.request()), true);
    aborted += 1;
    try {
      await route.abort("failed");
    } finally {
      finishAbort();
    }
  });
  const exactAbortedChunk = waitForExactChunk(page.waitForRequest(chunkRequest, { timeout: 30_000 }));
  const [, abortedChunkRequest] = await Promise.all([initiateDocument(), exactAbortedChunk]);
  assert.equal(chunkRequest(abortedChunkRequest), true,
    `observed dist requests=${JSON.stringify(distRequests)}`);
  await abortFinished;
  assert.equal(aborted, 1);
  assert.equal(createPosts, 0);
  assert.equal((await dav("HEAD")).status, 404);

  await page.unrouteAll({ behavior: "wait" });
  await page.reload({ waitUntil: "domcontentloaded" });
  let finishContinuation;
  let intercepted = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const continued = new Promise((resolve) => { finishContinuation = resolve; });
  await page.route("**/dist/7497-7497.js*", async (route) => {
    assert.equal(chunkRequest(route.request()), true);
    intercepted += 1;
    try {
      await held;
      await route.continue();
    } finally {
      finishContinuation();
    }
  });
  const exactChunk = waitForExactChunk(page.waitForRequest(chunkRequest, { timeout: 30_000 }));
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await Promise.all([initiateDocument(), exactChunk]);
  assert.equal(intercepted, 1);
  assert.deepEqual(pageErrors, []);
  const dialog = page.locator("[data-cy-files-new-node-dialog]").first();
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await dialog.getByRole("textbox", { name: /name/i }).fill(fileName.slice(0, -5));
  const createdResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST"
      && url.pathname === "/ocs/v2.php/apps/files/api/v1/templates/create";
  }, { timeout: 30_000 });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  release();
  await continued;
  await page.unrouteAll({ behavior: "wait" });
  const blankTemplate = page.locator("#template-picker--1");
  await blankTemplate.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await blankTemplate.isChecked(), true);
  await page.getByRole("button", { name: "Create a new file with the selected template" }).click();
  assert.equal((await createdResponse).status(), 200);
  const created = await dav("HEAD");
  assert.deepEqual({ status: created.status, type: created.type }, {
    status: 200,
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  assert.ok(created.length > 0);
  assert.equal(createPosts, 1);
  assert.deepEqual(pageErrors, []);
  assert.equal((await dav("DELETE")).status, 204);
  assert.equal((await dav("HEAD")).status, 404);
  console.log("candidate image held/aborted TemplatePicker chunk browser contracts verified");
} finally {
  release?.();
  await browser.close();
}
