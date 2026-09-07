// Stages the pi sidecars tauri.conf.json declares: the pi and agent binaries
// under src-tauri/binaries/ (named pi-<triple>[.exe] as the bundler expects)
// and the pi agent dir under src-tauri/resources/pi-home/agent. Node only, no
// dependencies. Run `pnpm prepare-sidecars` before `pnpm tauri build`; every
// cargo build (build.rs) resolves these files, so they must exist up front.
// Secrets never ship: the agent dir copy drops models.json, mcp.json,
// auth.json, sessions/ and any *.log. Runtime state (logs/, agent-hub/,
// wiki/, tool-output-artifacts/) is dropped too; the app seeds a writable
// per-user copy, and the launcher re-creates the wiki in the project.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BINARIES_DIR = path.join(ROOT, "src-tauri", "binaries");
const RESOURCES_DIR = path.join(ROOT, "src-tauri", "resources");
const AGENT_DIR_DEST = path.join(RESOURCES_DIR, "pi-home", "agent");

// Defaults are workspace-relative ($HOME, never an absolute user path).
const DEFAULT_PI_BIN =
  "$HOME/Documents/Work/Lab/efficient-pi/vendor/pi-0.3.0-aarch64-apple-darwin/pi";
const DEFAULT_AGENT_BIN = "$HOME/Documents/Work/harness/target/release/agent";
const DEFAULT_AGENT_DIR = "$HOME/Documents/Work/Lab/efficient-pi/pi-home/agent";

const PI_TRIPLE = "aarch64-apple-darwin";

const AGENT_DIR_EXCLUDES = new Set([
  // skills are symlinks from skills-bridge into the developer's ~/.claude; the app ships none.
  "skills",
  "models.json",
  "mcp.json",
  "auth.json",
  "sessions",
  "logs",
  "tool-output-artifacts",
  "agent-hub",
  "wiki",
]);

function usage() {
  console.log(`Usage: node scripts/prepare-sidecars.mjs [--triple <t>] [--check]
  --triple <t>   target triple (default: host triple)
  --pi <path>    pi binary (or PI_BIN env)
  --agent <path> agent binary (or HARNESS_AGENT_BIN env)
  --agent-dir <path>  pi agent dir source (or PI_AGENT_DIR_SRC env)
  --check        verify the staged sidecars exist instead of copying`);
}

function parseArgs(argv) {
  const opts = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      opts.check = true;
    } else if (arg === "--triple") {
      opts.triple = requireValue(argv, ++i, arg);
    } else if (arg === "--pi") {
      opts.pi = requireValue(argv, ++i, arg);
    } else if (arg === "--agent") {
      opts.agent = requireValue(argv, ++i, arg);
    } else if (arg === "--agent-dir") {
      opts.agentDir = requireValue(argv, ++i, arg);
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
  console.error(`prepare-sidecars: ${message}`);
  process.exit(1);
}

function home() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

// Expands a leading $HOME/ (or bare $HOME) so defaults stay portable.
function expandHome(p) {
  if (!p) return p;
  const h = home();
  if (!h) return p;
  if (p === "$HOME") return h;
  if (p.startsWith("$HOME/")) return path.join(h, p.slice("$HOME/".length));
  return p;
}

// Host triple for the sidecar suffix. --triple wins; then rustc -vV's host
// (matches what cargo build targets); then a platform/arch mapping; then fail.
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

// The pi default only exists as a vendored aarch64-apple-darwin binary.
function defaultPiBin(triple) {
  const resolved = expandHome(DEFAULT_PI_BIN);
  if (triple !== PI_TRIPLE || !existsSync(resolved)) {
    fail(`no default pi binary for ${triple}; pass --pi <path> or set PI_BIN`);
  }
  return resolved;
}

function sourcePath(value, envName, fallback) {
  const raw = value || process.env[envName] || (typeof fallback === "function" ? fallback() : fallback);
  if (!raw) fail(`missing ${envName.replace(/_BIN|_SRC/, "").toLowerCase()} source; pass it or set ${envName}`);
  const resolved = expandHome(raw);
  if (!existsSync(resolved)) {
    fail(`source does not exist: ${resolved.replace(home(), "$HOME")}`);
  }
  return resolved;
}

function isAgentDirExcluded(src) {
  const base = path.basename(src);
  return AGENT_DIR_EXCLUDES.has(base) || base.endsWith(".log");
}

function copyAgentDir(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    // Returning false prunes files and whole directories (sessions/).
    filter: (src) => !isAgentDirExcluded(src),
  });
  mkdirSync(path.join(dest, "skills"), { recursive: true });
}

function copyBinary(src, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  // cpSync mode is a 0-7 mask, so the exec bits go on via chmod instead.
  cpSync(src, dest);
  chmodSync(dest, 0o755);
}

function listDir(dir) {
  try {
    return readdirSync(dir).join(", ");
  } catch {
    return "<missing>";
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const triple = opts.triple || detectTriple();
  const suffix = exeSuffix(triple);
  const piDest = path.join(BINARIES_DIR, `pi-${triple}${suffix}`);
  const agentDest = path.join(BINARIES_DIR, `agent-${triple}${suffix}`);

  if (opts.check) {
    const entries = [
      ["pi sidecar", piDest, (p) => statSync(p).isFile()],
      ["agent sidecar", agentDest, (p) => statSync(p).isFile()],
      ["agent dir", AGENT_DIR_DEST, (p) => statSync(p).isDirectory()],
    ];
    let missing = 0;
    for (const [label, p, isOk] of entries) {
      const ok = existsSync(p) && isOk(p);
      console.log(`${ok ? "ok " : "MISSING"} ${label}: ${p.replace(home(), "$HOME")}`);
      if (label === "agent dir" && existsSync(p)) {
        console.log(`     contents: ${listDir(p)}`);
      }
      if (!ok) missing++;
    }
    if (missing > 0) {
      fail(`${missing} of ${entries.length} sidecar(s) missing for ${triple}; run pnpm prepare-sidecars`);
    }
    console.log(`all sidecars staged for ${triple}`);
    return;
  }

  const piSrc = sourcePath(opts.pi, "PI_BIN", () => defaultPiBin(triple));
  const agentSrc = sourcePath(opts.agent, "HARNESS_AGENT_BIN", DEFAULT_AGENT_BIN);
  const agentDirSrc = sourcePath(opts.agentDir, "PI_AGENT_DIR_SRC", DEFAULT_AGENT_DIR);

  copyBinary(piSrc, piDest);
  console.log(`pi        ${piSrc.replace(home(), "$HOME")} -> ${piDest.replace(home(), "$HOME")}`);
  copyBinary(agentSrc, agentDest);
  console.log(`agent     ${agentSrc.replace(home(), "$HOME")} -> ${agentDest.replace(home(), "$HOME")}`);
  copyAgentDir(agentDirSrc, AGENT_DIR_DEST);
  console.log(`agent dir ${agentDirSrc.replace(home(), "$HOME")} -> ${AGENT_DIR_DEST.replace(home(), "$HOME")}`);
  console.log(`staged sidecars for ${triple}`);
}

main();
