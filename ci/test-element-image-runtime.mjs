import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const dockerfile = fs.readFileSync("images/element/Dockerfile", "utf8");
const imageWorkflow = fs.readFileSync(
    ".github/workflows/element-image.yaml",
    "utf8",
);
const elementRuntime =
    "registry-1.docker.io/vectorim/element-web:v1.12.24-rc.1@sha256:a72c9310c08ebc7c4cb4fb91911b1363e529834e031468130eb75cea90027064";
const elementRuntimePlatforms = {
    "linux/amd64":
        "registry-1.docker.io/vectorim/element-web@sha256:a26bdc3bec8cad42ad3fafa180386706f99d8a6be41e6f1d775292b820a2597b",
    "linux/arm64":
        "registry-1.docker.io/vectorim/element-web@sha256:ceb899e0face56a6ad8196e458c9c45ad7e8446235b623df1893cd653611bd50",
};
const patcherRuntime =
    "registry-1.docker.io/library/perl:5-slim@sha256:d9e618def9ecf01ac2aafdf1ee39e6ea42833ae84a947b9feb44a677382f3f81";

// Flattening the upstream runtime avoids publishing both the original and
// patched /app trees. A scratch stage does not inherit image configuration, so
// guard every security/readiness-relevant part of the pinned upstream contract.
for (const fragment of [
    `ARG ELEMENT_BASE=${elementRuntime}`,
    `ARG PATCHER_BASE=${patcherRuntime}`,
    "FROM ${PATCHER_BASE} AS patcher",
    "FROM upstream AS runtime-files",
    "RUN rm -rf /app",
    "FROM scratch",
    "COPY --from=runtime-files / /",
    "COPY --from=patcher /app /app",
    "COPY patch-sso-history.sh /tmp/patch-sso-history.sh",
    "&& sh /tmp/patch-sso-history.sh /app",
    "ELEMENT_WEB_PORT=80",
    "EXPOSE 8080",
    "STOPSIGNAL SIGQUIT",
    "WORKDIR /",
    "USER nginx",
    'LABEL maintainer="NGINX Docker Maintainers <docker-maint@nginx.com>"',
    "HEALTHCHECK --start-period=5s CMD wget -q --spider http://localhost:$ELEMENT_WEB_PORT/config.json",
    'ENTRYPOINT ["/docker-entrypoint.sh"]',
    'CMD ["nginx", "-g", "daemon off;"]',
]) {
    assert.equal(
        dockerfile.split(fragment).length - 1,
        1,
        `expected exactly one Dockerfile runtime contract fragment: ${fragment}`,
    );
}
assert.doesNotMatch(
    dockerfile.slice(dockerfile.lastIndexOf("FROM scratch")),
    /^FROM\s+\$\{?ELEMENT_BASE/m,
    "the final image must not re-introduce upstream's original /app layer",
);
assert.ok(
    imageWorkflow.includes(`ELEMENT_BASE: ${elementRuntime}`),
    "the image workflow must pin the verified Element multi-arch index",
);
assert.equal(
    imageWorkflow.split("ELEMENT_BASE=${{ env.ELEMENT_BASE }}").length - 1,
    3,
    "each contract/release build must use the pinned workflow runtime",
);

const startupProbePatch = fs.readFileSync(
    "patches/local/synapse-startup-probe.patch",
    "utf8",
);
for (const fragment of [
    "startupProbe:",
    "enabled: true",
    "-    initialDelaySeconds: 15",
    "+    initialDelaySeconds: 5",
    "+    periodSeconds: 5",
    "+    timeoutSeconds: 2",
    "+    failureThreshold: 7",
]) {
    assert.ok(
        startupProbePatch.includes(fragment),
        `missing Synapse probe guard: ${fragment}`,
    );
}

const oldFailureDeadlineSeconds = 15 + 5 * (5 - 1);
const newFailureDeadlineSeconds = 5 + 5 * (7 - 1);
assert.equal(
    newFailureDeadlineSeconds,
    oldFailureDeadlineSeconds,
    "earlier probing must retain the existing startup failure deadline",
);

for (const benchmark of [
    "images/element/benchmark-element-browser.mjs",
    "images/element/benchmark-element-container.mjs",
    "images/element/benchmark-element-first-sync.mjs",
]) {
    execFileSync(process.execPath, ["--check", benchmark]);
}

const imageConfigFields = [
    "Env",
    "Entrypoint",
    "Cmd",
    "User",
    "WorkingDir",
    "ExposedPorts",
    "StopSignal",
    "Volumes",
];
const expectedHealthcheck = {
    Test: [
        "CMD-SHELL",
        "wget -q --spider http://localhost:$ELEMENT_WEB_PORT/config.json",
    ],
    StartPeriod: 5_000_000_000,
};

function runContainerEngine(args) {
    const [command, ...prefix] = (
        process.env.ELEMENT_CONTAINER_ENGINE ?? "docker"
    ).split(/\s+/);
    return execFileSync(command, [...prefix, ...args], {
        encoding: "utf8",
    });
}

function inspectImage(image) {
    const inspected = JSON.parse(
        runContainerEngine(["image", "inspect", image]),
    );
    assert.equal(inspected.length, 1, `expected one image inspection for ${image}`);
    return inspected[0];
}

function normalizedConfigValue(config, field) {
    return config[field] ?? null;
}

function verifyHealthcheck(upstreamConfig, candidateConfig, platform) {
    const upstreamHealthcheck = upstreamConfig.Healthcheck;
    const candidateHealthcheck = candidateConfig.Healthcheck;
    assert.ok(
        upstreamHealthcheck,
        `${platform}: pinned upstream lost its expected healthcheck`,
    );
    assert.ok(
        candidateHealthcheck,
        `${platform}: final image lost its healthcheck`,
    );
    assert.deepEqual(
        candidateHealthcheck,
        upstreamHealthcheck,
        `${platform}: final image Healthcheck differs from upstream`,
    );
    assert.deepEqual(
        candidateHealthcheck.Test,
        expectedHealthcheck.Test,
        `${platform}: healthcheck command drifted`,
    );
    assert.equal(
        candidateHealthcheck.StartPeriod,
        expectedHealthcheck.StartPeriod,
        `${platform}: healthcheck start period drifted`,
    );
    for (const [field, value] of Object.entries(candidateHealthcheck)) {
        if (field === "Test" || field === "StartPeriod") continue;
        assert.equal(value, 0, `${platform}: unexpected Healthcheck.${field}`);
    }
}

function verifyLabels(upstreamConfig, candidateConfig, platform) {
    const upstreamLabels = upstreamConfig.Labels ?? {};
    const candidateLabels = candidateConfig.Labels ?? {};

    for (const [label, value] of Object.entries(upstreamLabels)) {
        assert.ok(
            Object.hasOwn(candidateLabels, label),
            `${platform}: final image lost upstream label ${label}`,
        );
        if (!label.startsWith("org.opencontainers.image.")) {
            assert.equal(
                candidateLabels[label],
                value,
                `${platform}: upstream label ${label} drifted`,
            );
        }
    }
    for (const label of Object.keys(candidateLabels)) {
        assert.ok(
            Object.hasOwn(upstreamLabels, label) ||
                label.startsWith("org.opencontainers.image."),
            `${platform}: unexpected non-OCI label ${label}`,
        );
    }
}

function verifyConfig(upstream, candidate, platform, architecture) {
    assert.equal(upstream.Os, "linux", `${platform}: upstream OS`);
    assert.equal(candidate.Os, "linux", `${platform}: candidate OS`);
    assert.equal(
        upstream.Architecture,
        architecture,
        `${platform}: upstream architecture`,
    );
    assert.equal(
        candidate.Architecture,
        architecture,
        `${platform}: candidate architecture`,
    );

    for (const field of imageConfigFields) {
        assert.deepEqual(
            normalizedConfigValue(candidate.Config, field),
            normalizedConfigValue(upstream.Config, field),
            `${platform}: final image Config.${field} differs from upstream`,
        );
    }
    verifyHealthcheck(upstream.Config, candidate.Config, platform);
    verifyLabels(upstream.Config, candidate.Config, platform);
}

function verifyImageContents(upstreamImage, candidateImage, platform) {
    const runArgs = [
        "run",
        "--rm",
        `--platform=${platform}`,
        "--network=none",
        "--user=0",
        "--entrypoint=sh",
    ];
    const upstreamSymlink = runContainerEngine([
        ...runArgs,
        upstreamImage,
        "-ec",
        "test -L /etc/nginx/modules; readlink /etc/nginx/modules",
    ]).trim();
    const candidateSymlink = runContainerEngine([
        ...runArgs,
        candidateImage,
        "-ec",
        "test -L /etc/nginx/modules; readlink /etc/nginx/modules",
    ]).trim();
    assert.equal(
        candidateSymlink,
        upstreamSymlink,
        `${platform}: /etc/nginx/modules symlink drifted`,
    );

    const contentResult = runContainerEngine([
        ...runArgs,
        candidateImage,
        "-ec",
        String.raw`
bundle_count="$(find /app/bundles -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
test "$bundle_count" -eq 1
bundle_name="$(basename "$(find /app/bundles -mindepth 1 -maxdepth 1 -type d)")"
gzip_count="$(find /app -type f -name '*.gz' | wc -l | tr -d ' ')"
test "$gzip_count" -gt 0
init_js="$(find /app/bundles -name init.js)"
test "$(printf '%s\n' "$init_js" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 1
grep -F 'window.location.replace(e.getSsoLoginUrl(o.toString(),t,r,i))' "$init_js" >/dev/null
! grep -F 'window.location.href=e.getSsoLoginUrl(o.toString(),t,r,i)' "$init_js" >/dev/null
find /app -type f -name '*.gz' -print0 | xargs -0 gzip -t
printf 'bundle=%s gzip=%s' "$bundle_name" "$gzip_count"
`,
    ]).trim();
    console.log(
        `${platform}: config, labels, one app bundle, symlink (${candidateSymlink}), and ${contentResult} verified`,
    );
}

async function verifyAmd64Nginx(candidateImage) {
    const containerName = `element-runtime-contract-${process.pid}`;
    runContainerEngine([
        "run",
        "--detach",
        "--platform=linux/amd64",
        "--cap-add=NET_BIND_SERVICE",
        "--name",
        containerName,
        candidateImage,
    ]);
    try {
        let healthy = false;
        for (let attempt = 0; attempt < 40; attempt += 1) {
            try {
                runContainerEngine([
                    "exec",
                    containerName,
                    "sh",
                    "-ec",
                    "wget -q --spider http://localhost:$ELEMENT_WEB_PORT/config.json",
                ]);
                healthy = true;
                break;
            } catch {
                await delay(250);
            }
        }
        assert.ok(healthy, "linux/amd64: image healthcheck command did not pass");
        runContainerEngine(["exec", containerName, "nginx", "-t"]);
        const config = JSON.parse(
            runContainerEngine([
                "exec",
                containerName,
                "sh",
                "-ec",
                "wget -qO- http://localhost:$ELEMENT_WEB_PORT/config.json",
            ]),
        );
        assert.equal(typeof config, "object", "config.json must be a JSON object");
        assert.notEqual(config, null, "config.json must be a JSON object");
        console.log(
            "linux/amd64: nginx -t, image healthcheck command, and config.json verified",
        );
    } finally {
        runContainerEngine(["rm", "--force", containerName]);
    }
}

async function verifyFinalImages(runtime, amd64Candidate, arm64Candidate) {
    assert.equal(runtime, elementRuntime, "verification must use the pinned runtime");
    for (const [platform, architecture, candidate] of [
        ["linux/amd64", "amd64", amd64Candidate],
        ["linux/arm64", "arm64", arm64Candidate],
    ]) {
        const platformRuntime = elementRuntimePlatforms[platform];
        runContainerEngine(["pull", "--platform", platform, platformRuntime]);
        const upstream = inspectImage(platformRuntime);
        assert.equal(
            upstream.Architecture,
            architecture,
            `${platform}: pull selected the wrong upstream platform`,
        );
        const upstreamTag = `local/element-web-upstream-contract:${architecture}-${process.pid}`;
        runContainerEngine(["tag", upstream.Id, upstreamTag]);
        const finalImage = inspectImage(candidate);
        verifyConfig(upstream, finalImage, platform, architecture);
        verifyImageContents(upstreamTag, candidate, platform);
    }
    await verifyAmd64Nginx(amd64Candidate);
}

if (process.argv[2] === "--verify-final-images") {
    assert.equal(
        process.argv.length,
        6,
        "usage: test-element-image-runtime.mjs --verify-final-images RUNTIME AMD64 ARM64",
    );
    await verifyFinalImages(...process.argv.slice(3));
}
