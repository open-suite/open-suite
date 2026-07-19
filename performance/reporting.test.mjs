import assert from "node:assert/strict";
import test from "node:test";

import {
  parseNonNegativeNumber,
  parsePositiveInteger,
  quantile,
  sanitizeUrl,
  summarizeRuns,
  summarizeValues,
} from "./reporting.mjs";

test("quantile uses linear type-7 interpolation without mutating input", () => {
  const values = [4, 1, 3, 2];
  assert.equal(quantile(values, 0.25), 1.75);
  assert.equal(quantile(values, 0.5), 2.5);
  assert.equal(quantile(values, 0.75), 3.25);
  assert.deepEqual(values, [4, 1, 3, 2]);
  assert.equal(quantile([7], 0.95), 7);
  assert.equal(quantile([], 0.5), null);
});

test("summaries include robust spread and ignore non-finite observations", () => {
  const summary = summarizeValues([1, 2, 3, 4, Number.NaN, Infinity]);
  assert.deepEqual(summary, {
    n: 4,
    min: 1,
    p25: 1.75,
    p50: 2.5,
    p75: 3.25,
    p95: 3.8499999999999996,
    max: 4,
    iqr: 1.5,
    mad: 1,
    scaledMad: 1.4826,
    robustCv: 0.59304,
  });
  assert.equal(summarizeValues([-1, 0, 1]).robustCv, null);
  assert.equal(summarizeValues([]).n, 0);
});

test("run summaries include numeric metrics only", () => {
  assert.deepEqual(
    summarizeRuns([
      { metrics: { elapsed_ms: 10, resources: [] } },
      { metrics: { elapsed_ms: 20, resources: [] } },
    ]),
    {
      elapsed_ms: {
        n: 2,
        min: 10,
        p25: 12.5,
        p50: 15,
        p75: 17.5,
        p95: 19.5,
        max: 20,
        iqr: 5,
        mad: 5,
        scaledMad: 7.412999999999999,
        robustCv: 0.4942,
      },
    },
  );
});

test("numeric benchmark inputs reject empty and invalid runs", () => {
  assert.equal(parsePositiveInteger(undefined, 5, "samples"), 5);
  assert.equal(parseNonNegativeNumber("0", 1000, "pacing"), 0);
  for (const value of ["", "0", "-1", "1.5", "nope"]) {
    assert.throws(() => parsePositiveInteger(value, 5, "samples"));
  }
  for (const value of ["", "-1", "nope"]) {
    assert.throws(() => parseNonNegativeNumber(value, 1000, "pacing"));
  }
});

test("URLs retain only origin and path", () => {
  assert.equal(
    sanitizeUrl("https://user:pass@example.test/path?a=secret#fragment"),
    "https://example.test/path",
  );
  assert.equal(sanitizeUrl("about:blank"), "about:blank");
  assert.equal(sanitizeUrl("data:text/plain,secret"), null);
  assert.equal(sanitizeUrl("not a URL"), null);
});
