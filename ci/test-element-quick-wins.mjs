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
  'max-height:calc(100dvh - var(" + HEADER_HEIGHT_VAR + ") - 24px) !important;',
  'top:calc(var(" + HEADER_HEIGHT_VAR + ") + 76px) !important;',
  'max-height:calc(100dvh - var(" + HEADER_HEIGHT_VAR + ") - 88px) !important;',
  "box-sizing:border-box;grid-template-rows:auto 28px 8px !important;overflow-y:auto;",
  "html.ko-on-element .mx_Toast_buttons,html.ko-on-element .mx_IncomingCallToast_buttons,",
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

if (process.argv[2] === "--verify-rendered") {
  const rendered = fs.readFileSync(path.resolve(process.argv[3] ?? ""), "utf8");
  const documents = rendered.split(/^---\s*$/m);
  const object = (kind, name) => {
    const matches = documents.filter((document) => new RegExp(`^kind: ${kind}$`, "m").test(document));
    assert.equal(matches.length, 1, `expected exactly one rendered ${kind}`);
    const document = matches[0];
    const metadata = document.match(/^metadata:\n([\s\S]*?)^spec:/m)?.[1];
    assert.ok(metadata, `rendered ${kind} is missing metadata`);
    assert.deepEqual(
      [...metadata.matchAll(/^  name: (.+)$/gm)].map((match) => match[1]),
      [name],
      `rendered ${kind} has the wrong metadata.name`,
    );
    assert.deepEqual(
      [...metadata.matchAll(/^  namespace: (.+)$/gm)].map((match) => match[1]),
      ['"mb-element"'],
      `rendered ${kind}/${name} has the wrong metadata.namespace`,
    );
    return document;
  };
  const ingress = object("Ingress", "synapse");
  const middleware = object("Middleware", "matrix-cors-preflight-cache");
  const middlewareChain =
    "mb-element-hsts-header@kubernetescrd,mb-element-matrix-cors-preflight-cache@kubernetescrd";

  assert.deepEqual(
    [...ingress.matchAll(/^\s+- host: (.+)$/gm)].map((match) => match[1]),
    ["matrix.example.test"],
  );
  assert.deepEqual(
    [...ingress.matchAll(/^\s+- path: (.+)$/gm)].map((match) => match[1]),
    ["/_matrix", "/.well-known", "/_synapse"],
  );
  assert.deepEqual(
    [...ingress.matchAll(/^    traefik\.ingress\.kubernetes\.io\/router\.middlewares: (.+)$/gm)].map(
      (match) => match[1],
    ),
    [middlewareChain],
  );

  const middlewareSpec = middleware.match(/^spec:\n([\s\S]*)$/m)?.[0];
  assert.ok(middlewareSpec, "rendered middleware is missing spec");
  assert.deepEqual(
    middlewareSpec
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#")),
    ["spec:", "  headers:", "    customResponseHeaders:", '      Access-Control-Max-Age: "600"'],
  );
  console.log("assembled Matrix Ingress and preflight Middleware verified");
}

