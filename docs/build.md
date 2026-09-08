# Building Terax Pi

Terax Pi bundles two sidecar binaries, `pi` and the pi `agent`, plus a
read-only template of the pi agent dir. The bundler declares them in
`src-tauri/tauri.conf.json` (`externalBin` and `resources`), and tauri-build
fails if they are missing, so they must be staged before any cargo build. Two
scripts do that: `scripts/fetch-sidecars.mjs` downloads the binaries from
their GitHub releases and verifies checksums, and
`scripts/prepare-sidecars.mjs` copies everything into
`src-tauri/binaries/` and `src-tauri/resources/pi-home/agent/`.

## Prerequisites

All platforms:

- Node 22 or newer (the scripts use the built-in `fetch`)
- pnpm (the repo pins a version in `packageManager`)
- Rust stable via rustup

Per platform:

- macOS: Xcode command line tools (`xcode-select --install`)
- Linux (Debian/Ubuntu): `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
  `librsvg2-dev`, `libssl-dev`, `patchelf`
- Windows: Visual Studio Build Tools with the "Desktop development with C++"
  workload. WebView2 is not needed to build; the NSIS installer downloads it
  at install time via the bootstrapper configured in tauri.conf.json.

## 1. Install frontend dependencies

```
pnpm install
```

## 2. Fetch the sidecar binaries

```
node scripts/fetch-sidecars.mjs
```

This downloads the `pi` binary from the
`Dicklesworthstone/pi_agent_rust` release tagged `v0.3.0` and the `agent`
binary from the `gaztrabisme/harness` release tagged `v0.2.1`, matching the
host triple, and verifies both against each release's `SHA256SUMS`. A failed
download is retried once; a checksum mismatch exits with code 3.

Options: `--triple <t>` (default: host triple), `--dest <dir>` (default: a
fresh temp dir), `--pi-version <v>`, `--agent-version <v>`. The script prints
the pi and agent paths as its last two output lines; pass them to the next
step. To build for a different triple, pass `--triple` explicitly.

## 3. Stage the sidecars

Clone the efficient-pi repo for the agent dir template, then stage:

```
git clone https://github.com/gaztrabisme/efficient-pi
node scripts/prepare-sidecars.mjs \
  --pi <pi-path> \
  --agent <agent-path> \
  --agent-dir /path/to/efficient-pi/pi-home/agent
```

The `<pi-path>` and `<agent-path>` are the two paths printed by the fetch
step. This copies `pi-<triple>` and `agent-<triple>` into
`src-tauri/binaries/` and prunes the agent dir (models.json, mcp.json,
auth.json, sessions, logs and other runtime state) before copying it to
`src-tauri/resources/pi-home/agent`, so no credentials ship in the bundle.

On machines with the vendored pi checkout and the harness build under the
expected `$HOME` paths, `node scripts/prepare-sidecars.mjs` without arguments
uses those defaults instead. Verify the staged files with
`node scripts/prepare-sidecars.mjs --check`.

## 4. Build

```
pnpm tauri build --bundles app,dmg      # macOS
pnpm tauri build --bundles deb,appimage # Linux
pnpm tauri build --bundles nsis         # Windows
```

The bundles land in `src-tauri/target/release/bundle/` (or
`src-tauri/target/<triple>/release/bundle/` when passing `--target <triple>`):

- macOS: `bundle/macos/Terax.app` and `bundle/dmg/`
- Linux: `bundle/deb/` and `bundle/appimage/`
- Windows: `bundle/nsis/` (the installer exe)

For local development use `pnpm tauri dev` after the staging step; the same
staged sidecars are picked up.

## Signing

- macOS: local builds sign with the `bundle > macOS > signingIdentity` from
  tauri.conf.json ("Terax Pi Dev"), which only exists on the maintainer's
  keychain. On any other machine the sign step fails; set
  `APPLE_SIGNING_IDENTITY="-"` to sign ad-hoc instead. CI does exactly that
  (see `.github/workflows/terax-pi.yml`). Ad-hoc builds run fine locally but
  have no notarization, so Gatekeeper asks for confirmation on first launch.
- Windows: installers are unsigned. SmartScreen shows a "Windows protected
  your PC" warning; choose "More info" then "Run anyway".
- Linux: packages are not signed.
