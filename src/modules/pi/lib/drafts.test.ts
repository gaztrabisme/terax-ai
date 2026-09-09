import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import {
  clearDraft,
  draftMetaPath,
  draftPath,
  draftsDir,
  emptyChatMeta,
  findEditorDraft,
  listRecoverableDrafts,
  loadDraft,
  loadDraftMeta,
  loadEditorDraft,
  migrateNumericDraft,
  numericDraftPath,
  saveDraft,
  saveDraftMeta,
  saveEditorDraft,
  sha256Hex,
  type ChatDraftMeta,
  type DraftMeta,
} from "./drafts";

const WORKSPACE = { kind: "local" } as const;

/** In-memory project files backing the fs commands drafts.ts uses. */
function memoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  invoke.mockImplementation(
    async (
      cmd: string,
      args?: { path?: string; content?: string; showHidden?: boolean },
    ) => {
      const path = args?.path ?? "";
      if (cmd === "fs_create_dir") {
        dirs.add(path);
        return undefined;
      }
      if (cmd === "fs_write_file") {
        files.set(path, args?.content ?? "");
        return undefined;
      }
      if (cmd === "fs_read_file") {
        if (!files.has(path)) throw new Error(`no such file: ${path}`);
        return { kind: "text", content: files.get(path) };
      }
      if (cmd === "fs_stat") {
        if (!files.has(path)) throw new Error(`no such file: ${path}`);
        return { kind: "file", size: 1, mtime: 0 };
      }
      if (cmd === "fs_delete") {
        files.delete(path);
        return undefined;
      }
      if (cmd === "fs_read_dir") {
        return [...dirs].includes(path)
          ? [...files.keys()]
              .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
              .map((p) => {
                const name = p.slice(path.length + 1);
                return { name, kind: "file", size: 1, mtime: 0 };
              })
          : [];
      }
      throw new Error(`unexpected command: ${cmd}`);
    },
  );
  return files;
}

beforeEach(() => {
  invoke.mockReset();
});

describe("draft paths (stable ids)", () => {
  it("derives the two-file paths under <cwd>/.pi/drafts", () => {
    expect(draftsDir("/home/me/proj")).toBe("/home/me/proj/.pi/drafts");
    expect(draftPath("/home/me/proj", "k7x2m9")).toBe(
      "/home/me/proj/.pi/drafts/k7x2m9.md",
    );
    expect(draftMetaPath("/home/me/proj", "k7x2m9")).toBe(
      "/home/me/proj/.pi/drafts/k7x2m9.json",
    );
    expect(draftPath("C:\\Users\\me\\proj", "abc123")).toBe(
      "C:\\Users\\me\\proj/.pi/drafts/abc123.md",
    );
  });

  it("names legacy drafts after the numeric position", () => {
    expect(numericDraftPath("/w", 7)).toBe("/w/.pi/drafts/7.md");
  });
});