if (process.argv[2] === "--layout") {
  const playwrightPath = path.join(repoRoot, "performance/node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(playwrightPath));
  const browser = await chromium.launch({ headless: true });
  const variants = {
    notifications: `
      <div class="mx_Toast_title"><h2>Notifications</h2></div>
      <div class="mx_Toast_body"><div>
        <div class="mx_Toast_description test-tall-copy">Enable desktop notifications for new messages, mentions, calls, and invitations across all joined rooms.</div>
        <div class="mx_Toast_buttons"><button data-toast-control>Dismiss</button><button data-toast-control>Enable</button></div>
      </div></div>`,
    verification: `
      <svg aria-hidden="true"></svg><div class="mx_Toast_title"><h2>Long verification request from another device</h2></div>
      <div class="mx_Toast_body"><div>
        <div class="mx_Toast_description test-tall-copy">Device details and a-long-unbroken-device-identifier-that-must-wrap-safely-within-the-card.</div>
        <div class="mx_Toast_buttons"><button data-toast-control>Ignore for 9:59</button><button data-toast-control>Start verification</button></div>
      </div></div>`,
    matrixrtc: `
      <div class="mx_Toast_body mx_IncomingCallToast"><div class="mx_IncomingCallToast_content">
        <div class="mx_IncomingCallToast_title"><svg></svg><h2>Incoming encrypted team video call with a long room name</h2><button class="mx_IncomingCallToast_expandButton" data-toast-control>Expand</button></div>
        <div class="mx_IncomingCallToast_AvatarWithDetails test-tall-copy"><div class="mx_RoomAvatar">Avatar</div><div class="mx_AvatarWithDetails_details"><strong>Long room title that must remain contained in the toast</strong><span>@participant-with-a-long-matrix-identifier:matrix.example.test</span></div></div>
        <form><label>Enable video <input type="checkbox" data-toast-control aria-label="Enable video"></label></form>
        <div class="mx_IncomingCallToast_buttons"><button class="mx_IncomingCallToast_actionButton" data-toast-control>Decline</button><button class="mx_IncomingCallToast_actionButton" data-toast-control>Join call</button></div>
      </div></div>`,
    legacyCall: `
      <div class="mx_Toast_body mx_IncomingLegacyCallToast"><div class="mx_RoomAvatar">Avatar</div><div class="mx_IncomingLegacyCallToast_content">
        <span class="mx_LegacyCallEvent_caller">Very long caller display name that must remain contained</span><div class="mx_LegacyCallEvent_type test-tall-copy">Incoming video call</div>
        <div class="mx_IncomingLegacyCallToast_buttons"><button class="mx_IncomingLegacyCallToast_button" data-toast-control>Decline</button><button class="mx_IncomingLegacyCallToast_button" data-toast-control>Accept</button></div>
      </div><button class="mx_IncomingLegacyCallToast_iconButton" data-toast-control aria-label="Silence call"><svg></svg></button></div>`,
  };
  const expectedControls = { notifications: 2, verification: 2, matrixrtc: 4, legacyCall: 3 };
  const cases = [
    { width: 1280, height: 720, name: "desktop", variant: "notifications" },
    { width: 390, height: 720, name: "narrow", variant: "notifications" },
    ...Object.keys(variants).map((variant) => ({
      width: 640,
      height: 360,
      name: `short-${variant}`,
      variant,
    })),
    ...Object.keys(variants).map((variant) => ({
      // 640x360 at 150% browser zoom has an approximately 427x240 CSS viewport.
      width: 427,
      height: 240,
      name: `zoomed-${variant}`,
      variant,
    })),
  ];
  try {
    for (const testCase of cases) {
      const page = await browser.newPage({
        viewport: { width: testCase.width, height: testCase.height },
      });
      await page.setContent(`<!doctype html>
        <html class="ko-on-element"><head><style>
          html,body{margin:0;width:100%;height:100%}
          #matrixchat{position:relative;width:100%;height:100vh}
          #room-list-search-button{position:absolute;left:clamp(20px,6.33vw,81px);top:13.5px;
            width:min(302px,90vw);height:36px}
          .mx_ToastContainer{position:absolute;z-index:101;left:62px;top:12px;
            display:grid;grid-template-rows:1fr 28px 8px}
          .mx_Toast_toast{grid-row:1/3;grid-column:1;background:#fff;border:1px solid #ddd;
            border-radius:12px;overflow:hidden;display:grid;grid-template-columns:20px 1fr auto;
            column-gap:8px;row-gap:4px;align-items:center;padding:20px}
          .mx_Toast_toast svg{width:20px;height:20px}
          .mx_Toast_toast:not(.mx_Toast_hasIcon) .mx_Toast_title{grid-column:1/-1}
          .mx_Toast_title{display:flex;width:100%}.mx_Toast_title h2{margin:0}
          .mx_Toast_body{grid-column:1/-1;grid-row:2}.mx_Toast_description{max-width:272px;overflow:hidden}
          .mx_Toast_buttons,.mx_IncomingCallToast_buttons,.mx_IncomingLegacyCallToast_buttons{display:flex;justify-content:flex-end;column-gap:8px}
          .mx_Toast_buttons button{min-width:96px}.mx_IncomingCallToast_content{display:flex;flex-direction:column;gap:16px;overflow:hidden}
          .mx_IncomingCallToast_title{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center}
          .mx_IncomingCallToast{position:relative;display:flex;flex-direction:column}.mx_IncomingCallToast_content{width:100%}
          .mx_IncomingCallToast_AvatarWithDetails{box-sizing:border-box;display:flex;gap:8px;padding:12px}.mx_AvatarWithDetails_details{display:flex;flex-direction:column;white-space:nowrap}
          .mx_IncomingCallToast_actionButton{min-width:131px}.mx_IncomingLegacyCallToast{display:flex;align-items:center}
          .mx_IncomingLegacyCallToast_content{display:flex;flex-direction:column;margin-left:8px}
          .mx_LegacyCallEvent_caller{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
          .mx_IncomingLegacyCallToast_iconButton{box-sizing:border-box;width:20px;padding:0;border:0}.mx_RoomAvatar{width:32px;flex:0 0 32px}.mx_IncomingCallToast_AvatarWithDetails .mx_RoomAvatar{width:40px;flex-basis:40px}
          .mx_IncomingLegacyCallToast_button{padding:8px;flex:1 0 auto}.test-tall-copy{min-height:180px}
        </style></head><body><div class="mx_MatrixChat_wrapper">
          <aside class="mx_ToastContainer" role="alert"><div class="mx_Toast_toast ${
            testCase.variant === "verification" ? "mx_Toast_hasIcon" : ""
          }">${variants[testCase.variant]}</div></aside>
          <main class="mx_MatrixChat" id="matrixchat">
            <button id="room-list-search-button">Search rooms</button>
          </main>
        </div></body></html>`);
      await page.addScriptTag({ content: overlay });
      const geometry = await page.evaluate(() => {
        const intersects = (a, b) =>
          !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        const search = document.querySelector("#room-list-search-button");
        const toast = document.querySelector(".mx_ToastContainer");
        const card = document.querySelector(".mx_Toast_toast");
        const header = document.querySelector("#ko-portal-header");
        const searchBox = search.getBoundingClientRect();
        const toastBox = toast.getBoundingClientRect();
        const headerBox = header.getBoundingClientRect();
        const hit = document.elementFromPoint(
          searchBox.left + searchBox.width / 2,
          searchBox.top + searchBox.height / 2,
        );
        const widthOwners = [
          toast,
          card,
          ...document.querySelectorAll(
            ".mx_Toast_body,.mx_IncomingCallToast_content,.mx_IncomingCallToast_title,.mx_IncomingCallToast_buttons,.mx_IncomingCallToast_AvatarWithDetails,.mx_AvatarWithDetails_details,.mx_IncomingLegacyCallToast_content,.mx_IncomingLegacyCallToast_buttons",
          ),
        ];
        const horizontalOverflow = widthOwners
          .filter((owner) => owner.scrollWidth > owner.clientWidth + 1)
          .map((owner) => ({
            className: owner.className,
            clientWidth: owner.clientWidth,
            scrollWidth: owner.scrollWidth,
            children: [...owner.children].map((child) => ({
              className: child.className,
              rect: child.getBoundingClientRect().toJSON(),
              marginLeft: getComputedStyle(child).marginLeft,
              marginRight: getComputedStyle(child).marginRight,
            })),
          }));
        const controls = [...document.querySelectorAll("[data-toast-control]")];
        const controlReachability = controls.map(
          (control) => {
            control.focus();
            control.scrollIntoView({ block: "nearest", inline: "nearest" });
            const controlBox = control.getBoundingClientRect();
            const currentToastBox = toast.getBoundingClientRect();
            const currentCardBox = card.getBoundingClientRect();
            const hitAtCenter = document.elementFromPoint(
              controlBox.left + controlBox.width / 2,
              controlBox.top + controlBox.height / 2,
            );
            return {
              text: control.getAttribute("aria-label") || control.textContent,
              control: controlBox.toJSON(),
              toast: currentToastBox.toJSON(),
              card: currentCardBox.toJSON(),
              hit: hitAtCenter?.className || hitAtCenter?.tagName,
              reachable:
                document.activeElement === control &&
                controlBox.top >= currentToastBox.top - 1 &&
                controlBox.bottom <= Math.min(currentToastBox.bottom, innerHeight) + 1 &&
                controlBox.left >= currentToastBox.left - 1 &&
                controlBox.right <= Math.min(currentToastBox.right, innerWidth) + 1 &&
                controlBox.top >= currentCardBox.top - 1 &&
                controlBox.bottom <= currentCardBox.bottom + 1 &&
                (hitAtCenter === control || control.contains(hitAtCenter)),
            };
          },
        );
        const maximumScroll = toast.scrollHeight - toast.clientHeight;
        toast.scrollTop = maximumScroll;
        const attainedScroll = toast.scrollTop;
        const finalControl = controls.reduce((bottommost, control) =>
          control.getBoundingClientRect().bottom > bottommost.getBoundingClientRect().bottom
            ? control
            : bottommost,
        );
        const finalControlBox = finalControl.getBoundingClientRect();
        const scrolledToastBox = toast.getBoundingClientRect();
        const finalHit = document.elementFromPoint(
          finalControlBox.left + finalControlBox.width / 2,
          finalControlBox.top + finalControlBox.height / 2,
        );
        const finalControlVisibleAtEnd =
          finalControlBox.top >= scrolledToastBox.top - 1 &&
          finalControlBox.bottom <= Math.min(scrolledToastBox.bottom, innerHeight) + 1 &&
          (finalHit === finalControl || finalControl.contains(finalHit));
        toast.scrollTop = 0;
        const cardBox = card.getBoundingClientRect();
        return {
          headerOverlap: intersects(headerBox, toastBox),
          searchOverlap: intersects(searchBox, toastBox),
          search: searchBox.toJSON(),
          toast: toastBox.toJSON(),
          card: cardBox.toJSON(),
          searchReceivesPointer: hit === search,
          horizontallyContained:
            toastBox.left >= -1 &&
            toastBox.right <= innerWidth + 1 &&
            cardBox.left >= toastBox.left - 1 &&
            cardBox.right <= toastBox.right + 1 &&
            toast.scrollWidth <= toast.clientWidth + 1,
          verticallyBounded: toastBox.bottom <= innerHeight + 1,
          horizontalOverflow,
          controlCount: controls.length,
          controlReachability,
          maximumScroll,
          attainedScroll,
          finalControlVisibleAtEnd,
        };
      });
      assert.equal(geometry.searchOverlap, false, `${testCase.name}: toast overlaps room search`);
      assert.equal(geometry.headerOverlap, false, `${testCase.name}: toast overlaps suite header`);
      assert.equal(
        geometry.searchReceivesPointer,
        true,
        `${testCase.name}: room search does not receive pointer input`,
      );
      assert.equal(geometry.horizontallyContained, true, `${testCase.name}: toast is horizontally clipped`);
      assert.deepEqual(
        geometry.horizontalOverflow,
        [],
        `${testCase.name}: toast content has horizontal overflow`,
      );
      assert.equal(geometry.verticallyBounded, true, `${testCase.name}: toast escapes the dynamic viewport`);
      assert.equal(
        geometry.controlCount,
        expectedControls[testCase.variant],
        `${testCase.name}: fixture control coverage drifted`,
      );
      if (testCase.name.startsWith("short-") || testCase.name.startsWith("zoomed-")) {
        assert.equal(
          geometry.maximumScroll > 0,
          true,
          `${testCase.name}: tall toast did not create a scroll range`,
        );
        assert.equal(
          geometry.attainedScroll > 0,
          true,
          `${testCase.name}: toast could not attain a positive scroll offset`,
        );
      }
      assert.equal(
        geometry.finalControlVisibleAtEnd,
        true,
        `${testCase.name}: final control is not visible at maximum scroll`,
      );
      for (const control of geometry.controlReachability) {
        assert.equal(
          control.reachable,
          true,
          `${testCase.name}: control is unreachable: ${JSON.stringify(control)}`,
        );
      }
      console.log(
        `${testCase.name} ${testCase.width}x${testCase.height}: ${JSON.stringify(geometry)}`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

console.log("Element browser quick-win contracts verified");
