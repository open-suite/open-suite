import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const collaboraSourceRef = "7d478de54b81a47d88ad4cf71180b9ceeb466848";
const collaboraSourceSha256 =
    "f1b6cdf521dc10d1ccc501516d9c1faa85ea590c7cf5cdfddbe50d0ff5f96ad5";
const collaboraRuntime =
    "registry-1.docker.io/collabora/code:26.04.1.4.1@sha256:75859dc9f9084d1877ce36cf96ec86600f495bade33289c9cbc27e0a0ee23b81";
const patcherRuntime =
    "registry-1.docker.io/library/perl:5-slim@sha256:d9e618def9ecf01ac2aafdf1ee39e6ea42833ae84a947b9feb44a677382f3f81";
const upstreamBundleSha256 =
    "d113d084c5cba8d057199dbe04196a070762065aa693b5cc27df18e8cf20e476";
const patchedBundleSha256 =
    "2818e5e970ce5eefb069df393f034d54b4327b935d759185a6398618556b6a5e";
const bundlePath = "/usr/share/coolwsd/browser/dist/bundle.js";
const openSuiteImageTag = "sha-6cbf822";

const dockerfile = fs.readFileSync("images/collabora/Dockerfile", "utf8");
const sourcePatch = fs.readFileSync(
    "images/collabora/patches/smartmenus-lifecycle.patch",
    "utf8",
);
const bundlePatch = fs.readFileSync(
    "images/collabora/patch-smartmenus-lifecycle.pl",
    "utf8",
);
const imageWorkflow = fs.readFileSync(
    ".github/workflows/collabora-image.yaml",
    "utf8",
);

for (const fragment of [
    `ARG COLLABORA_BASE=${collaboraRuntime}`,
    `ARG PATCHER_BASE=${patcherRuntime}`,
    "FROM ${COLLABORA_BASE} AS upstream",
    "FROM ${PATCHER_BASE} AS patcher",
    `COPY --from=upstream ${bundlePath} /tmp/bundle.js`,
    "RUN perl /tmp/patch-smartmenus-lifecycle.pl /tmp/bundle.js",
    "FROM upstream",
    `COPY --from=patcher /tmp/bundle.js ${bundlePath}`,
]) {
    assert.equal(
        dockerfile.split(fragment).length - 1,
        1,
        `expected one Dockerfile contract fragment: ${fragment}`,
    );
}

for (const fragment of [
    "this._onDocLayerInit();\n+\t\t\treturn;",
    "if ($mainMenu.data('smartmenus'))\n+\t\t\t$mainMenu.smartmenus('destroy');",
    "-\t\t$('#main-menu').smartmenus({\n+\t\t$mainMenu.smartmenus({",
]) {
    assert.ok(sourcePatch.includes(fragment), `missing source fix: ${fragment}`);
}
assert.equal(
    sourcePatch.split("$mainMenu.smartmenus('destroy')").length - 1,
    2,
    "source must destroy SmartMenus before rebuild and remove",
);
assert.doesNotMatch(sourcePatch, /Office\.vue|waitForTimeout|force:\s*true|retry/i);

for (const fragment of [
    "expected one upstream fragment",
    "this._onDocLayerInit();return",
    '$mainMenu.data("smartmenus"))$mainMenu.smartmenus("destroy")',
    "$mainMenu.smartmenus({hideOnClick:true",
]) {
    assert.ok(bundlePatch.includes(fragment), `missing bundle fix: ${fragment}`);
}

for (const fragment of [
    `COLLABORA_BASE: ${collaboraRuntime}`,
    `COLLABORA_SOURCE_REF: ${collaboraSourceRef}`,
    `COLLABORA_SOURCE_SHA256: ${collaboraSourceSha256}`,
    "platforms: linux/amd64,linux/arm64",
    "node ci/test-collabora-image-runtime.mjs --verify-source",
    "node ci/test-collabora-image-runtime.mjs --verify-final-image",
]) {
    assert.ok(imageWorkflow.includes(fragment), `missing workflow contract: ${fragment}`);
}

const demoValues = fs.readFileSync("helmfile/demo-values.yaml.tmpl", "utf8");
const deployScript = fs.readFileSync(
    "scripts/single-vps-deploy/01-deploy.sh",
    "utf8",
);
const convergenceCheck = fs.readFileSync("ci/convergence-check.sh", "utf8");
for (const fragment of [
    '  collabora:\n    registry: "ghcr.io"\n    repository: "open-suite/collabora"\n' +
        '    tag: "${COLLABORA_TAG}"',
    "MEET_TAG ELEMENT_TAG COLLABORA_TAG KC_BACKCHANNEL",
]) {
    assert.ok(demoValues.includes(fragment), `missing demo values contract: ${fragment}`);
}
for (const fragment of [
    `COLLABORA_TAG="\${COLLABORA_TAG:-${openSuiteImageTag}}"`,
    "export DOMAIN TLS_SELF_SIGNED INGRESS_ANNOTATIONS NEXTCLOUD_TAG PORTAL_SHA MEET_TAG ELEMENT_TAG COLLABORA_TAG KC_BACKCHANNEL",
    "${ELEMENT_TAG} ${COLLABORA_TAG} ${KC_BACKCHANNEL}",
]) {
    assert.ok(deployScript.includes(fragment), `missing deploy pin contract: ${fragment}`);
}
for (const fragment of [
    `EXPECTED_COLLABORA_TAG="\${COLLABORA_TAG:-${openSuiteImageTag}}"`,
    'ghcr.io/open-suite/collabora:${EXPECTED_COLLABORA_TAG}',
    "collabora_image",
]) {
    assert.ok(convergenceCheck.includes(fragment), `missing convergence contract: ${fragment}`);
}

