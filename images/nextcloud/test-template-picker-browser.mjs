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
    && /^[0-9a-f]+$/.test(url.searchParams.get("v") || "");
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let release;
let createPosts = 0;
page.on("request", (request) => {
  const url = new URL(request.url());
  if (request.method() === "POST"
      && url.pathname === "/ocs/v2.php/apps/files/api/v1/templates/create") createPosts += 1;
});

async function openFiles() {
  await page.goto(new URL("/login", baseUrl).href);
  if (await page.locator("#user").isVisible().catch(() => false)) {
    await page.locator("#user").fill(process.env.NEXTCLOUD_ADMIN_USER);
    await page.locator("#password").fill(process.env.NEXTCLOUD_ADMIN_PASSWORD);
    await page.locator("#submit-form").click();
  }
  await page.goto(new URL("/apps/files/files", baseUrl).href, { waitUntil: "domcontentloaded" });
  await page.locator("#app-content-files, .files-list, [data-testid='files-list']").first()
    .waitFor({ state: "visible", timeout: 45_000 });
}

async function initiateDocument() {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.locator('[role="menuitem"], .v-popper__popper button, .v-popper__popper li')
    .filter({ hasText: /^\s*Document\s*$/ }).first().click();
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

  let aborted = 0;
  await page.route("**/dist/7497-7497.js*", async (route) => {
    assert.equal(chunkRequest(route.request()), true);
    aborted += 1;
    await route.abort("failed");
  });
  const chunkFailure = page.waitForEvent("pageerror", { timeout: 30_000 });
  await initiateDocument();
  assert.match((await chunkFailure).message, /chunk|loading|failed/i);
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
  const exactChunk = page.waitForRequest(chunkRequest, { timeout: 30_000 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await initiateDocument();
  await exactChunk;
  assert.equal(intercepted, 1);
  assert.deepEqual(pageErrors, []);
  release();
  await continued;
  await page.unrouteAll({ behavior: "wait" });

  const dialog = page.locator("[data-cy-files-new-node-dialog]").first();
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await dialog.getByRole("textbox", { name: /name/i }).fill(fileName.slice(0, -5));
  const createdResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST"
      && url.pathname === "/ocs/v2.php/apps/files/api/v1/templates/create";
  }, { timeout: 30_000 });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
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
