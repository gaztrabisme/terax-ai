# Install Terax Pi and run a first session

This guide is for you if you have just downloaded Terax Pi on a machine that
has never seen this project and you want a first pi session running on a
folder within ten minutes.

## What Terax Pi is

Terax Pi is a desktop app that runs the pi coding agent on a folder: pi is a
program that reads, edits and runs code in that folder, and the app shows its
work as a chat, a board of tickets (a kanban, columns of work items) and a
run graph (a diagram of the orchestrator session and its subagent sessions),
where the orchestrator is the top pi session and a subagent is a child
session it delegates work to. The app bundles the pi binary and the harness
agent binary (the agent program that performs board actions), so nothing
else is installed.

## Get the installer

Download from the GitHub releases of `gaztrabisme/terax-ai`. The release is
named `Terax Pi pi-vX.Y.Z`, where `X.Y.Z` is the version number. Builds of
the development branch land as workflow artifacts named `terax-pi-<triple>`
instead, where the triple names the processor and system, for example
`aarch64-apple-darwin`. To build the installers yourself, follow
`docs/build.md`.

Per operating system the release holds:

- macOS: one `.dmg` per chip, a disk image that you open and drag to
  Applications; one image for Apple silicon, one for Intel.
- Ubuntu: a `.deb` (a Debian package) and an `.AppImage` (a single
  executable file), both for x86_64.
- Windows: an `.exe` installer built with NSIS (a Windows installer
  builder), for x86_64.

The bundles are unsigned, so the operating system warns on first open:

- macOS: the app is ad-hoc signed (signed without a developer identity), so
  Gatekeeper, the macOS first-open check, blocks it. A right click on the
  app with a single Open choice clears this for that app; the command
  `xattr -d com.apple.quarantine /Applications/Terax.app` removes the
  quarantine flag instead.
- Windows: SmartScreen, the Windows warning for unrecognized apps, shows
  "Windows protected your PC"; the choices "More info" and then "Run
  anyway" start the installer.
- Ubuntu: the command `sudo dpkg -i <file>.deb` installs the deb;
  `chmod +x <file>.AppImage` marks the AppImage executable, and starting
  the file runs it.

On macOS, the first session that reads a folder inside Documents triggers
one permission prompt for Documents access per install; the launcher waits
until you answer.

## First open

Settings opens with Cmd+, (Ctrl+, on Windows and Linux), and the Pi tab
holds the first-run check. The check runs once on first open; the "Run
check" button repeats it. The header shows a verdict: "Ready" when every
row is green, "Ready with warnings" when a row is amber and none is red,
"N things to fix" when a row is red, plus the counts "N ok, N warn,
N missing". Green means ok, amber means warn, red means missing.

The rows, in panel order:

- "pi binary", "agent binary", "agent dir": green when the app resolved
  each path to a bundled binary or one set in the Paths group; amber with
  "using the efficient-pi checkout at <path>" when it found a developer
  checkout (a source clone of the efficient-pi project) on the machine and
  runs pi from it instead of the bundled copy; red, with the first
  candidate paths and an "Open paths" button, when nothing was found.
- "Orchestrator provider" and "Subagent provider": green when the chosen
  provider holds a stored key ("key stored"), an OAuth token ("OAuth
  token") or needs no credential ("no key required"); red when it has
  none, with a "Sign in", "Add key" or "Open roles" button.
- "<id> endpoint", one row per local server that a role uses (see bppc and
  oMLX below): green when a health probe, an HTTP request to the server,
  answered; red with the URL and the reason, and an "Open endpoints"
  button, when it did not.

## Choose a provider

A provider is a model vendor or a server the models come from, and a model
id names one model at that provider. The Roles group of Settings > Pi sets
the two roles:

- "Orchestrator provider" and "Model": the provider and model of the main
  chat session, passed to pi on every session.
- "Subagent model": the provider/model pair for the child sessions, passed
  to pi as `--smol`.
- "Thinking": the reasoning effort of the orchestrator model, one of off,
  low, medium, high, xhigh.

For an API-key provider, find it in the Providers table, press "Set key"
and paste the key. The key is written into `auth.json`, the credential
file of pi, at `pi-home/agent/auth.json` inside the app data dir:

- macOS: `~/Library/Application Support/app.gaztrabisme.terax-pi`
- Linux: `~/.local/share/app.gaztrabisme.terax-pi`
- Windows: `%APPDATA%\app.gaztrabisme.terax-pi`

Seven providers sign in through OAuth (a browser sign-in that stores a
token) instead of a pasted key: anthropic, openai-codex, google-gemini-cli,
google-antigravity, kimi-for-coding, github-copilot, gitlab. The "Sign in"
button on such a row opens a terminal tab (a shell inside the app window)
running pi; typing `/login <provider>` at the pi prompt, the line where pi
waits for input, starts the sign-in.

bppc (a local proxy with an OpenAI-compatible API) and oMLX (a local model
server) are two local-server options among the list, not defaults; their
addresses live in the Endpoints group, and the first-run check probes them
when a role uses them.

## First session

The "New pi session" button in the tab bar, or the keys Cmd+Shift+P
(Ctrl+Shift+P on Windows and Linux), opens the system folder picker; the
picked folder is where the session runs. In that folder the app creates
`.pi/board.db` (the database that holds the tickets), `.pi/launcher.log`
(the log of the launch steps) and, when absent, the four wiki files
`wiki/index.md`, `wiki/active-work.md`, `wiki/decisions.md` and
`wiki/log.md`, the project notes pi maintains.

A good first prompt names a concrete task and points pi at the notes, for
example `Read wiki/index.md, then fix the failing test in tests/ and open
a ticket for what else you find.`

The chat is the transcript pane of the pi tab, where each turn shows pi's
answer and a fold of the tools it ran. The board is the kanban rail beside
the transcript, with a full-width board tab next to it. The run graph is
the pane that draws the orchestrator and its subagent sessions as nodes.
The first-tour doc, `docs/ui.md`, describes every pane.

## When something fails

The "Run check" button in Settings > Pi repeats the first-run check, and
each red row carries the button that jumps to the group that fixes it. The
file `.pi/launcher.log` in the session folder holds the failing launch
step and its message, for example the refusal when the folder holds none
of `.git`, `CLAUDE.md`, `AGENTS.md` or `wiki/`. The Paths group of
Settings > Pi points "Launcher dir", "Board bin", "Agent bin" and "Agent
dir" at your own pi or agent binary, and the "Reveal" button next to each
states whether the path exists.
