import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  piSessionsList,
  piSessionsSearch,
  resolveSessionsAgentDir,
} from "./sessions";

afterEach(() => {
  invokeMock.mockReset();
});

describe("piSessionsList", () => {
  it("invokes pi_sessions_list with cwd, agentDir and workspace", async () => {
    invokeMock.mockResolvedValueOnce([]);
    const sessions = await piSessionsList("/tmp/proj", "/home/u/agent");
    expect(sessions).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("pi_sessions_list", {
      cwd: "/tmp/proj",
      agentDir: "/home/u/agent",
      workspace: { kind: "local" },
    });
  });
});

describe("piSessionsSearch", () => {
  it("invokes pi_sessions_search with the query and a default limit", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        path: "/a/sessions/--tmp-proj--/2026_b.jsonl",
        startedAt: "2026-06-09T09:00:00.000Z",
        role: "user",
        snippet: "...grail diary...",
      },
    ]);
    const hits = await piSessionsSearch("/tmp/proj", "/home/u/agent", "grail");
    expect(hits).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("pi_sessions_search", {
      cwd: "/tmp/proj",
      agentDir: "/home/u/agent",
      query: "grail",
      limit: 20,
      workspace: { kind: "local" },
    });
  });

  it("forwards an explicit limit", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await piSessionsSearch("/tmp/proj", "/home/u/agent", "x", 5);
    expect(invokeMock).toHaveBeenCalledWith("pi_sessions_search", {
      cwd: "/tmp/proj",
      agentDir: "/home/u/agent",
      query: "x",
      limit: 5,
      workspace: { kind: "local" },
    });
  });
});

describe("resolveSessionsAgentDir", () => {
  it("returns pi_paths runtimeAgentDir.path", async () => {
    invokeMock.mockResolvedValueOnce({
      pi: { path: "/bin/pi", source: "pref", candidates: [] },
      agent: { path: "/bin/agent", source: "pref", candidates: [] },
      agentDir: { path: "/a", source: "pref", candidates: [] },
      runtimeAgentDir: {
        path: "/home/u/Library/Application Support/terax/agent",
        source: "bundled",
        seeded: true,
      },
    });
    const dir = await resolveSessionsAgentDir();
    expect(dir).toBe("/home/u/Library/Application Support/terax/agent");
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("pi_paths");
    expect(args.prefs).toMatchObject({
      piBin: "",
      agentBin: "",
      agentDir: "",
      launcherDir: "",
    });
  });

  it("propagates the null runtime dir", async () => {
    invokeMock.mockResolvedValueOnce({
      pi: { path: null, source: "missing", candidates: [] },
      agent: { path: null, source: "missing", candidates: [] },
      agentDir: { path: null, source: "missing", candidates: [] },
      runtimeAgentDir: { path: null, source: "missing", seeded: false },
    });
    await expect(resolveSessionsAgentDir()).resolves.toBeNull();
  });
});
