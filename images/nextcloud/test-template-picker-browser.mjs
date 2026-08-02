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
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith("/dist/")) distRequests.push(`${url.pathname}${url.search}`);
  if (request.method() === "POST"
      && url.pathname === "/ocs/v2.php/apps/files/api/v1/templates/create") createPosts += 1;
});

async function openFiles() {
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
  await page.goto(new URL("/apps/files/files", baseUrl).href, { waitUntil: "domcontentloaded" });
  await page.locator("#app-content-files, .files-list, [data-testid='files-list']").first()
    .waitFor({ state: "visible", timeout: 45_000 });
}

async function initiateDocument() {
  await page.getByRole("button", { name: "New", exact: true }).click();
  const menuItems = page.locator('[role="menu"]:visible [role="menuitem"]');
  const documentItem = menuItems.getByRole("menuitem", { name: "Document", exact: true });
  assert.equal(await documentItem.count(), 1, `New menu=${JSON.stringify(await menuItems.evaluateAll((items) => items.map((item) => ({
    text: item.textContent?.trim(),
    tag: item.tagName.toLowerCase(),
    role: item.getAttribute("role"),
    id: item.id,
    attributes: Object.fromEntries(Array.from(item.attributes, ({ name, value }) => [name, value])),
  }))))}`);
  console.log(`initiating Office action=${JSON.stringify(await documentItem.evaluate((item) => ({
    text: item.textContent?.trim(),
    tag: item.tagName.toLowerCase(),
    role: item.getAttribute("role"),
    id: item.id,
    attributes: Object.fromEntries(Array.from(item.attributes, ({ name, value }) => [name, value])),
  })))}`);
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
    throw new Error(`exact TemplatePicker chunk was not requested; New menu=${JSON.stringify(menuItems)}; observed dist requests=${JSON.stringify(distRequests)}`, { cause: error });
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
  await openFiles();
  assert.equal((await dav("HEAD")).status, 404);
  const providers = await page.evaluate(() => OCP.InitialState.loadState("files", "templates", []));
  const documents = providers.filter((provider) => provider.app === "richdocuments"
    && provider.label === "Document" && provider.extension === ".docx");
  assert.equal(documents.length, 1, `template providers=${JSON.stringify(providers)}`);

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
