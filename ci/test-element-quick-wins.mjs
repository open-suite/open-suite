import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
const corsPatch = read("patches/local/synapse-cors-preflight-cache.patch");
const dockerfile = read("images/element/Dockerfile");
const overlay = read("overlays/portal-header/opensuite-header.js");

assert.match(corsPatch, /Access-Control-Max-Age: \"600\"/);
assert.match(corsPatch, /customResponseHeaders:/);
assert.match(corsPatch, /matrix-cors-preflight-cache@kubernetescrd/);
assert.doesNotMatch(corsPatch, /^\+\s*(accessControl|Access-Control-Allow)/m);
assert.equal(
  corsPatch.match(/^\+\s*Access-Control-Max-Age:/gm)?.length,
  1,
  "the ingress patch must add exactly one bounded preflight-cache header",
);

for (const fragment of [
  "COPY patch-cache-headers.sh /tmp/patch-cache-headers.sh",
  "&& sh /tmp/patch-cache-headers.sh /tmp/default.conf.template",
]) {
  assert.equal(
    dockerfile.split(fragment).length - 1,
    1,
    `expected exactly one image cache-header step: ${fragment}`,
  );
}
for (const fragment of [
  "html.ko-on-element .mx_ToastContainer{position:fixed !important;left:auto !important;right:16px !important;",
  'top:calc(var(" + HEADER_HEIGHT_VAR + ") + 12px) !important;}',
  'top:calc(var(" + HEADER_HEIGHT_VAR + ") + 76px) !important;',
]) {
  assert.ok(overlay.includes(fragment), `missing Element toast placement rule: ${fragment}`);
}

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "element-cache-headers-"));
try {
  const fixture = path.join(fixtureDirectory, "default.conf.template");
  fs.writeFileSync(
    fixture,
    `server {
    location = /index.html {
        add_header Cache-Control "no-cache";
    }
    location /config {
        add_header Cache-Control "no-cache";
    }
    # redirect server error pages to the static page /50x.html
    error_page 500 /50x.html;
}
`,
  );
  execFileSync("sh", [path.join(repoRoot, "images/element/patch-cache-headers.sh"), fixture]);
  const patched = fs.readFileSync(fixture, "utf8");
  assert.match(
    patched,
    /location ~ "\^\/bundles\/\[0-9A-Fa-f\]\{16,\}\(-os\[0-9a-f\]\{10\}\)\?\/"/,
  );
  assert.match(patched, /Cache-Control "public, max-age=31536000, immutable"/);
  assert.equal(patched.match(/Cache-Control "no-cache"/g)?.length, 2);
  assert.doesNotMatch(patched, /location[^\n]*(config|index|service-worker)[^\n]*\n[^}]*immutable/);
  const fingerprintedBundle = /^\/bundles\/[0-9A-Fa-f]{16,}(-os[0-9a-f]{10})?\//;
  for (const accepted of [
    "/bundles/551980ded8b2e300e6f2/element-web-app.js",
    "/bundles/551980ded8b2e300e6f2-osb42ee34d47/element-web-app.js",
  ]) {
    assert.match(accepted, fingerprintedBundle);
  }
  for (const rejected of [
    "/bundles/551980de/element-web-app.js",
    "/bundles/551980ded8b2e300e6f2-latest/element-web-app.js",
    "/config.json",
    "/service-worker.js",
  ]) {
    assert.doesNotMatch(rejected, fingerprintedBundle);
  }
} finally {
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
}

if (process.argv[2] === "--verify-infra") {
  const infra = path.resolve(process.argv[3] ?? "");
  const middleware = fs.readFileSync(
    path.join(
      infra,
      "helmfile/apps/element/charts/synapse/templates/cors-preflight-cache-middleware.yaml",
    ),
    "utf8",
  );
  const values = fs.readFileSync(
    path.join(infra, "helmfile/apps/element/values-synapse.yaml.gotmpl"),
    "utf8",
  );
  assert.match(middleware, /customResponseHeaders:[\s\S]*Access-Control-Max-Age: "600"/);
  assert.doesNotMatch(middleware, /accessControlAllow(Origins|Methods|Headers)/);
  assert.match(
    values,
    /hsts-header@kubernetescrd,\{\{ \.Release\.Namespace \}\}-matrix-cors-preflight-cache@kubernetescrd/,
  );
  console.log("render-source Matrix preflight middleware contract verified");
}

if (process.argv[2] === "--verify-rendered") {
  const rendered = fs.readFileSync(path.resolve(process.argv[3] ?? ""), "utf8");
  assert.equal(
    rendered.match(/^kind: Middleware$/gm)?.length,
    1,
    "expected exactly one rendered Synapse middleware",
  );
  assert.equal(
    rendered.match(/^  name: matrix-cors-preflight-cache$/gm)?.length,
    1,
    "expected exactly one rendered preflight-cache middleware name",
  );
  assert.match(rendered, /customResponseHeaders:[\s\S]*Access-Control-Max-Age: "600"/);
  assert.doesNotMatch(rendered, /accessControlAllow(Origins|Methods|Headers)/);
  console.log("rendered Matrix preflight middleware verified");
}

if (process.argv[2] === "--layout") {
  const playwrightPath = path.join(repoRoot, "performance/node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(playwrightPath));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [
      { width: 1280, height: 720, name: "desktop" },
      { width: 390, height: 720, name: "narrow" },
    ]) {
      const page = await browser.newPage({ viewport });
      await page.setContent(`<!doctype html>
        <html class="ko-on-element"><head><style>
          html,body{margin:0;width:100%;height:100%}
          #matrixchat{position:relative;width:100%;height:100vh}
          #room-list-search-button{position:absolute;left:clamp(20px,6.33vw,81px);top:13.5px;
            width:min(302px,90vw);height:36px}
          .mx_ToastContainer{position:absolute;z-index:101;left:62px;top:12px;
            width:236px;height:148px;background:#fff}
        </style></head><body><div class="mx_MatrixChat_wrapper">
          <aside class="mx_ToastContainer">Notifications</aside>
          <main class="mx_MatrixChat" id="matrixchat">
            <button id="room-list-search-button">Search rooms</button>
          </main>
        </div></body></html>`);
      await page.addScriptTag({ content: overlay });
      const geometry = await page.evaluate(() => {
        const search = document.querySelector("#room-list-search-button");
        const toast = document.querySelector(".mx_ToastContainer");
        const searchBox = search.getBoundingClientRect();
        const toastBox = toast.getBoundingClientRect();
        const overlap = !(
          searchBox.right <= toastBox.left ||
          toastBox.right <= searchBox.left ||
          searchBox.bottom <= toastBox.top ||
          toastBox.bottom <= searchBox.top
        );
        const hit = document.elementFromPoint(
          searchBox.left + searchBox.width / 2,
          searchBox.top + searchBox.height / 2,
        );
        return {
          overlap,
          search: searchBox.toJSON(),
          toast: toastBox.toJSON(),
          toastClearsHeader: toastBox.top >= 48,
          searchReceivesPointer: hit === search,
        };
      });
      assert.equal(geometry.overlap, false, `${viewport.name}: toast overlaps room search`);
      assert.equal(geometry.toastClearsHeader, true, `${viewport.name}: toast overlaps suite header`);
      assert.equal(
        geometry.searchReceivesPointer,
        true,
        `${viewport.name}: room search does not receive pointer input`,
      );
      console.log(`${viewport.name} ${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

console.log("Element browser quick-win contracts verified");
