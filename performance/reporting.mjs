import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);

export const parsePositiveInteger = (value, fallback, name) => {
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

export const parseNonNegativeNumber = (value, fallback, name) => {
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`${name} must be a non-negative number`);
  }
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
};

export const sanitizeUrl = (value) => {
  try {
    const url = new URL(value);
    if (url.origin === "null") {
      return url.protocol === "about:" ? `${url.protocol}${url.pathname}` : null;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
};

export const quantile = (values, fraction) => {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];

  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
};

export const summarizeValues = (values) => {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) {
    return {
      n: 0,
      min: null,
      p25: null,
      p50: null,
      p75: null,
      p95: null,
      max: null,
      iqr: null,
      mad: null,
      scaledMad: null,
      robustCv: null,
    };
  }

  const p25 = quantile(finite, 0.25);
  const p50 = quantile(finite, 0.5);
  const p75 = quantile(finite, 0.75);
  const mad = quantile(
    finite.map((value) => Math.abs(value - p50)),
    0.5,
  );
  const scaledMad = 1.4826 * mad;

  return {
    n: finite.length,
    min: Math.min(...finite),
    p25,
    p50,
    p75,
    p95: quantile(finite, 0.95),
    max: Math.max(...finite),
    iqr: p75 - p25,
    mad,
    scaledMad,
    robustCv: p50 === 0 ? null : scaledMad / Math.abs(p50),
  };
};

export const summarizeRuns = (runs) => {
  const keys = [
    ...new Set(
      runs.flatMap((run) =>
        Object.entries(run.metrics)
          .filter(([, value]) => Number.isFinite(value))
          .map(([key]) => key),
      ),
    ),
  ];
  return Object.fromEntries(
    keys.map((key) => [
      key,
      summarizeValues(runs.map((run) => run.metrics[key])),
    ]),
  );
};

const gitValue = (args) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

export const captureEnvironment = ({
  browser = "chromium",
  browserVersion,
  headless = true,
  viewport,
  locale,
  timezone,
  runnerLabel,
  runnerRegion,
}) => {
  const cpu = os.cpus()[0];
  const playwrightVersion = browser
    ? require("playwright/package.json").version
    : null;
  const gitStatus = gitValue(["status", "--porcelain"]);
  return {
    runnerLabel,
    runnerRegion,
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    logicalCpus: os.cpus().length,
    cpuModel: cpu?.model ?? null,
    totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
    nodeVersion: process.version,
    playwrightVersion,
    browser,
    browserVersion,
    headless,
    viewport,
    locale,
    timezone,
    gitRevision: gitValue(["rev-parse", "HEAD"]),
    gitDirty: gitStatus === null ? null : gitStatus !== "",
  };
};
