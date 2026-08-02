import assert from "node:assert/strict";
import { createRequire } from "node:module";

const moduleRoot = process.env.VUE_COMPAT_MODULE_ROOT;
if (!moduleRoot) throw new Error("VUE_COMPAT_MODULE_ROOT is required");
const require = createRequire(`${moduleRoot}/package.json`);
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
  url: "https://nextcloud.example.test/apps/files/files",
});
for (const name of ["window", "document", "Element", "SVGElement", "Node", "HTMLElement"]) {
  globalThis[name] = dom.window[name];
}
const VueModule = require("@vue/compat/dist/vue.cjs.js");
const Vue = VueModule.default || VueModule;
VueModule.configureCompat({ MODE: 2 });

let resolveModule;
let resolvePickerReady;
const pickerReady = new Promise((resolve) => { resolvePickerReady = resolve; });
const upstreamMounted = [];
const TemplatePicker = VueModule.defineAsyncComponent(() => new Promise((resolve) => {
  resolveModule = () => resolve({
    __esModule: true,
    default: {
      mixins: [{ mounted() { upstreamMounted.push("upstream"); } }],
      methods: { open(name) { return `opened:${name}`; } },
      render(h) { return h("div", "ready"); },
    },
  });
}).then((module) => {
  module.default.mixins = [
    ...(module.default.mixins || []),
    { mounted: resolvePickerReady },
  ];
  return module;
}));

let wrapper;
async function getTemplatePicker() {
  if (!wrapper) {
    wrapper = new Vue({
      render: (h) => h(TemplatePicker, { ref: "picker" }),
      methods: { open(...args) { return this.$refs.picker.open(...args); } },
      el: document.querySelector("#mount"),
    });
  }
  await pickerReady;
  if (typeof wrapper?.$refs?.picker?.open !== "function") {
    throw new Error("Template picker mounted without an open method");
  }
  return wrapper;
}

let settled = false;
const first = getTemplatePicker().then((value) => { settled = true; return value; });
const second = getTemplatePicker();
await Promise.resolve();
assert.equal(settled, false);
assert.equal(typeof wrapper.$refs.picker?.open, "undefined");

resolveModule();
const [firstWrapper, secondWrapper] = await Promise.all([first, second]);
assert.equal(firstWrapper, secondWrapper);
assert.deepEqual(upstreamMounted, ["upstream"]);
assert.equal(firstWrapper.open("fixture"), "opened:fixture");
console.log("Vue compat lazy TemplatePicker child readiness verified");
