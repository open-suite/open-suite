import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export const parseMode = (value = "") => value.trim().toLowerCase() === "enforce" ? "enforce" : "baseline";

export function sanitizeUrl(input) {
  try {
    const url = new URL(input);
    const keys = [...new Set([...url.searchParams.keys()])].sort();
    url.search = keys.length ? `?${keys.map((key) => `${encodeURIComponent(key)}=<redacted>`).join("&")}` : "";
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    url.hash = url.hash
      ? `#${url.hash.slice(1).split("?")[0].replace(/(loginToken|access_token|code|token)=[^/&]+/gi, "$1=<redacted>")}`
      : "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

export function sameDeepLink(actual, expected, base) {
  try {
    const left = new URL(actual, base);
    const right = new URL(expected, base);
    return left.origin === right.origin && left.pathname === right.pathname
      && left.search === right.search && left.hash === right.hash;
  } catch {
    return false;
  }
}

const whiteboard = /\.(whiteboard|drawio)$/i;
const office = /\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i;
export const classifyFile = (name = "") => whiteboard.test(name) ? "whiteboard" : office.test(name) ? "office" : "other";

export function chooseCandidate(names, fixture, kind) {
  if (fixture) return names.includes(fixture) && classifyFile(fixture) === kind ? fixture : null;
  return [...names].sort((a, b) => a.localeCompare(b)).find((name) => classifyFile(name) === kind) ?? null;
}

export function contractOutcome({ mode, exists = true, observations = [], blocking = [] }) {
  const hard = observations.filter((item) => item.hard && !item.ok);
  if (!exists) {
    return {
      classification: hard.length || mode === "enforce" ? "failed" : "uncontracted/missing",
      failed: hard.length > 0 || mode === "enforce",
    };
  }
  const contract = blocking.filter((item) => !item.ok);
  return {
    classification: hard.length ? "failed" : contract.length ? (mode === "enforce" ? "failed" : "observed-not-passed") : "passed",
    failed: hard.length > 0 || (mode === "enforce" && contract.length > 0),
  };
}

export async function enforceArtifactBudget(directory, maxBytes = 75 * 1024 * 1024) {
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    return (await Promise.all(entries.map(async (entry) => {
      const name = path.join(current, entry.name);
      return entry.isDirectory() ? walk(name) : [{ name, size: await stat(name).then((value) => value.size).catch(() => 0) }];
    }))).flat();
  };
  const files = await walk(directory);
  // Remove largest captures first; report.json is tiny and remains useful.
  files.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const removed = [];
  for (const file of files) {
    if (total <= maxBytes) break;
    await rm(file.name, { force: true });
    total -= file.size;
    removed.push(file.name);
  }
  return { total, removed };
}
