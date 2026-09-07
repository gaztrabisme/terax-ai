// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The section must mount on a fresh install where only pi_paths answers and
// every other command, file read and shell call fails like on a new machine.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "pi_paths") {
      return Promise.resolve({
        pi: {
          path: "/lab/efficient-pi/bin/pi",
          source: "pref",
          candidates: ["/lab/efficient-pi/bin/pi"],
        },
        agent: {
          path: "/harness/target/release/agent",
          source: "pref",
          candidates: ["/harness/target/release/agent"],
        },
        agentDir: {
          path: "/lab/efficient-pi/pi-home/agent",
          source: "pref",
          candidates: ["/lab/efficient-pi/pi-home/agent"],
        },
        runtimeAgentDir: {
          path: "/lab/efficient-pi/pi-home/agent",
          source: "pref",
          seeded: false,
        },
      });
    }
    return Promise.reject(new Error(`${cmd} unavailable in test`));
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async set() {}
    async save() {}
    async entries() {
      return [] as [string, unknown][];
    }
    async onChange() {
      return () => {};
    }
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { PI_PREF_DEFAULTS } from "@/modules/pi/lib/providers";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { PiSection } from "./PiSection";

const FRESH_PI_PREFS = {
  piLauncherDir: PI_PREF_DEFAULTS.launcherDir,
  piBoardBin: PI_PREF_DEFAULTS.boardBin,
  piAgentBin: PI_PREF_DEFAULTS.agentBin,
  piAgentDir: PI_PREF_DEFAULTS.agentDir,
  piProvider: PI_PREF_DEFAULTS.provider,
  piModel: PI_PREF_DEFAULTS.model,
  piThinking: PI_PREF_DEFAULTS.thinking,
  piSmol: PI_PREF_DEFAULTS.smol,
};

beforeEach(() => {
  usePreferencesStore.setState(FRESH_PI_PREFS);
});

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockClear();
});

it("renders the first-run check and the provider placeholder on a fresh install", async () => {
  render(<PiSection />);

  // The orchestrator select has no provider yet, so the placeholder must
  // render instead of an item; an empty-string item crashes Radix Select.
  expect(screen.getByText("Choose a provider")).toBeTruthy();

  // The check resolves despite every command rejecting and keeps every row.
  await screen.findByText("pi binary");
  // The check row label carries the roles scope suffix ("global"), the Roles
  // setting title does not; substring matching catches both.
  expect(
    (await screen.findAllByText("Orchestrator provider", { exact: false }))
      .length,
  ).toBe(2);
  expect(screen.getByText("3 ok, 0 warn, 2 missing")).toBeTruthy();
  expect(screen.getByText("Choose a provider")).toBeTruthy();
});

it("names the runtime agent dir and disables endpoints before the first seed", async () => {
  // The resolved agent dir is the bundled template and the seeded copy does
  // not exist yet: the section shows when the seed lands and blocks edits.
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "pi_paths") {
      return Promise.resolve({
        pi: { path: "/app/exe/pi", source: "bundled", candidates: ["/app/exe/pi"] },
        agent: {
          path: "/app/exe/agent",
          source: "bundled",
          candidates: ["/app/exe/agent"],
        },
        agentDir: {
          path: "/app/res/pi-home/agent",
          source: "bundled",
          candidates: ["/app/res/pi-home/agent"],
        },
        runtimeAgentDir: {
          path: "/app/data/pi-home/agent",
          source: "bundled",
          seeded: false,
        },
      });
    }
    return Promise.reject(new Error(`${cmd} unavailable in test`));
  });

  render(<PiSection />);

  expect(
    await screen.findByText("seeded on the first session"),
  ).toBeTruthy();
  expect(
    screen.getByText("/app/data/pi-home/agent/models.json.tmpl"),
  ).toBeTruthy();
  expect(screen.getByText("Save endpoints")).toHaveProperty("disabled", true);
  expect(screen.getByText("Add endpoint")).toHaveProperty("disabled", true);
});

const LAB_PATHS = {
  pi: {
    path: "/lab/efficient-pi/bin/pi",
    source: "pref",
    candidates: ["/lab/efficient-pi/bin/pi"],
  },
  agent: {
    path: "/harness/target/release/agent",
    source: "pref",
    candidates: ["/harness/target/release/agent"],
  },
  agentDir: {
    path: "/lab/efficient-pi/pi-home/agent",
    source: "pref",
    candidates: ["/lab/efficient-pi/pi-home/agent"],
  },
  runtimeAgentDir: {
    path: "/lab/efficient-pi/pi-home/agent",
    source: "pref",
    seeded: true,
  },
};

const PROVIDERS_TABLE = [
  "provider  name       aliases   auth env                        api",
  "--------  ---------  --------  -------------------------------  -------------------",
  "anthropic Anthropic            ANTHROPIC_API_KEY                anthropic-messages",
  "openai    OpenAI               OPENAI_API_KEY                   openai-responses",
  "google    Google     gemini    GEMINI_API_KEY, GOOGLE_API_KEY   google-generative-ai",
].join("\n");

