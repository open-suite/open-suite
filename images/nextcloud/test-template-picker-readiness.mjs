import assert from "node:assert/strict";
import { test } from "node:test";

function vulnerablePicker() {
  const wrapper = { $refs: {}, open(...args) { return this.$refs.picker.open(...args); } };
  return { get: async () => wrapper, wrapper };
}

function mountedPicker() {
  let wrapper;
  let markMounted;
  const mountedEvents = [];
  const ready = new Promise((resolve) => { markMounted = resolve; });
  const component = {
    mixins: [{ mounted() { mountedEvents.push("upstream"); } }],
  };
  component.mixins = [
    ...(component.mixins || []),
    { mounted() { mountedEvents.push("ready"); markMounted(); } },
  ];
  return {
    get: async () => {
      await ready;
      if (typeof wrapper?.$refs?.picker?.open !== "function") {
        throw new Error("Template picker mounted without an open method");
      }
      return wrapper;
    },
    mount() {
      wrapper = { $refs: { picker: { open: (name) => `opened:${name}` } } };
      for (const mixin of component.mixins) mixin.mounted();
    },
    mountedEvents,
  };
}

test("NC34 immediate wrapper reproduces the lazy child open race", async () => {
  const picker = vulnerablePicker();
  const wrapper = await picker.get();
  assert.throws(() => wrapper.open("fixture"), /reading 'open'/);
});

test("candidate shares child-mounted readiness across concurrent callers", async () => {
  const picker = mountedPicker();
  let settled = false;
  const first = picker.get().then((value) => { settled = true; return value; });
  const second = picker.get();
  await Promise.resolve();
  assert.equal(settled, false);
  picker.mount();
  const [firstWrapper, secondWrapper] = await Promise.all([first, second]);
  assert.equal(firstWrapper, secondWrapper);
  assert.equal(firstWrapper.$refs.picker.open("fixture"), "opened:fixture");
  assert.deepEqual(picker.mountedEvents, ["upstream", "ready"]);
});

test("candidate rejects a mounted child without the required open contract", async () => {
  let markMounted;
  const ready = new Promise((resolve) => { markMounted = resolve; });
  const wrapper = { $refs: { picker: {} } };
  const candidate = (async () => {
    await ready;
    if (typeof wrapper?.$refs?.picker?.open !== "function") {
      throw new Error("Template picker mounted without an open method");
    }
    return wrapper;
  })();
  markMounted();
  await assert.rejects(candidate, /mounted without an open method/);
});