for (const smokeFile of [
    "ci/smoke/authenticated.mjs",
    "ci/smoke/visual-transitions.mjs",
]) {
    const smoke = fs.readFileSync(smokeFile, "utf8");
    assert.equal(
        smoke.split('locator("#menu-insert > a").click').length - 1,
        1,
        `${smokeFile} must click the Insert menu exactly once`,
    );
    assert.equal(
        smoke.split('locator("#menu-insertgraphicremote > a").click').length - 1,
        1,
        `${smokeFile} must click the exact remote-image leaf exactly once`,
    );
    assert.doesNotMatch(
        smoke,
        /getByText\(\/\^\(Image\|Image\\\.\\\.\\\.\|Insert Image\)/,
        `${smokeFile} must not select a translated image label`,
    );
}

function count(haystack, needle) {
    return haystack.split(needle).length - 1;
}

function assertLifecycle(contents, compiled) {
    const initialCall = compiled
        ? "this._onDocLayerInit();return"
        : "this._onDocLayerInit();\n\t\t\treturn;";
    const destroy = compiled
        ? '$mainMenu.smartmenus("destroy")'
        : "$mainMenu.smartmenus('destroy')";
    const clear = compiled
        ? "removeChildNodes(this._menubarCont)"
        : "window.L.DomUtil.removeChildNodes(this._menubarCont)";
    const initialize = compiled
        ? "$mainMenu.smartmenus({hideOnClick:true"
        : "$mainMenu.smartmenus({";
    const remove = compiled
        ? "_a=this._menubarCont"
        : "this._menubarCont?.remove()";

    assert.equal(count(contents, initialCall), 1, "initial refresh must return once");
    assert.equal(count(contents, destroy), 2, "expected exactly two lifecycle destroys");
    assert.equal(count(contents, initialize), 1, "expected exactly one initialization site");

    const refreshStart = contents.indexOf(
        compiled ? "Menubar.prototype._onRefresh=function" : "private _onRefresh(): void",
    );
    const refreshEnd = contents.indexOf(
        compiled ? "Menubar.prototype._bindEventIfNotBound" : "private _bindEventIfNotBound",
        refreshStart,
    );
    const refresh = contents.slice(refreshStart, refreshEnd);
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "refresh function bounds");
    assert.ok(
        refresh.indexOf(destroy) < refresh.indexOf(clear),
        "SmartMenus must be destroyed while the old subtree is intact",
    );
    assert.ok(
        refresh.indexOf(clear) < refresh.indexOf(initialize),
        "the replacement must initialize after the subtree rebuild",
    );

    const removeStart = contents.indexOf(
        compiled ? "Menubar.prototype.onRemove=function" : "onRemove(): void",
    );
    const removeEnd = contents.indexOf(
        compiled ? "Menubar.prototype._addMenu" : "private _addMenu",
        removeStart,
    );
    const onRemove = contents.slice(removeStart, removeEnd);
    assert.ok(removeStart >= 0 && removeEnd > removeStart, "onRemove function bounds");
    assert.ok(
        onRemove.indexOf(destroy) < onRemove.indexOf(remove),
        "SmartMenus must be destroyed before its container is removed",
    );
}

function runContainerEngine(args) {
    const [command, ...prefix] = (
        process.env.COLLABORA_CONTAINER_ENGINE ?? "docker"
    ).split(/\s+/);
    return execFileSync(command, [...prefix, ...args], { encoding: "utf8" });
}

function inspectImage(image) {
    const inspected = JSON.parse(runContainerEngine(["image", "inspect", image]));
    assert.equal(inspected.length, 1, `expected one image inspection for ${image}`);
    return inspected[0];
}

function copyBundle(image, destination) {
    const container = runContainerEngine([
        "create",
        "--platform=linux/amd64",
        "--entrypoint=/bin/true",
        image,
    ]).trim();
    try {
        runContainerEngine(["cp", `${container}:${bundlePath}`, destination]);
    } finally {
        runContainerEngine(["rm", "--force", container]);
    }
}

