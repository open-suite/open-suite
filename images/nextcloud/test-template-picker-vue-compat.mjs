import assert from "node:assert/strict";
import { createRequire } from "node:module";

const moduleRoot = process.env.VUE_MODULE_ROOT;
if (!moduleRoot) throw new Error("VUE_MODULE_ROOT is required");
const require = createRequire(`${moduleRoot}/package.json`);
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
  url: "https://nextcloud.example.test/apps/files/files",
});
for (const name of ["window", "document", "Element", "SVGElement", "Node", "HTMLElement"]) {
  globalThis[name] = dom.window[name];
}
const Vue = require("vue/dist/vue.common.js");

let releaseImport;
const importedComponent = new Promise((resolve) => {
  releaseImport = () => resolve({
    __esModule: true,
    default: {
      methods: { open(name) { return `opened:${name}`; } },
      render(h) { return h("div", "ready"); },
    },
  });
});

let TemplatePickerVue;
let wrapper;
let constructions = 0;
async function getTemplatePicker() {
  TemplatePickerVue ??= importedComponent;
  const { default: TemplatePickerComponent } = await TemplatePickerVue;
  if (!wrapper) {
    constructions += 1;
    wrapper = new Vue({
      render: (h) => h(TemplatePickerComponent, { ref: "picker" }),
      methods: { open(...args) { return this.$refs.picker.open(...args); } },
      el: document.querySelector("#mount"),
    });
  }
  return wrapper;
}

let settled = false;
const first = getTemplatePicker().then((value) => { settled = true; return value; });
const second = getTemplatePicker();
await Promise.resolve();
assert.equal(settled, false);
assert.equal(wrapper, undefined);
assert.equal(constructions, 0);

releaseImport();
const [firstWrapper, secondWrapper] = await Promise.all([first, second]);
assert.equal(firstWrapper, secondWrapper);
assert.equal(constructions, 1);
assert.equal(typeof firstWrapper.$refs.picker.open, "function");
assert.equal(firstWrapper.open("fixture"), "opened:fixture");
console.log(`Vue ${Vue.version} import-before-wrapper TemplatePicker readiness verified`);
