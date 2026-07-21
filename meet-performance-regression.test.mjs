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
  assert.match(
    workflow,
    /^          MEET_SOURCE_DIR: \$\{\{ github\.workspace \}\}\/meet-src$/m,
  );
  assert.match(workflow, /node --test meet-performance-regression\.test\.mjs/);
});

test("patched Meet source loads MediaPipe before allocating resources", async () => {
  assert.ok(
    process.env.MEET_SOURCE_DIR,
    "MEET_SOURCE_DIR must point to an assembled, patched Meet checkout",
  );
  const blurDirectory = path.join(
    process.env.MEET_SOURCE_DIR,
    "src/frontend/src/features/rooms/livekit/components/blur",
  );
  const processors = [
    {
      file: "BackgroundCustomProcessor.ts",
      importedValues: "FilesetResolver, ImageSegmenter",
      allocations: [
        "this.source = opts.track",
        "this._initVirtualBackgroundImage()",
        "this._createMainCanvas()",
        "this._createMaskCanvas()",
        "this.outputCanvas!.captureStream()",
        "this.processedTrack =",
        "new ImageData(",
      ],
      initializerCall: "this.initSegmenter(FilesetResolver, ImageSegmenter)",
    },
    {
      file: "FaceLandmarksProcessor.ts",
      importedValues: "FilesetResolver, FaceLandmarker",
      allocations: [
        "this.source = opts.track",
        "this._initEffectImages()",
        "this._createMainCanvas()",
        "this.outputCanvas!.captureStream()",
        "this.processedTrack =",
      ],
      forbiddenBeforeInit: "this._initEffectImages()",
      initializerCall:
        "this.initFaceLandmarker(FilesetResolver, FaceLandmarker)",
    },
    {
      file: "OpenSuiteBackgroundProcessor.ts",
      importedValues: "FilesetResolver, ImageSegmenter",
      allocations: [
        "this.source = opts.track",
        "document.createElement('canvas')",
        "this._initGL()",
        "this._loadBackground()",
        "this.canvas.captureStream(FPS)",
        "this.processedTrack =",
      ],
    },
  ];

  for (const {
    file,
    importedValues,
    allocations,
    forbiddenBeforeInit,
    initializerCall,
  } of processors) {
    const source = await readFile(path.join(blurDirectory, file), "utf8");
    assert.doesNotMatch(
      source,
      /import\s*\{[^}]+\}\s*from '@mediapipe\/tasks-vision'/s,
      `${file} has an eager MediaPipe value import`,
    );

    const initStart = source.indexOf("async init(opts:");
    assert.notEqual(initStart, -1, `${file} has no init method`);
    if (forbiddenBeforeInit) {
      assert.ok(
        !source.slice(0, initStart).includes(forbiddenBeforeInit),
        `${file} allocates resources before init can load MediaPipe`,
      );
    }
    const initSource = source.slice(initStart);
    const importPattern = new RegExp(
      `if \\(!opts\\.element\\)(?: \\{)?\\s*` +
        `throw new Error\\('Element is required for processing'\\)\\s*` +
        `\\}?\\s*const \\{ ${importedValues} \\} = await import\\(` +
        `\\s*'@mediapipe/tasks-vision'\\s*\\)`,
    );
    assert.match(
      initSource,
      importPattern,
      `${file} must load MediaPipe immediately after validating opts.element`,
    );

    const importIndex = initSource.indexOf("await import(");
    for (const allocation of allocations) {
      const allocationIndex = initSource.indexOf(allocation);
      assert.notEqual(
        allocationIndex,
        -1,
        `${file} no longer contains expected allocation: ${allocation}`,
      );
      assert.ok(
        importIndex < allocationIndex,
        `${file} allocates ${allocation} before loading MediaPipe`,
      );
    }
    if (initializerCall) {
      assert.ok(
        initSource.includes(`await ${initializerCall}`),
        `${file} does not pass the imported values to its initializer`,
      );
    }
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
});

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
