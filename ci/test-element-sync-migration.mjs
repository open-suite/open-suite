import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("overlays/portal-header/opensuite-header.js", "utf8");
const enabledSource = source.replace(
    'var ELEMENT_SYNC_MIGRATION = "";',
    'var ELEMENT_SYNC_MIGRATION = "stable-demo-dm-v1";',
);

function makeContext(storage) {
    const deletions = [];
    const localStorage = {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
    };
    const document = {
        body: null,
        readyState: "loading",
        documentElement: { style: { setProperty() {} } },
        addEventListener() {},
    };
    const window = {
        indexedDB: {
            deleteDatabase(name) {
                const request = {};
                deletions.push(name);
                queueMicrotask(() => request.onsuccess?.());
                return request;
            },
        },
        localStorage,
        location: {
            hostname: "element.demo.example.test",
            pathname: "/",
            protocol: "https:",
        },
    };
    window.self = window;
    window.top = window;
    return {
        context: { console, document, setInterval() {}, window },
        deletions,
    };
}

async function run(script, storage) {
    const { context, deletions } = makeContext(storage);
    vm.runInNewContext(script, context);
    await new Promise((resolve) => setImmediate(resolve));
    return deletions;
}

const disabledStorage = new Map();
assert.deepEqual(await run(source, disabledStorage), []);

const storage = new Map();
assert.deepEqual(await run(enabledSource, storage), ["matrix-js-sdk:riot-web-sync"]);
assert.equal(storage.get("opensuite.element.sync-migration"), "stable-demo-dm-v1");

// A successful migration is exactly once per version and preserves every
// unrelated localStorage entry (including Element's login metadata).
storage.set("mx_user_id", "@johndoe:matrix.demo.example.test");
assert.deepEqual(await run(enabledSource, storage), []);
assert.equal(storage.get("mx_user_id"), "@johndoe:matrix.demo.example.test");

// The validate workflow already owns the Element static-test entry point. Keep
// the image/runtime contract guard on that path without broadening workflows.
await import("./test-element-sso-history.mjs");
await import("./test-element-image-runtime.mjs");