describe("chat draft round trip", () => {
  it("saves and loads through the fs commands, creating the dir first", async () => {
    memoryFs();
    await saveDraft("/w", "k7x2m9", "# draft");
    expect(invoke).toHaveBeenCalledWith("fs_create_dir", {
      path: "/w/.pi/drafts",
      workspace: WORKSPACE,
    });
    expect(invoke).toHaveBeenCalledWith("fs_write_file", {
      path: "/w/.pi/drafts/k7x2m9.md",
      content: "# draft",
      workspace: WORKSPACE,
    });
    expect(await loadDraft("/w", "k7x2m9")).toBe("# draft");
  });

  it("load returns null when the draft does not exist", async () => {
    invoke.mockRejectedValue(new Error("no such file"));
    expect(await loadDraft("/w", "gone")).toBeNull();
  });

  it("clear removes the draft and its record, swallowing missing files", async () => {
    invoke.mockRejectedValue(new Error("no such file"));
    await expect(clearDraft("/w", "zz9")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("fs_delete", {
      path: "/w/.pi/drafts/zz9.md",
      workspace: WORKSPACE,
    });
    expect(invoke).toHaveBeenCalledWith("fs_delete", {
      path: "/w/.pi/drafts/zz9.json",
      workspace: WORKSPACE,
    });
  });
});

describe("chat draft record", () => {
  it("starts empty with submissionId null and no attachments or sources", () => {
    expect(emptyChatMeta()).toEqual({
      v: 1,
      submissionId: null,
      attachments: [],
      sources: [],
    });
  });

  it("round-trips a record with K8 sources and queued-image fields", async () => {
    const files = memoryFs();
    const meta: ChatDraftMeta = {
      v: 1,
      submissionId: null,
      attachments: [
        {
          id: "att-1",
          path: "/w/.pi/attachments/s-a.png",
          sha256: "f00d",
          mime: "image/png",
          state: "queued",
        },
      ],
      sources: [
        {
          blockId: 12,
          terminalId: 3,
          sha256: "abc123",
          insertedAt: "2026-09-08T10:00:00.000Z",
        },
      ],
    };
    await saveDraftMeta("/w", "k7x2m9", meta);
    expect(files.get("/w/.pi/drafts/k7x2m9.json")).toBe(JSON.stringify(meta));
    expect(await loadDraftMeta("/w", "k7x2m9")).toEqual(meta);
  });

  it("fills missing submissionId and attachments, drops malformed entries", async () => {
    const files = memoryFs();
    files.set(
      "/w/.pi/drafts/k1.json",
      JSON.stringify({
        v: 1,
        sources: [{ blockId: 1, terminalId: "x", sha256: "h" }],
        attachments: [{ id: "a", path: "p", sha256: "s", mime: "m" }],
      }),
    );
    expect(await loadDraftMeta("/w", "k1")).toEqual({
      v: 1,
      submissionId: null,
      attachments: [],
      sources: [],
    });
  });

  it("returns null for binary or unreadable payloads", async () => {
    invoke.mockResolvedValue({ kind: "binary", size: 4 });
    expect(await loadDraftMeta("/w", "k1")).toBeNull();
    invoke.mockRejectedValue(new Error("no such file"));
    expect(await loadDraftMeta("/w", "k1")).toBeNull();
  });

  it("returns null for malformed, wrong-version or editor payloads", async () => {
    const files = memoryFs();
    files.set("/w/.pi/drafts/k1.json", "{not json");
    expect(await loadDraftMeta("/w", "k1")).toBeNull();
    files.set(
      "/w/.pi/drafts/k2.json",
      JSON.stringify({ v: 2, sources: [] }),
    );
    expect(await loadDraftMeta("/w", "k2")).toBeNull();
    files.set(
      "/w/.pi/drafts/k3.json",
      JSON.stringify({ v: 1, kind: "editor", path: "/w/a.ts", baseSha256: "h" }),
    );
    expect(await loadDraftMeta("/w", "k3")).toBeNull();
  });
});

describe("numeric draft migration", () => {
  it("renames a numeric draft to the stable id and carries the sidecar", async () => {
    const files = memoryFs();
    files.set("/w/.pi/drafts/7.md", "rescued text");
    files.set(
      "/w/.pi/drafts/7.md.json",
      JSON.stringify({
        v: 1,
        sources: [
          {
            blockId: 3,
            terminalId: 2,
            sha256: "deadbeef",
            insertedAt: "2026-09-08T09:00:00.000Z",
          },
        ],
      }),
    );

    expect(await migrateNumericDraft("/w", 7, "k7x2m9")).toBe(true);
    expect(files.get("/w/.pi/drafts/k7x2m9.md")).toBe("rescued text");
    const record = JSON.parse(
      files.get("/w/.pi/drafts/k7x2m9.json") ?? "null",
    ) as ChatDraftMeta;
    expect(record.v).toBe(1);
    expect(record.submissionId).toBeNull();
    expect(record.attachments).toEqual([]);
    expect(record.sources).toEqual([
      {
        blockId: 3,
        terminalId: 2,
        sha256: "deadbeef",
        insertedAt: "2026-09-08T09:00:00.000Z",
      },
    ]);
    // The numeric files are gone: one-time, never re-read.
    expect(files.has("/w/.pi/drafts/7.md")).toBe(false);
    expect(files.has("/w/.pi/drafts/7.md.json")).toBe(false);
  });

  it("is one-time: an existing stable draft is never clobbered", async () => {
    const files = memoryFs();
    files.set("/w/.pi/drafts/7.md", "old numeric text");
    files.set("/w/.pi/drafts/k7x2m9.md", "current draft");
    expect(await migrateNumericDraft("/w", 7, "k7x2m9")).toBe(false);
    expect(files.get("/w/.pi/drafts/k7x2m9.md")).toBe("current draft");
    expect(files.has("/w/.pi/drafts/7.md")).toBe(true);
  });

  it("skips when the stable id already is the number or no numeric file exists", async () => {
    const files = memoryFs();
    expect(await migrateNumericDraft("/w", 7, "7")).toBe(false);
    expect(await migrateNumericDraft("/w", 7, "k7x2m9")).toBe(false);
    expect(files.size).toBe(0);
  });

  it("loadDraft migrates once when the stable draft is missing", async () => {
    const files = memoryFs();
    files.set("/w/.pi/drafts/3.md", "typed before the upgrade");

    expect(await loadDraft("/w", "aa11bb22", { migrateFrom: 3 })).toBe(
      "typed before the upgrade",
    );
    expect(files.get("/w/.pi/drafts/aa11bb22.md")).toBe(
      "typed before the upgrade",
    );
    expect(files.has("/w/.pi/drafts/3.md")).toBe(false);

    // A second load reads the stable draft; the numeric file stays gone.
    files.set("/w/.pi/drafts/3.md", "some other tab's legacy draft");
    expect(await loadDraft("/w", "aa11bb22", { migrateFrom: 3 })).toBe(
      "typed before the upgrade",
    );
  });
});

describe("editor draft (K11c)", () => {
  const editorRecord: DraftMeta = {
    v: 1,
    kind: "editor",
    path: "/w/src/a.ts",
    baseSha256: "cafe",
  };

  it("saves the record and buffer under one stable id and loads them back", async () => {
    const files = memoryFs();
    await saveEditorDraft(
      "/w",
      "ed1t0r5",
      {
        v: 1,
        kind: "editor",
        path: "/w/src/a.ts",
        baseSha256: "cafe",
      },
      "unsaved buffer",
    );
    expect(files.get("/w/.pi/drafts/ed1t0r5.json")).toBe(
      JSON.stringify(editorRecord),
    );
    expect(files.get("/w/.pi/drafts/ed1t0r5.md")).toBe("unsaved buffer");

    const loaded = await loadEditorDraft("/w", "ed1t0r5");
    expect(loaded?.meta).toEqual(editorRecord);
    expect(loaded?.markdown).toBe("unsaved buffer");
  });

  it("finds the draft for a file path across the draft dir", async () => {
    memoryFs();
    await saveEditorDraft(
      "/w",
      "ed1t0r5",
      { v: 1, kind: "editor", path: "/w/src/a.ts", baseSha256: "cafe" },
      "buffer one",
    );
    await saveEditorDraft(
      "/w",
      "0th3red",
      { v: 1, kind: "editor", path: "/w/src/b.ts", baseSha256: "beef" },
      "buffer two",
    );
    // A chat record never matches a file lookup.
    await saveDraftMeta("/w", "cha7cha", emptyChatMeta());

    const found = await findEditorDraft("/w", "/w/src/b.ts");
    expect(found?.sid).toBe("0th3red");
    expect(found?.markdown).toBe("buffer two");
    expect(found?.meta.baseSha256).toBe("beef");
    expect(await findEditorDraft("/w", "/w/missing.ts")).toBeNull();
  });

  it("returns null for missing, malformed or chat records", async () => {
    const files = memoryFs();
    expect(await loadEditorDraft("/w", "nope")).toBeNull();

    files.set("/w/.pi/drafts/bad.json", "{not json");
    files.set("/w/.pi/drafts/bad.md", "text");
    expect(await loadEditorDraft("/w", "bad")).toBeNull();

    // Record ok, buffer missing: unusable without its text.
    files.set(
      "/w/.pi/drafts/half.json",
      JSON.stringify(editorRecord).replace("a.ts", "b.ts"),
    );
    expect(await loadEditorDraft("/w", "half")).toBeNull();
  });
});

describe("recoverable draft listing (U4)", () => {
  const source = {
    blockId: 3,
    terminalId: 2,
    sha256: "terminal-hash",
    insertedAt: "2026-09-09T00:00:00.000Z",
  };

  function attachment(n: number): ChatDraftMeta["attachments"][number] {
    return {
      id: `att-${n}`,
      path: `.pi/attachments/queued-${n}.png`,
      sha256: "f00d",
      mime: "image/png",
      state: "draft",
    };
  }

  it("drops empty drafts from the listing and deletes both files", async () => {
    const files = memoryFs();
    await saveDraft("/w", "empty1", "");
    await saveDraftMeta("/w", "empty1", emptyChatMeta());
    await saveDraft("/w", "blank2", "  \n\t\n");
    await saveDraftMeta("/w", "blank2", emptyChatMeta());
    await saveDraft("/w", "kept", "Real text\n");

    expect(await listRecoverableDrafts("/w", [])).toEqual([
      { sid: "kept", firstLine: "Real text" },
    ]);
    expect(files.has("/w/.pi/drafts/empty1.md")).toBe(false);
    expect(files.has("/w/.pi/drafts/empty1.json")).toBe(false);
    expect(files.has("/w/.pi/drafts/blank2.md")).toBe(false);
    expect(files.has("/w/.pi/drafts/blank2.json")).toBe(false);
    expect(files.has("/w/.pi/drafts/kept.md")).toBe(true);
  });

  it("never touches empty drafts bound to open tabs", async () => {
    const files = memoryFs();
    await saveDraft("/w", "openTab", "");
    await saveDraftMeta("/w", "openTab", emptyChatMeta());

    expect(await listRecoverableDrafts("/w", ["openTab"])).toEqual([]);
    expect(files.has("/w/.pi/drafts/openTab.md")).toBe(true);
    expect(files.has("/w/.pi/drafts/openTab.json")).toBe(true);
  });

  it("offers attachments-only drafts with the queued-image count label", async () => {
    const files = memoryFs();
    files.set("/w/.pi/attachments/queued-1.png", "a");
    files.set("/w/.pi/attachments/queued-2.png", "b");
    await saveDraftMeta("/w", "imgs", {
      ...emptyChatMeta(),
      attachments: [attachment(1), attachment(2)],
    });
    await saveDraftMeta("/w", "one-img", {
      ...emptyChatMeta(),
      attachments: [attachment(9)],
    });
    files.set("/w/.pi/attachments/queued-9.png", "c");

    expect(await listRecoverableDrafts("/w", [])).toEqual([
      { sid: "imgs", firstLine: "2 queued images" },
      { sid: "one-img", firstLine: "1 queued image" },
    ]);
    expect(files.has("/w/.pi/drafts/imgs.json")).toBe(true);
  });

  it("drops an attachments-only draft once every queued file is gone", async () => {
    const files = memoryFs();
    await saveDraft("/w", "gone", "");
    await saveDraftMeta("/w", "gone", {
      ...emptyChatMeta(),
      attachments: [attachment(1)],
    });

    expect(await listRecoverableDrafts("/w", [])).toEqual([]);
    expect(files.has("/w/.pi/drafts/gone.md")).toBe(false);
    expect(files.has("/w/.pi/drafts/gone.json")).toBe(false);
  });

  it("labels a K8 quotation draft with the first line of the quotation", async () => {
    memoryFs();
    await saveDraft("/w", "quoted", "```\n$ echo quartz\n\nquartz\n```\nFrom terminal block 3\n");
    await saveDraftMeta("/w", "quoted", { ...emptyChatMeta(), sources: [source] });

    expect(await listRecoverableDrafts("/w", [])).toEqual([
      { sid: "quoted", firstLine: "$ echo quartz" },
    ]);
  });

  it("keeps a K8 source draft whose quotation text was cleared", async () => {
    memoryFs();
    await saveDraft("/w", "cleared", "");
    await saveDraftMeta("/w", "cleared", { ...emptyChatMeta(), sources: [source] });

    expect(await listRecoverableDrafts("/w", [])).toEqual([
      { sid: "cleared", firstLine: "Transferred terminal block" },
    ]);
  });

  it("prefers the draft's own first line over the queued-image count", async () => {
    const files = memoryFs();
    files.set("/w/.pi/attachments/queued-1.png", "a");
    await saveDraft("/w", "mixed", "Check this\n");
    await saveDraftMeta("/w", "mixed", {
      ...emptyChatMeta(),
      attachments: [attachment(1)],
    });

    expect(await listRecoverableDrafts("/w", [])).toEqual([
      { sid: "mixed", firstLine: "Check this" },
    ]);
    expect(files.has("/w/.pi/drafts/mixed.md")).toBe(true);
  });

  it("drops an all-whitespace editor buffer but keeps the editor path label", async () => {
    const files = memoryFs();
    const editorMeta = { v: 1 as const, kind: "editor" as const, path: "/w/src/a.ts", baseSha256: "cafe" };
    await saveEditorDraft("/w", "ed1t0r5", editorMeta, "\n \n");
    expect(await listRecoverableDrafts("/w", [])).toEqual([]);
    expect(files.has("/w/.pi/drafts/ed1t0r5.md")).toBe(false);
    expect(files.has("/w/.pi/drafts/ed1t0r5.json")).toBe(false);

    await saveEditorDraft("/w", "ed1t0r5", editorMeta, "\nreal buffer");
    expect(await listRecoverableDrafts("/w", [])).toEqual([
      { sid: "ed1t0r5", firstLine: "/w/src/a.ts" },
    ]);
  });
});

describe("sha256Hex", () => {
  it("hashes text with SHA-256 as lowercase hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("")).toHaveLength(64);
  });
});
