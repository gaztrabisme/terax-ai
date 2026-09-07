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

const { storeWrites } = vi.hoisted(() => ({
  storeWrites: [] as [string, unknown][],
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async set(key: string, value: unknown) {
      storeWrites.push([key, value]);
    }
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
  piBppcHost: PI_PREF_DEFAULTS.bppcHost,
};

beforeEach(() => {
  usePreferencesStore.setState(FRESH_PI_PREFS);
  storeWrites.length = 0;
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
  /** Body served for $HOME/.omlx/settings.json; absent means unreadable. */
  omlxSettings?: string;
  /** Stdout served for the pi_list_models probe; absent means it fails. */
  models?: string;
}): void {
  vi.mocked(invoke).mockImplementation((cmd: string, ...rest: unknown[]) => {
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
          omlx: "unset",
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
          omlx: false,
        },
      );
    }
    if (overrides.models !== undefined && cmd === "pi_list_models") {
      return Promise.resolve(overrides.models);
    }
    if (overrides.omlxSettings !== undefined && cmd === "fs_read_file") {
      const args = rest[0] as { path?: string } | undefined;
      if ((args?.path ?? "").endsWith(".omlx/settings.json")) {
        return Promise.resolve({
          kind: "text",
          content: overrides.omlxSettings,
          size: overrides.omlxSettings.length,
        });
      }
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

it("commits the bppc host pref and saves the oMLX key under provider omlx", async () => {
  mockCloudCommands({});
  render(<PiSection />);

  // The bppc host field names the render's 127.0.0.1 fallback in its
  // placeholder and commits on blur like every other pref input.
  const hostInput = (await screen.findByPlaceholderText(
    "127.0.0.1",
  )) as HTMLInputElement;
  expect(hostInput.value).toBe("");
  fireEvent.change(hostInput, { target: { value: "100.100.100.100" } });
  fireEvent.blur(hostInput);
  await waitFor(() => {
    expect(storeWrites).toContainEqual(["piBppcHost", "100.100.100.100"]);
  });

  // The oMLX key field stays masked and stores through pi_secret_set with
  // the provider id the spawn env injection reads; the draft clears after.
  const desc = screen.getByText(
    "Stored under the app data dir; the spawn carries OMLX_API_KEY and EFFICIENT_PI_OMLX_KEY.",
  );
  const row = desc.closest("div")!.parentElement as HTMLElement;
  const keyInput = within(row).getByPlaceholderText(
    "OMLX_API_KEY / EFFICIENT_PI_OMLX_KEY",
  ) as HTMLInputElement;
  expect(keyInput.type).toBe("password");
  fireEvent.change(keyInput, { target: { value: "sk-omlx-test" } });
  fireEvent.click(within(row).getByText("Save"));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("pi_secret_set", {
      provider: "omlx",
      key: "sk-omlx-test",
    });
  });
  await waitFor(() => {
    expect(keyInput.value).toBe("");
  });
});

it("reports the launcher settings.json fallback when no oMLX key is stored", async () => {
  mockCloudCommands({ omlxSettings: '{"auth":{"api_key":"sk-fallback"}}' });
  render(<PiSection />);

  expect(
    await screen.findByText("settings.json fallback available"),
  ).toBeTruthy();
});

it("shows the stored oMLX badge and clears through pi_secret_clear", async () => {
  mockCloudCommands({ secrets: { omlx: "set" } });
  render(<PiSection />);

  // The endpoints badge reads "stored" (the cloud row spells "stored key").
  const badge = await screen.findByText("stored");
  const row = badge.closest("div") as HTMLElement;
  expect(within(row).getByText("Clear")).toHaveProperty("disabled", false);
  fireEvent.click(within(row).getByText("Clear"));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("pi_secret_clear", {
      provider: "omlx",
    });
  });
});

const MODELS_TABLE = [
  "provider        model                     context  max-out  thinking  images",
  "anthropic       claude-sonnet-4-6         1M       128K     yes       yes",
  "anthropic       claude-haiku-4-5          200K     64K      yes       no",
  "bppc            qwen3.8-27b               73.7K    32.8K    yes       no",
].join("\n");

const NO_ANTHROPIC_TABLE = [
  "provider        model                     context  max-out  thinking  images",
  "bppc            qwen3.8-27b               73.7K    32.8K    yes       no",
].join("\n");

function modelRow(): HTMLElement {
  const title = screen.getByText("Model", { exact: true });
  return title.closest("div")!.parentElement!;
}

it("lists the chosen provider's models with context and images markers", async () => {
  usePreferencesStore.setState({ ...FRESH_PI_PREFS, piProvider: "anthropic" });
  mockCloudCommands({ models: MODELS_TABLE });
  render(<PiSection />);

  // The probe runs against the runtime agent dir through pi_list_models,
  // whose env Rust-side carries the stored keys only.
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("pi_list_models", {
      prefs: { piBin: "", agentBin: "", agentDir: "", launcherDir: "" },
      pattern: null,
      agentDir: "/lab/efficient-pi/pi-home/agent",
    });
  });

  // A credential exists in the table for anthropic, so no key hint shows.
  expect(
    screen.queryByText("enter a key to see models"),
  ).toBeNull();

  const row = modelRow();
  fireEvent.click(within(row).getByLabelText("Show models"));
  const options = within(within(row).getByRole("listbox")).getAllByRole(
    "option",
  );
  expect(options).toHaveLength(2);
  const sonnet = options[0]!;
  expect(sonnet.textContent).toContain("claude-sonnet-4-6");
  expect(sonnet.textContent).toContain("1M");
  expect(sonnet.textContent).toContain("img");
  const haiku = options[1]!;
  expect(haiku.textContent).toContain("200K");
  expect(haiku.textContent).not.toContain("img");

  // Selecting a row commits the model pref through the pref store and
  // closes the list. (The input keeps its own draft until the pref-change
  // event reloads preferences, so the value assertion is the store write.)
  fireEvent.mouseDown(sonnet);
  await waitFor(() => {
    expect(storeWrites).toContainEqual(["piModel", "claude-sonnet-4-6"]);
  });
  expect(within(row).queryByRole("listbox")).toBeNull();
});

it("tells the user to enter a key when a cloud provider lists no models", async () => {
  usePreferencesStore.setState({ ...FRESH_PI_PREFS, piProvider: "anthropic" });
  // The probe env carries no stored key, so pi hides the anthropic rows.
  mockCloudCommands({ models: NO_ANTHROPIC_TABLE });
  render(<PiSection />);

  expect(await screen.findByText("enter a key to see models")).toBeTruthy();
  // The combobox dropdown explains the empty list the same way.
  const row = modelRow();
  fireEvent.click(within(row).getByLabelText("Show models"));
  const listbox = within(row).getByRole("listbox");
  expect(within(listbox).getByText("enter a key to see models")).toBeTruthy();
  // Free text still works with no table rows: the input stays editable.
  const input = within(row).getByRole("textbox") as HTMLInputElement;
  expect(input.disabled).toBe(false);
});
