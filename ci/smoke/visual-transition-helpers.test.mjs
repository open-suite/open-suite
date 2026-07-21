import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classifyFile, chooseCandidate, contractOutcome, enforceArtifactBudget, parseMode, sameDeepLink, sanitizeUrl } from "./visual-transition-helpers.mjs";

test("mode only enables an explicit enforce contract", () => {
  assert.equal(parseMode("enforce"), "enforce");
  assert.equal(parseMode("yes"), "baseline");
});
test("URLs retain shape but never query values or credentials", () => {
  const value = sanitizeUrl("https://user:pass@example.test/f/7?token=secret&x=hello#room?code=bad");
  assert.equal(value, "https://example.test/f/7?token=%3Credacted%3E&x=%3Credacted%3E#room");
  assert.ok(!/secret|hello|user|pass|bad/.test(value));
  assert.equal(sameDeepLink("/f/7?x=one#editor", "/f/7?x=one#editor", "https://nextcloud.example.test"), true);
  assert.equal(sameDeepLink("/apps/files", "/f/7", "https://nextcloud.example.test"), false);
});
test("file candidates are deterministic and correctly classified", () => {
  assert.equal(classifyFile("Board.whiteboard"), "whiteboard");
  assert.equal(classifyFile("Plan.DOCX"), "office");
  assert.equal(chooseCandidate(["z.docx", "a.odt"], "", "office"), "a.odt");
  assert.equal(chooseCandidate(["a.odt"], "missing.docx", "office"), null);
});
test("baseline reports contract observations without passing them", () => {
  const item = { ok: false };
  assert.deepEqual(contractOutcome({ mode: "baseline", blocking: [item] }), { classification: "observed-not-passed", failed: false });
  assert.equal(contractOutcome({ mode: "enforce", blocking: [item] }).failed, true);
  assert.equal(contractOutcome({ mode: "baseline", observations: [{ ok: false, hard: true }] }).failed, true);
  assert.deepEqual(contractOutcome({ mode: "baseline", exists: false }), { classification: "uncontracted/missing", failed: false });
  assert.deepEqual(contractOutcome({ mode: "baseline", exists: false, observations: [{ ok: false, hard: true }] }), { classification: "failed", failed: true });
});
test("artifact budget removes captures until the directory is bounded", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "visual-transition-budget-"));
  try {
    await writeFile(path.join(directory, "large.webm"), Buffer.alloc(12));
    await writeFile(path.join(directory, "small.json"), Buffer.alloc(4));
    const result = await enforceArtifactBudget(directory, 5);
    assert.ok(result.total <= 5);
    assert.deepEqual(result.removed.map((name) => path.basename(name)), ["large.webm"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
