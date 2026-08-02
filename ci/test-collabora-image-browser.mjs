import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { chromium } from "playwright";

const image = process.argv[2];
assert.ok(image, "usage: node ci/test-collabora-image-browser.mjs IMAGE");

const container = "collabora-candidate-browser-smoke";
const collaboraOrigin = "http://127.0.0.1:9980";
const token = "candidate-browser-smoke-token";
const wopiPort = 18080;
const wopiUrl = `http://127.0.0.1:${wopiPort}/wopi/files/${token}`;
const document = Buffer.from(
    "UEsDBBQAAAAAAJhjAl1exjIMJwAAACcAAAAIAAAAbWltZXR5cGVhcHBsaWNhdGlvbi92bmQub2FzaXMub3BlbmRvY3VtZW50LnRleHRQSwMEFAAAAAgAmGMCXTl1rs+qAAAAUAEAAAsAAABjb250ZW50LnhtbI2Quw7CMAxFfyXKXgJMKErbjZUB+ICQuCiC2lWToPL3pA+qdkBi8uuea8uq7Oone0HrHWHOd5stZ4CGrMN7zq+XY3bgZaGoqpwBacnEGjBkhjCkyBKMXo7TnMcWJWnvvERdg5fBSGoAv5RcquWwauwE6MK/dK8d2clncfuez5feyL7nomcKNZBNcUqe7BxdAGY0Wmd1ytKCyHxND1Bi0imxosXKWPx4SPEBUEsDBBQAAAAIAJhjAl0ZUNuqqgAAAFIBAAAVAAAATUVUQS1JTkYvbWFuaWZlc3QueG1sjVDNDoIwDH4V0jtMb2ZhcPMJ9AGWUXTJ1i2sEHh7h4mCMSbe2q/fX1q3s3fFhEOygRQcqwMUSCZ0lm4KrpdzeYK2qb0m22Ni+RqKLKP0XhWMA8mgk02StMck2cgQkbpgRo/E8pMv16CdbW8dlpk2LMWGjc6VUfNdgYAN9thZXfISUYGO0VmjOXcXE3XVs0C1z60YZwbxf5QJxKsu9/0RujqK9ZxdxddjmgdQSwECFAMUAAAAAACYYwJdXsYyDCcAAAAnAAAACAAAAAAAAAAAAAAAgAEAAAAAbWltZXR5cGVQSwECFAMUAAAACACYYwJdOXWuz6oAAABQAQAACwAAAAAAAAAAAAAAgAFNAAAAY29udGVudC54bWxQSwECFAMUAAAACACYYwJdGVDbqqoAAABSAQAAFQAAAAAAAAAAAAAAgAEgAQAATUVUQS1JTkYvbWFuaWZlc3QueG1sUEsFBgAAAAADAAMAsgAAAP0BAAAAAA==",
    "base64",
);

const server = http.createServer((request, response) => {
    if (!request.url?.includes(token)) {
        response.writeHead(401).end();
        return;
    }
    const path = new URL(request.url, wopiUrl).pathname;
    if (request.method === "POST") {
        request.resume();
        request.on("end", () => response.writeHead(200, { "Content-Length": "0" }).end());
        return;
    }
    if (path.endsWith("/contents")) {
        response.writeHead(200, {
            "Content-Type": "application/vnd.oasis.opendocument.text",
            "Content-Length": document.length,
        }).end(document);
        return;
    }
    const body = Buffer.from(JSON.stringify({
        BaseFileName: "candidate-menu-smoke.odt",
        Size: document.length,
        OwnerId: "smoke",
        UserId: "smoke",
        UserFriendlyName: "Smoke",
        UserCanWrite: true,
        SupportsUpdate: true,
        Version: "1",
    }));
    response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": body.length,
    }).end(body);
});

const [containerCommand, ...containerPrefix] = (
    process.env.COLLABORA_CONTAINER_ENGINE ?? "docker"
).split(/\s+/);

function docker(...args) {
    return execFileSync(containerCommand, [...containerPrefix, ...args], { encoding: "utf8" });
}

