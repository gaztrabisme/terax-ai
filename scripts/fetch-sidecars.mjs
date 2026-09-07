// Downloads the pi and agent sidecar binaries from their GitHub releases and
// verifies each against the release's SHA256SUMS. Node 22, no dependencies
// (uses global fetch, which follows redirects). Pair it with
// scripts/prepare-sidecars.mjs, which stages the files where tauri-build
// expects them:
//
//   node scripts/fetch-sidecars.mjs [--triple <t>] [--dest <dir>]
//   node scripts/prepare-sidecars.mjs --pi <pi-path> --agent <agent-path> ...
//
// The pi binary comes from the Dicklesworthstone/pi_agent_rust release tagged
// v<pi-version>; the agent binary comes from the gaztrabisme/harness release
// tagged <agent-version>. The two paths are printed as the last two stdout
// lines. A checksum mismatch exits with code 3; a failed download is retried
// once. No secrets are involved: both releases are public.
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const PI_RELEASE_URL = "https://github.com/Dicklesworthstone/pi_agent_rust/releases/download";
const AGENT_RELEASE_URL = "https://github.com/gaztrabisme/harness/releases/download";
const DEFAULT_PI_VERSION = "0.3.0"; // pi release tag becomes v0.3.0
const DEFAULT_AGENT_VERSION = "v0.1.0"; // harness release tag, used verbatim
const CHECKSUM_FILE = "SHA256SUMS";

// pi release asset per target triple.
const PI_ASSETS = {
  "aarch64-apple-darwin": "pi_darwin_arm64",
  "x86_64-apple-darwin": "pi_darwin_amd64",
  "x86_64-unknown-linux-gnu": "pi_linux_amd64",
  "aarch64-unknown-linux-gnu": "pi_linux_arm64",
  "x86_64-pc-windows-msvc": "pi_windows_amd64.exe",
};

function usage() {
  console.log(`Usage: node scripts/fetch-sidecars.mjs [options]
  --triple <t>         target triple (default: host triple)
  --dest <dir>         download directory (default: a fresh temp dir)
  --pi-version <v>     pi release version, tag v<v> (default: ${DEFAULT_PI_VERSION})
  --agent-version <v>  agent release tag (default: ${DEFAULT_AGENT_VERSION})
  --help               print this help and exit

Prints the downloaded pi and agent binary paths as the last two stdout lines.`);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--triple") {
      opts.triple = requireValue(argv, ++i, arg);
    } else if (arg === "--dest") {
      opts.dest = requireValue(argv, ++i, arg);
    } else if (arg === "--pi-version") {
      opts.piVersion = requireValue(argv, ++i, arg);
    } else if (arg === "--agent-version") {
      opts.agentVersion = requireValue(argv, ++i, arg);
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function requireValue(argv, i, flag) {
  if (i >= argv.length) fail(`${flag} needs a value`);
  return argv[i];
}

function fail(message) {
  console.error(`fetch-sidecars: ${message}`);
  process.exit(1);
}

// Host triple for the release asset names. Same order as prepare-sidecars:
// rustc -vV's host first, then a platform/arch mapping, then fail.
function detectTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const host = out.split("\n").find((l) => l.startsWith("host:"));
    const triple = host?.slice("host:".length).trim();
    if (triple) return triple;
  } catch {
    // rustc missing or not runnable: fall through to the mapping.
  }
  const known = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  const key = `${process.platform}-${process.arch}`;
  const triple = known[key];
  if (!triple) {
    fail(`cannot detect the host triple for ${key}; pass --triple <t> explicitly`);
  }
  return triple;
}

function exeSuffix(triple) {
  return triple.includes("windows") ? ".exe" : "";
}

// Downloads url to dest, retrying once on any failure. Progress-free on
// purpose: stdout stays clean so the last two lines are the sidecar paths.
async function downloadFile(url, dest) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      chmodSync(dest, 0o755);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        console.error(`fetch-sidecars: download failed (${error.message}), retrying once: ${url}`);
      }
    }
  }
  fail(`download failed after retry: ${url}\n  ${lastError?.message ?? lastError}`);
}

async function downloadText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        console.error(`fetch-sidecars: download failed (${error.message}), retrying once: ${url}`);
      }
    }
  }
  fail(`download failed after retry: ${url}\n  ${lastError?.message ?? lastError}`);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// SHA256SUMS lines look like "<hex>  <name>" (binary mode may use "<hex> *<name>").
function checksumFor(sumsText, assetName, releaseLabel) {
  const entries = new Map();
  for (const line of sumsText.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) entries.set(path.basename(match[2].trim()), match[1].toLowerCase());
  }
  const expected = entries.get(assetName);
  if (!expected) {
    fail(`${CHECKSUM_FILE} from the ${releaseLabel} release has no entry for ${assetName}`);
  }
  return expected;
}

async function verifyChecksum(file, sumsText, assetName, releaseLabel) {
  const expected = checksumFor(sumsText, assetName, releaseLabel);
  const actual = (await sha256File(file)).toLowerCase();
  if (actual !== expected) {
    console.error(`fetch-sidecars: checksum mismatch for ${assetName} (${releaseLabel} release)`);
    console.error(`  expected: ${expected}`);
    console.error(`  actual:   ${actual}`);
    process.exit(3);
  }
  console.error(`fetch-sidecars: checksum ok for ${assetName}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const triple = opts.triple || detectTriple();

  const piAsset = PI_ASSETS[triple];
  if (!piAsset) {
    fail(`no pi release asset for ${triple}; known triples: ${Object.keys(PI_ASSETS).join(", ")}`);
  }
  const agentAsset = `agent-${triple}${exeSuffix(triple)}`;

  const dest = opts.dest || mkdtempSync(path.join(tmpdir(), "terax-sidecars-"));
  mkdirSync(dest, { recursive: true });

  const piTag = `v${opts.piVersion || DEFAULT_PI_VERSION}`;
  const piDest = path.join(dest, piAsset);
  await downloadFile(`${PI_RELEASE_URL}/${piTag}/${piAsset}`, piDest);
  const piSums = await downloadText(`${PI_RELEASE_URL}/${piTag}/${CHECKSUM_FILE}`);
  await verifyChecksum(piDest, piSums, piAsset, `pi ${piTag}`);

  const agentTag = opts.agentVersion || DEFAULT_AGENT_VERSION;
  const agentDest = path.join(dest, agentAsset);
  await downloadFile(`${AGENT_RELEASE_URL}/${agentTag}/${agentAsset}`, agentDest);
  const agentSums = await downloadText(`${AGENT_RELEASE_URL}/${agentTag}/${CHECKSUM_FILE}`);
  await verifyChecksum(agentDest, agentSums, agentAsset, `agent ${agentTag}`);

  console.log(piDest);
  console.log(agentDest);
}

main().catch((error) => fail(error?.stack ?? String(error)));
