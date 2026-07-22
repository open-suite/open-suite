import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assessElementHome, classifyFile, chooseCandidate, contractOutcome, durableNextcloudFile, enforceArtifactBudget, officeLifecycleFixtureName, parseMode, sameDeepLink, sanitizeDiagnostic, sanitizeUrl } from "./visual-transition-helpers.mjs";

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
test("direct-edit capabilities and asset tokens never survive diagnostics", () => {
  const token = "a".repeat(64);
  const direct = sanitizeUrl(`https://nextcloud.example.test/apps/files/directEditing/${token}`);
  const asset = sanitizeDiagnostic(`failed https://nextcloud.example.test/apps/richdocuments/assets/${token}?login_hint=short&code=VERYSECRET bearer=${token} password=short`, ["short"]);
  assert.equal(direct, "https://nextcloud.example.test/apps/files/directEditing/%3Credacted%3E");
  assert.ok(!direct.includes(token));
  assert.ok(!asset.includes(token));
  assert.ok(!asset.includes("secret"));
  assert.ok(!asset.includes("short"));
  assert.ok(!asset.includes("VERYSECRET"));
});
test("durable Nextcloud links contain only a stable numeric file id", () => {
  assert.deepEqual(durableNextcloudFile("https://nextcloud.example.test/f/94", "https://bridge.example.test"), {
    fileId: "94",
    url: "https://nextcloud.example.test/f/94",
  });
  assert.equal(durableNextcloudFile("/index.php/f/1394", "https://nextcloud.example.test"), null);
  assert.equal(durableNextcloudFile("http://nextcloud.example.test/f/94", "https://nextcloud.example.test"), null);
  assert.equal(durableNextcloudFile("https://user:pass@nextcloud.example.test/f/94", "https://nextcloud.example.test"), null);
  assert.equal(durableNextcloudFile("/apps/files/directEditing/secret", "https://nextcloud.example.test"), null);
  assert.equal(durableNextcloudFile("/f/94?token=secret", "https://nextcloud.example.test"), null);
});
test("file candidates are deterministic and correctly classified", () => {
  assert.equal(classifyFile("Board.whiteboard"), "whiteboard");
  assert.equal(classifyFile("Plan.DOCX"), "office");
  assert.equal(chooseCandidate(["z.docx", "a.odt"], "", "office"), "a.odt");
  assert.equal(chooseCandidate(["a.odt"], "missing.docx", "office"), null);
});
test("Office lifecycle fixture names are unique, valid DOCX basenames", () => {
  const first = officeLifecycleFixtureName(1784750000000, "12345678-1234-4abc-8def-1234567890ab");
  const second = officeLifecycleFixtureName(1784750000000, "12345678-1234-4abc-8def-1234567890ac");
  assert.equal(first, "OpenSuite-Lifecycle-1784750000000-12345678-1234-4abc-8def-1234567890ab.docx");
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9-]+\.docx$/);
  assert.throws(() => officeLifecycleFixtureName(1784750000000, "../report"), /invalid Office lifecycle fixture identity/);
});
test("Element home marker requires authenticated home and visible room navigation", () => {
  const bodyText = "Welcome John Doe\nNow, let's help you get started\nSend a Direct Message";
  assert.deepEqual(assessElementHome({ bodyText, visibleRoomLabels: ["Jane Doe", "Team"] }), {
    ok: true,
    authenticatedHome: true,
    roomNavigation: true,
    forbidden: [],
  });
  assert.equal(assessElementHome({ bodyText, visibleRoomLabels: [] }).ok, false);
  assert.equal(assessElementHome({ bodyText: `${bodyText}\nConnecting to chat`, visibleRoomLabels: ["Jane Doe"] }).ok, false);
  assert.equal(assessElementHome({ bodyText: `${bodyText}\nFailed to load`, visibleRoomLabels: ["Jane Doe"] }).ok, false);
  assert.equal(assessElementHome({ bodyText: "Welcome to Element\nSign in", visibleRoomLabels: ["Team"] }).ok, false);
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
