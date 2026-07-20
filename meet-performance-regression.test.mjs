import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.dirname(new URL(import.meta.url).pathname);
const performancePatch = await readFile(
  path.join(
    repositoryRoot,
    "patches/meet/performance-lazy-background-processors.patch",
  ),
  "utf8",
);

test("Meet performance patch defers optional processors", () => {
  assert.match(
    performancePatch,
    /await import\(\n\+      '@mediapipe\/tasks-vision'/,
  );
  assert.match(
    performancePatch,
    /await import\(\n\+      '\.\/UnifiedBackgroundTrackProcessor'/,
  );
  assert.match(performancePatch, /modulePreload:/);
  assert.match(performancePatch, /vision_bundle\|UnifiedBackgroundTrackProcessor/);
});

test("Meet workflow remains pinned to the measured upstream", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/meet-frontend-image.yaml"),
    "utf8",
  );
  assert.match(workflow, /^  MEET_REF: v1\.20\.0$/m);
});

test(
  "patched Meet source has no eager MediaPipe value imports",
  { skip: !process.env.MEET_SOURCE_DIR },
  async () => {
    const blurDirectory = path.join(
      process.env.MEET_SOURCE_DIR,
      "src/frontend/src/features/rooms/livekit/components/blur",
    );
    for (const file of [
      "BackgroundCustomProcessor.ts",
      "FaceLandmarksProcessor.ts",
      "OpenSuiteBackgroundProcessor.ts",
    ]) {
      const source = await readFile(path.join(blurDirectory, file), "utf8");
      assert.doesNotMatch(
        source,
        /import\s*\{[^}]+\}\s*from '@mediapipe\/tasks-vision'/s,
        `${file} has an eager MediaPipe value import`,
      );
      assert.match(source, /await import\(\s*'@mediapipe\/tasks-vision'\s*\)/);
    }

    const factory = await readFile(path.join(blurDirectory, "index.ts"), "utf8");
    assert.doesNotMatch(
      factory,
      /^import \{ UnifiedBackgroundTrackProcessor \}/m,
    );
    assert.doesNotMatch(
      factory,
      /import\s*\{[^}]+\}\s*from '@livekit\/track-processors'/s,
    );
    assert.match(factory, /class LazyUnifiedBackgroundTrackProcessor/);
  },
);

test(
  "candidate build keeps MediaPipe in a separate optional chunk",
  { skip: !process.env.MEET_DIST_DIR },
  async () => {
    const assetsDirectory = path.join(process.env.MEET_DIST_DIR, "assets");
    const assets = await readdir(assetsDirectory, { withFileTypes: true });
    const visionBundles = assets.filter(
      (entry) => entry.isFile() && /^vision_bundle-.+\.js$/.test(entry.name),
    );
    assert.ok(visionBundles.length >= 2, "expected facade and MediaPipe chunks");
    const sizes = await Promise.all(
      visionBundles.map(async ({ name }) =>
        (await readFile(path.join(assetsDirectory, name))).byteLength,
      ),
    );
    assert.ok(
      sizes.some((size) => size > 100_000),
      "expected a deferred MediaPipe implementation chunk",
    );

    const index = await readFile(
      path.join(process.env.MEET_DIST_DIR, "index.html"),
      "utf8",
    );
    assert.doesNotMatch(index, /vision_bundle|UnifiedBackgroundTrackProcessor/);
  },
);
