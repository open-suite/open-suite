import assert from "node:assert/strict";
import { test } from "node:test";

function vulnerablePicker(importPromise) {
  let wrapper;
  return {
    get: async () => {
      if (!wrapper) {
        wrapper = { $refs: {}, open(...args) { return this.$refs.picker.open(...args); } };
        importPromise.then(({ default: child }) => { wrapper.$refs.picker = child; });
      }
      return wrapper;
    },
  };
}

function importReadyPicker(load, construct) {
  let importPromise;
  let wrapper;
  return async function get() {
    importPromise ??= load();
    const { default: component } = await importPromise;
    if (!wrapper) wrapper = construct(component);
    return wrapper;
  };
}

test("NC34 immediate wrapper reproduces the unresolved lazy child open race", async () => {
  const picker = vulnerablePicker(new Promise(() => {}));
  const wrapper = await picker.get();
  assert.throws(() => wrapper.open("fixture"), /reading 'open'/);
});

test("candidate holds wrapper construction on one cached import for concurrent callers", async () => {
  let releaseImport;
  const importPromise = new Promise((resolve) => { releaseImport = resolve; });
  let imports = 0;
  let constructions = 0;
  const get = importReadyPicker(() => { imports += 1; return importPromise; }, (component) => {
    constructions += 1;
    return { $refs: { picker: component } };
  });
  let settlements = 0;
  const first = get().then((value) => { settlements += 1; return value; });
  const second = get().then((value) => { settlements += 1; return value; });
  await Promise.resolve();
  assert.equal(settlements, 0);
  assert.equal(imports, 1);
  assert.equal(constructions, 0);

  releaseImport({ default: { open: (name) => `opened:${name}` } });
  const [firstWrapper, secondWrapper] = await Promise.all([first, second]);
  assert.equal(firstWrapper, secondWrapper);
  assert.equal(constructions, 1);
  assert.equal(firstWrapper.$refs.picker.open("fixture"), "opened:fixture");
});

test("candidate import failure rejects every concurrent caller", async () => {
  let rejectImport;
  const importPromise = new Promise((resolve, reject) => { rejectImport = reject; });
  let imports = 0;
  let constructions = 0;
  const get = importReadyPicker(() => { imports += 1; return importPromise; }, () => { constructions += 1; });
  const first = get();
  const second = get();
  const chunkError = new Error("TemplatePicker chunk aborted");
  rejectImport(chunkError);
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(({ status }) => status), ["rejected", "rejected"]);
  assert.equal(results[0].reason, chunkError);
  assert.equal(results[1].reason, chunkError);
  assert.equal(imports, 1);
  assert.equal(constructions, 0);
});

test("generated lazy loader retains module-scope Webpack runtime when the handler shadows t", async () => {
  const loadedChunks = [];
  const modules = new Map([[27497, { default: "TemplatePicker" }]]);
  const t = (moduleId) => modules.get(moduleId);
  t.e = async (chunkId) => { loadedChunks.push(chunkId); };
  t.bind = Function.prototype.bind;
  let tn = null;
  const opensuiteTemplatePickerLoader = () => Promise.all([t.e(4208), t.e(7497)]).then(t.bind(t, 27497));

  async function generatedHandler(e, t) {
    assert.equal(e, "provider");
    assert.equal(t, 3);
    tn ||= opensuiteTemplatePickerLoader();
    return (await tn).default;
  }

  assert.equal(await generatedHandler("provider", 3), "TemplatePicker");
  assert.deepEqual(loadedChunks, [4208, 7497]);
});
