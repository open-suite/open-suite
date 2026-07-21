import fs from "node:fs";
import { performance } from "node:perf_hooks";

const baseUrl = new URL(
  process.env.ELEMENT_SYNAPSE_URL || "http://127.0.0.1:18008",
);
const tokenFile = process.env.ELEMENT_SYNAPSE_ADMIN_TOKEN_FILE;
const roomId = process.env.ELEMENT_SYNAPSE_ROOM_ID;
const serverName =
  process.env.ELEMENT_SYNAPSE_SERVER_NAME || "matrix.profile.test";
const samples = Number(process.env.ELEMENT_SYNC_SAMPLES || 10);
const pacingMs = Number(process.env.ELEMENT_SYNC_PACING_MS || 700);
const output =
  process.env.ELEMENT_BENCHMARK_OUTPUT || "/tmp/element-first-sync.json";

if (!["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname)) {
  throw new Error("This destructive synthetic-user benchmark is restricted to loopback Synapse instances");
}
if (!tokenFile || !roomId) {
  throw new Error("Set ELEMENT_SYNAPSE_ADMIN_TOKEN_FILE and ELEMENT_SYNAPSE_ROOM_ID");
}
if (!Number.isInteger(samples) || samples < 1 || !Number.isFinite(pacingMs) || pacingMs < 0) {
  throw new Error("samples must be positive and pacing must be non-negative");
}

const adminToken = fs.readFileSync(tokenFile, "utf8").trim();
const timedJson = async (url, options) => {
  const started = performance.now();
  const response = await fetch(new URL(url, baseUrl), options);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} from ${new URL(url, baseUrl).pathname}: ${body.slice(0, 160)}`);
  }
  return { body: JSON.parse(body), ms: performance.now() - started };
};
const jsonHeaders = (token) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

const runs = [];
const prefix = `sync${Date.now().toString(36)}${process.pid}`;
for (let sample = 1; sample <= samples; sample += 1) {
  const userId = `@${prefix}-${sample}:${serverName}`;
  const encodedUserId = encodeURIComponent(userId);
  const create = await timedJson(`/_synapse/admin/v2/users/${encodedUserId}`, {
    method: "PUT",
    headers: jsonHeaders(adminToken),
    body: JSON.stringify({ displayname: `Sync sample ${sample}` }),
  });
  const login = await timedJson(
    `/_synapse/admin/v1/users/${encodedUserId}/login`,
    {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: "{}",
    },
  );
  const userToken = login.body.access_token;
  const join = await timedJson(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
    method: "POST",
    headers: jsonHeaders(userToken),
    body: "{}",
  });
  const filter = encodeURIComponent(
    JSON.stringify({
      room: { state: { lazy_load_members: true }, timeline: { limit: 20 } },
    }),
  );
  const sync = await timedJson(
    `/_matrix/client/v3/sync?timeout=0&filter=${filter}`,
    { headers: jsonHeaders(userToken) },
  );
  const joinedRooms = Object.values(sync.body.rooms?.join ?? {});
  const result = {
    sample,
    create_user_ms: create.ms,
    issue_access_token_ms: login.ms,
    autojoin_ms: join.ms,
    initial_sync_ms: sync.ms,
    initial_sync_bytes: Buffer.byteLength(JSON.stringify(sync.body)),
    joined_rooms: joinedRooms.length,
    timeline_events: joinedRooms.reduce(
      (total, room) => total + (room.timeline?.events?.length ?? 0),
      0,
    ),
  };
  runs.push(result);
  console.log(
    `sync ${sample}/${samples}: create=${create.ms.toFixed(1)}ms autojoin=${join.ms.toFixed(1)}ms sync=${sync.ms.toFixed(1)}ms`,
  );
  await new Promise((resolve) => setTimeout(resolve, pacingMs));
}

const quantile = (values, fraction) => {
  const sorted = values.slice().sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};
const summarize = (values) => {
  const median = quantile(values, 0.5);
  const p25 = quantile(values, 0.25);
  const p75 = quantile(values, 0.75);
  return {
    n: values.length,
    min: Math.min(...values),
    p25,
    p50: median,
    p75,
    p95: quantile(values, 0.95),
    max: Math.max(...values),
    iqr: p75 - p25,
    mad: quantile(values.map((value) => Math.abs(value - median)), 0.5),
  };
};
const metricNames = [
  "create_user_ms",
  "issue_access_token_ms",
  "autojoin_ms",
  "initial_sync_ms",
  "initial_sync_bytes",
];
const report = {
  benchmark: "element-post-verified-identity-first-sync",
  captured_at: new Date().toISOString(),
  target: baseUrl.origin,
  profile: "unique user; admin-issued access token as a local post-OIDC proxy; one pre-seeded room; lazy members; timeline limit 20",
  note: "This isolates Synapse account/autojoin/initial-sync work; it does not measure the external OIDC authorization and token exchange.",
  summary: Object.fromEntries(
    metricNames.map((metric) => [metric, summarize(runs.map((run) => run[metric]))]),
  ),
  runs,
};
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
