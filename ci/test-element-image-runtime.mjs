import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const dockerfile = fs.readFileSync("images/element/Dockerfile", "utf8");

// Flattening the upstream runtime avoids publishing both the original and
// patched /app trees. A scratch stage does not inherit image configuration, so
// guard every security/readiness-relevant part of the pinned upstream contract.
for (const fragment of [
    "FROM upstream AS runtime-files",
    "RUN rm -rf /app",
    "FROM scratch",
    "COPY --from=runtime-files / /",
    "COPY --from=patcher /app /app",
    "ELEMENT_WEB_PORT=80",
    "EXPOSE 8080",
    "STOPSIGNAL SIGQUIT",
    "WORKDIR /",
    "USER nginx",
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