function mockCloudCommands(overrides: {
  secrets?: Record<string, string>;
  envs?: Record<string, boolean>;
  providers?: boolean;
}): void {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "pi_paths") return Promise.resolve(LAB_PATHS);
    if (cmd === "pi_secret_set" || cmd === "pi_secret_clear") {
      return Promise.resolve(undefined);
    }
    if (cmd === "pi_secret_status") {
      return Promise.resolve(
        overrides.secrets ?? {
          anthropic: "unset",
          openai: "unset",
          google: "unset",
          openrouter: "unset",
        },
      );
    }
    if (cmd === "pi_secret_env_status") {
      return Promise.resolve(
        overrides.envs ?? {
          anthropic: false,
          openai: false,
          google: false,
          openrouter: false,
        },
      );
    }
    if (overrides.providers && cmd === "shell_run_command") {
      return Promise.resolve({
        stdout: PROVIDERS_TABLE,
        stderr: "",
        exit_code: 0,
        timed_out: false,
        truncated: false,
      });
    }
    return Promise.reject(new Error(`${cmd} unavailable in test`));
  });
}

it("shows the cloud key badge, the scoping note and a masked input per provider", async () => {
  mockCloudCommands({
    secrets: {
      anthropic: "set",
      openai: "unset",
      google: "unset",
      openrouter: "unset",
    },
    envs: {
      anthropic: false,
      openai: true,
      google: false,
      openrouter: false,
    },
  });

  render(<PiSection />);

  // anthropic holds the app's own key, openai's env var is present in the
  // app process, google and openrouter fall through to not set.
  expect(await screen.findByText("stored key")).toBeTruthy();
  expect(screen.getByText("env var present")).toBeTruthy();
  expect(screen.getAllByText("not set").length).toBeGreaterThanOrEqual(2);
  expect(
    screen.getByText(
      "Keys are scoped to the agent dir; the app stores its own under the app data dir.",
    ),
  ).toBeTruthy();
  // The inputs stay masked and name the env var pi reads.
  const input = screen.getByPlaceholderText(
    "GEMINI_API_KEY / GOOGLE_API_KEY",
  ) as HTMLInputElement;
  expect(input.type).toBe("password");
  // Clear only applies to the app's own stored key.
  const storedRow = screen
    .getByPlaceholderText("ANTHROPIC_API_KEY")
    .closest("div") as HTMLElement;
  expect(within(storedRow).getByText("Clear")).toHaveProperty("disabled", false);
  const unsetRow = input.closest("div") as HTMLElement;
  expect(within(unsetRow).getByText("Clear")).toHaveProperty("disabled", true);
});

it("saves a cloud key through pi_secret_set", async () => {
  mockCloudCommands({});
  render(<PiSection />);

  const input = (await screen.findByPlaceholderText(
    "ANTHROPIC_API_KEY",
  )) as HTMLInputElement;
  const row = input.closest("div") as HTMLElement;
  fireEvent.change(input, { target: { value: "sk-test-123" } });
  fireEvent.click(within(row).getByText("Save"));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("pi_secret_set", {
      provider: "anthropic",
      key: "sk-test-123",
    });
  });
  // The draft clears after the save; the key never renders as text.
  await waitFor(() => {
    expect(input.value).toBe("");
  });
});

it("clears a stored cloud key through pi_secret_clear", async () => {
  mockCloudCommands({
    secrets: {
      anthropic: "set",
      openai: "unset",
      google: "unset",
      openrouter: "unset",
    },
  });
  render(<PiSection />);

  const input = (await screen.findByPlaceholderText(
    "ANTHROPIC_API_KEY",
  )) as HTMLInputElement;
  const row = input.closest("div") as HTMLElement;
  expect(await within(row).findByText("stored key")).toBeTruthy();
  fireEvent.click(within(row).getByText("Clear"));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("pi_secret_clear", {
      provider: "anthropic",
    });
  });
});

it("shows pi's Anthropic OAuth warning next to the sign-in button", async () => {
  mockCloudCommands({ providers: true });
  render(<PiSection />);

  // "anthropic" also labels the cloud key row; the table cell is the one
  // inside a tr, and it only exists once the provider table has loaded.
  const tableRow = await waitFor(() => {
    const cells = screen.getAllByText("anthropic");
    const tr = cells.map((c) => c.closest("tr")).find((t) => t !== null);
    if (!tr) throw new Error("provider table not loaded yet");
    return tr;
  });
  expect(
    within(tableRow).getByText(/may violate Anthropic's consumer Terms of Service/),
  ).toBeTruthy();
  expect(within(tableRow).getByText("Sign in")).toBeTruthy();
});