function sha256(file) {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifyRenderedValues(valuesFile, expectedTag) {
    const values = fs.readFileSync(valuesFile, "utf8");
    const image = [
        "  collabora:",
        '    registry: "ghcr.io"',
        '    repository: "open-suite/collabora"',
        `    tag: "${expectedTag}"`,
    ].join("\n");
    assert.equal(count(values, image), 1, "rendered values must pin one Collabora image");
    assert.doesNotMatch(values, /\$\{COLLABORA_TAG\}/, "Collabora tag was not rendered");
    console.log(`${valuesFile}: rendered Collabora image ${expectedTag} verified`);
}

function verifyInfra(infraRoot) {
    const chartRoot = path.join(
        infraRoot,
        "helmfile/apps/collabora/charts/collabora",
    );
    const appValues = fs.readFileSync(
        path.join(infraRoot, "helmfile/apps/collabora/values-collabora.yaml.gotmpl"),
        "utf8",
    );
    for (const fragment of [
        "registry: {{ coalesce .Values.container.collabora.registry .Values.container.default.registry | quote }}",
        "repository: {{ .Values.container.collabora.repository }}",
        "tag: {{ .Values.container.collabora.tag }}",
    ]) {
        assert.ok(appValues.includes(fragment), `missing upstream image value contract: ${fragment}`);
    }

    const exactTemplates = {
        "templates/service.yaml":
            "76d89341dd4aa731075685b71a84c9cb564580f5ab0ee07b1654a1daae7de7e7",
        "templates/deployment.yaml":
            "927e7dadfa886ddb5cc67593f09e45c4166b0c5a1461ccf1446a598c78a1a51d",
        "templates/_helpers.tpl":
            "444d3c2f3f84e0e767dfae8c92ea5e04e73e2f72ca40a007fdc7eea3ebcd87d1",
    };
    for (const [relative, digest] of Object.entries(exactTemplates)) {
        assert.equal(
            sha256(path.join(chartRoot, relative)),
            digest,
            `${relative} drifted from the pinned chart contract`,
        );
    }
    console.log(`${infraRoot}: Collabora image, Deployment, and Service contracts verified`);
}

function verifySource(sourceFile) {
    const source = fs.readFileSync(sourceFile, "utf8");
    assertLifecycle(source, false);
    console.log(`${sourceFile}: source lifecycle contract verified`);
}

function verifyFinalImage(runtime, candidate) {
    assert.equal(runtime, collaboraRuntime, "verification must use the pinned runtime");
    runContainerEngine(["pull", "--platform", "linux/amd64", runtime]);

    const upstream = inspectImage(runtime);
    const finalImage = inspectImage(candidate);
    assert.equal(upstream.Architecture, "amd64", "upstream architecture");
    assert.equal(finalImage.Architecture, "amd64", "candidate architecture");

    for (const field of [
        "Env",
        "Entrypoint",
        "Cmd",
        "User",
        "WorkingDir",
        "ExposedPorts",
        "StopSignal",
        "Volumes",
        "Healthcheck",
    ]) {
        assert.deepEqual(
            finalImage.Config[field] ?? null,
            upstream.Config[field] ?? null,
            `candidate Config.${field} differs from upstream`,
        );
    }
    for (const [label, value] of Object.entries(upstream.Config.Labels ?? {})) {
        assert.equal(finalImage.Config.Labels?.[label], value, `upstream label ${label}`);
    }

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "collabora-contract-"));
    try {
        const upstreamBundle = path.join(temporary, "upstream-bundle.js");
        const candidateBundle = path.join(temporary, "candidate-bundle.js");
        copyBundle(runtime, upstreamBundle);
        copyBundle(candidate, candidateBundle);
        assert.equal(sha256(upstreamBundle), upstreamBundleSha256, "upstream bundle digest");
        assert.equal(sha256(candidateBundle), patchedBundleSha256, "patched bundle digest");
        execFileSync(process.execPath, ["--check", candidateBundle]);
        assertLifecycle(fs.readFileSync(candidateBundle, "utf8"), true);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
    console.log("linux/amd64: inherited image config and patched runtime bundle verified");
}

if (process.argv[2] === "--verify-source") {
    assert.equal(
        process.argv.length,
        4,
        "usage: test-collabora-image-runtime.mjs --verify-source SOURCE_FILE",
    );
    verifySource(process.argv[3]);
} else if (process.argv[2] === "--verify-rendered-values") {
    assert.equal(
        process.argv.length,
        5,
        "usage: test-collabora-image-runtime.mjs --verify-rendered-values VALUES_FILE EXPECTED_TAG",
    );
    verifyRenderedValues(...process.argv.slice(3));
} else if (process.argv[2] === "--verify-infra") {
    assert.equal(
        process.argv.length,
        4,
        "usage: test-collabora-image-runtime.mjs --verify-infra INFRA_ROOT",
    );
    verifyInfra(process.argv[3]);
} else if (process.argv[2] === "--verify-final-image") {
    assert.equal(
        process.argv.length,
        5,
        "usage: test-collabora-image-runtime.mjs --verify-final-image RUNTIME CANDIDATE",
    );
    verifyFinalImage(...process.argv.slice(3));
} else {
    assert.equal(process.argv.length, 2, "unknown arguments");
    console.log("Collabora image source, bundle, workflow, deployment, and smoke contracts verified");
}