async function waitForCollabora() {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${collaboraOrigin}/hosting/discovery`);
            if (response.ok) return;
        } catch {
            // The candidate is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("candidate Collabora image was not ready in 45 seconds");
}

await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(wopiPort, "127.0.0.1", resolve);
});

let browser;
try {
    docker("rm", "--force", container);
} catch {
    // A prior interrupted smoke left no candidate container to remove.
}

try {
    const extraParams = [
        "--o:ssl.enable=false",
        "--o:ssl.termination=false",
        "--o:user_interface.mode=classic",
        "--o:storage.wopi.host[0]=127.0.0.1",
        "--o:storage.wopi.alias_groups.mode=groups",
        "--o:storage.wopi.alias_groups.group[0].host=127.0.0.1",
        "--o:welcome.enable=false",
        "--o:home_mode.enable=true",
        "--o:logging.level=warning",
        "--o:logging.level_startup=warning",
    ].join(" ");
    docker(
        "run", "--detach", "--rm", "--network", "host", "--name", container,
        "--env", "DONT_GEN_SSL_CERT=true",
        "--env", "dictionaries=en_GB en_US nl",
        "--env", `extra_params=${extraParams}`,
        "--cap-add", "MKNOD",
        image,
    );
    await waitForCollabora();

    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const editorUrl = `${collaboraOrigin}/browser/7d478de54b/cool.html?WOPISrc=${encodeURIComponent(wopiUrl)}`
        + `&access_token=${token}&access_token_ttl=0`;
    await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("#menu-file > a").waitFor({ state: "visible", timeout: 45_000 });
    await page.locator("#menu-insert > a").waitFor({ state: "visible", timeout: 45_000 });

    await page.evaluate(() => {
        window.__candidateHideAll = 0;
        $("#main-menu").on("hideAll.smapi", () => window.__candidateHideAll++);
    });

    const file = page.locator("#menu-file > a");
    const save = page.locator("#menu-file > ul > #menu-save > a");
    await file.click();
    await save.waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await file.getAttribute("aria-expanded"), "true", "one click must expand File");

    await page.evaluate(() => {
        const toolbarParent = document.createElement("div");
        const toolbar = document.createElement("div");
        const toolbarRoot = document.createElement("div");
        toolbar.append(toolbarRoot);
        toolbarParent.append(toolbar);
        document.body.append(toolbarParent);
        Object.defineProperty(toolbarRoot, "scrollWidth", {
            configurable: true,
            get: () => window.innerWidth + 500,
        });
        Object.defineProperty(toolbar, "scrollLeft", {
            configurable: true,
            value: 0,
            writable: true,
        });
        JSDialog.MakeScrollable(toolbarParent, toolbar);
        const rightArrow = toolbarParent.querySelector(".ui-scroll-right");
        rightArrow.style.display = "none";

        const statusParent = document.createElement("div");
        const status = document.createElement("div");
        const statusRoot = document.createElement("div");
        const statusItems = ["high", "medium", "low"].map((id) => {
            const item = document.createElement("div");
            item.id = id;
            Object.defineProperty(item, "offsetWidth", { configurable: true, value: 100 });
            statusRoot.append(item);
            return item;
        });
        status.append(statusRoot);
        statusParent.append(status);
        document.body.append(statusParent);
        Object.defineProperty(statusParent, "clientWidth", { configurable: true, value: 100 });
        Object.defineProperty(statusRoot, "scrollWidth", { configurable: true, value: 300 });
        JSDialog.MakeStatusPriority(status, [
            { id: "high", dataPriority: "10" },
            { id: "medium", dataPriority: "5" },
            { id: "low", dataPriority: "1" },
        ]);

        window.__candidateScrollables = { rightArrow, statusItems };
        JSDialog.RefreshScrollables();
        return Promise.race([
            new Promise((resolve) => app.layoutingService.onDrain(resolve)),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error("layouting service did not drain in 5 seconds")),
                5_000,
            )),
        ]);
    });
    await page.waitForTimeout(350);
    const afterInternalRefresh = await page.evaluate(() => {
        const smartMenus = $("#main-menu").data("smartmenus");
        const { rightArrow, statusItems } = window.__candidateScrollables;
        return {
            hideAll: window.__candidateHideAll,
            expanded: document.querySelector("#menu-file > a")?.getAttribute("aria-expanded"),
            clickActivated: smartMenus.clickActivated,
            visibleSubMenus: smartMenus.visibleSubMenus.length,
            fileActivated: smartMenus.activatedItems[0]?.[0]?.parentElement?.id === "menu-file",
            rightArrowDisplay: getComputedStyle(rightArrow).display,
            hiddenStatuses: statusItems.filter((item) => item.classList.contains("status-hidden"))
                .map((item) => item.id),
            highPriority: statusItems[0].getAttribute("data-priority"),
        };
    });
    assert.equal(afterInternalRefresh.hideAll, 0, "internal refresh must not emit hideAll.smapi");
    assert.equal(afterInternalRefresh.expanded, "true", "File must remain aria-expanded");
    assert.equal(afterInternalRefresh.clickActivated, true, "SmartMenus click activation must survive");
    assert.equal(afterInternalRefresh.visibleSubMenus, 1, "SmartMenus must retain the visible submenu");
    assert.equal(afterInternalRefresh.fileActivated, true, "File must remain the activated item");
    assert.equal(await save.isVisible(), true, "Save must remain visible beyond the hide animation window");
    assert.equal(afterInternalRefresh.rightArrowDisplay, "block", "custom refresh must recalculate toolbar arrows");
    assert.equal(afterInternalRefresh.highPriority, "10", "custom refresh must assign status priority");
    assert.ok(afterInternalRefresh.hiddenStatuses.includes("high"), "custom refresh must hide pressured status items");

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForFunction(
        () => window.__candidateHideAll > 0,
        null,
        { timeout: 5_000 },
    );
    await page.waitForTimeout(350);
    assert.ok(await page.evaluate(() => window.__candidateHideAll) > 0, "real resize must emit hideAll.smapi");
    assert.equal(await file.getAttribute("aria-expanded"), "false", "real resize must collapse File");
    assert.equal(await save.isVisible(), false, "real resize must hide Save");

    console.log(JSON.stringify({
        image,
        oneClickSaveVisible: true,
        internalRefreshHideAll: 0,
        toolbarArrowRecalculated: true,
        statusPriorityRecalculated: true,
        realResizeHideAll: true,
        realResizeClosedMenu: true,
    }));
} finally {
    await browser?.close();
    try {
        docker("rm", "--force", container);
    } catch {
        // The --rm container may already have stopped itself.
    }
    await new Promise((resolve) => server.close(resolve));
}
