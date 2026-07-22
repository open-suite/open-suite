import assert from "node:assert/strict";
import fs from "node:fs";

const header = fs.readFileSync("overlays/portal-header/opensuite-header.js", "utf8");
const sourcePatch = fs.readFileSync(
    "images/element/patches/replace-sso-history.patch",
    "utf8",
);
const imagePatch = fs.readFileSync("images/element/patch-sso-history.sh", "utf8");

assert.match(header, /\{ label: "Chat", sub: "element", path: "\/#\/home" \}/);
assert.match(sourcePatch, /-        window\.location\.href = mxClient\.getSsoLoginUrl/);
assert.match(sourcePatch, /\+        window\.location\.replace\(mxClient\.getSsoLoginUrl/);
assert.match(imagePatch, /window\.location\.replace\(e\.getSsoLoginUrl/);

class BrowserHistory {
    constructor(url) {
        this.entries = [url];
        this.index = 0;
    }

    assign(url) {
        this.entries.splice(++this.index, Infinity, url);
    }

    replace(url) {
        this.entries[this.index] = url;
    }

    back() {
        if (this.index > 0) this.index -= 1;
        return this.entries[this.index];
    }

    forward() {
        if (this.index < this.entries.length - 1) this.index += 1;
        return this.entries[this.index];
    }

    current() {
        return this.entries[this.index];
    }
}

const portal = "https://bridge.example.test/calendar?day=2026-07-22";
const home = "https://element.example.test/#/home";
const room = "https://element.example.test/#/room/%23welcome:matrix.example.test?via=matrix.example.test";

// Established session: the canonical header URL is already the route Element
// selects, so there is no bare-root -> home assignment between Portal and Chat.
const established = new BrowserHistory(portal);
established.assign(home);
assert.equal(established.back(), portal);
assert.equal(established.forward(), home);

// This is the original trap and guards the model: entering bare root and then
// assigning home leaves an extra Element entry which catches Back.
const oldBehavior = new BrowserHistory(portal);
oldBehavior.assign("https://element.example.test/");
oldBehavior.assign(home);
assert.equal(oldBehavior.back(), "https://element.example.test/");

function completeFreshSso(destination) {
    const history = new BrowserHistory(portal);
    history.assign(destination);

    const sso = new URL("https://matrix.example.test/_matrix/client/v3/login/sso/redirect");
    sso.searchParams.set("redirectUrl", destination);
    // Patched BasePlatform: replace the pre-SSO Element entry. HTTP redirects
    // and the Element callback commit into this same traversal entry.
    history.replace(sso.toString());
    history.replace(
        `${destination.split("#")[0]}?loginToken=secret#${destination.split("#")[1]}`,
    );
    // Existing callback cleanup remains replaceState and restores the exact
    // requested home/room fragment without retaining the token URL.
    history.replace(destination);
    return history;
}

for (const destination of [home, room]) {
    const fresh = completeFreshSso(destination);
    assert.equal(fresh.current(), destination);
    assert.equal(fresh.entries.length, 2);
    assert.ok(fresh.entries.every((url) => !/loginToken|\/login\/sso\/redirect/.test(url)));
    assert.equal(fresh.back(), portal);
    assert.equal(fresh.forward(), destination);
}
