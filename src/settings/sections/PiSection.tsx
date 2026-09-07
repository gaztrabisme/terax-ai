import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { native, type ReadResult } from "@/lib/native";
import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setPiAgentBin,
  setPiAgentDir,
  setPiBoardBin,
  setPiLauncherDir,
  setPiModel,
  setPiProvider,
  setPiSmol,
  setPiThinking,
} from "@/modules/settings/store";
import {
  authStatus,
  blankEndpoint,
  expandHomePath,
  modelsForProvider,
  parseModelsJsonTmpl,
  parsePiModels,
  parsePiProviders,
  piAuthStatusLabel,
  piSignInPayload,
  PI_OPEN_TERMINAL_EVENT,
  PI_OAUTH_PROVIDERS,
  PI_THINKING_LEVELS,
  removeProviderAuth,
  serializeModelsJsonTmpl,
  setProviderApiKey,
  type PiAuthStatus,
  type PiEndpointView,
  type PiModelRow,
  type PiProviderRow,
} from "@/modules/pi/lib/providers";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

type StatResult = { kind: "file" | "dir" | "symlink" };

async function statPath(path: string): Promise<StatResult | null> {
  try {
    const stat = await invoke<StatResult>("fs_stat", {
      path,
      workspace: currentWorkspaceEnv(),
    });
    return stat;
  } catch {
    return null;
  }
}

/** Text input that commits on blur and Enter, mirroring the pref store. */
function CommitInput({
  value,
  onCommit,
  listId,
  className,
  type,
}: {
  value: string;
  onCommit: (next: string) => void;
  listId?: string;
  className?: string;
  type?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      value={draft}
      type={type}
      list={listId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={cn("h-7 text-[14px]", className)}
    />
  );
}

function GroupTitle({ children }: { children: string }) {
  return (
    <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

export function PiSection() {
  const piLauncherDir = usePreferencesStore((s) => s.piLauncherDir);
  const piBoardBin = usePreferencesStore((s) => s.piBoardBin);
  const piAgentBin = usePreferencesStore((s) => s.piAgentBin);
  const piAgentDir = usePreferencesStore((s) => s.piAgentDir);
  const piProvider = usePreferencesStore((s) => s.piProvider);
  const piModel = usePreferencesStore((s) => s.piModel);
  const piThinking = usePreferencesStore((s) => s.piThinking);
  const piSmol = usePreferencesStore((s) => s.piSmol);

  const [home, setHome] = useState<string | null>(null);
  const [providers, setProviders] = useState<PiProviderRow[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [models, setModels] = useState<PiModelRow[] | null>(null);
  const [authEntries, setAuthEntries] = useState<Record<string, unknown> | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [keyInputFor, setKeyInputFor] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [reveal, setReveal] = useState<Record<string, string | null>>({});
  const [endpoints, setEndpoints] = useState<PiEndpointView[] | null>(null);
  const [endpointsNote, setEndpointsNote] = useState<string | null>(null);
  const tmplDocRef = useRef<Record<string, unknown>>({});

  const launcherDirPath = expandHomePath(piLauncherDir, home);
  const agentDirPath = `${launcherDirPath}/pi-home/agent`;
  // Until the home dir resolves, a $HOME-prefixed path cannot hit the fs.
  const fsReady = !launcherDirPath.startsWith("$HOME");

  useEffect(() => {
    void invoke<string | null>("pi_home_dir").then(setHome).catch(() => {});
  }, []);

  const loadProviders = useMemo(
    () => async (dir: string) => {
      setProvidersError(null);
      try {
        const out = await native.runCommand(
          `PI_CODING_AGENT_DIR="${dir}/pi-home/agent" "${dir}/bin/pi" --list-providers`,
          dir,
          20,
        );
        if (out.exit_code !== 0) {
          setProvidersError(
            out.stderr.trim() || `pi --list-providers exited ${out.exit_code}`,
          );
          return;
        }
        setProviders(parsePiProviders(out.stdout));
      } catch (e) {
        setProvidersError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const loadModels = useMemo(
    () => async (dir: string) => {
      try {
        const out = await native.runCommand(
          `PI_CODING_AGENT_DIR="${dir}/pi-home/agent" "${dir}/bin/pi" --list-models`,
          dir,
          20,
        );
        if (out.exit_code === 0) setModels(parsePiModels(out.stdout));
      } catch {
        // The model comboboxes degrade to free text when pi is unavailable.
      }
    },
    [],
  );

  const loadAuth = useMemo(
    () => async (dir: string) => {
      try {
        const res = await native.readFile(`${dir}/pi-home/agent/auth.json`);
        if (res.kind === "text") {
          setAuthEntries(JSON.parse(res.content) as Record<string, unknown>);
        } else {
          setAuthEntries(null);
        }
      } catch {
        setAuthEntries(null);
      }
    },
    [],
  );

  const loadEndpoints = useMemo(
    () => async (dir: string) => {
      try {
        const res: ReadResult = await native.readFile(
          `${dir}/pi-home/agent/models.json.tmpl`,
        );
        if (res.kind !== "text") {
          setEndpoints(null);
          return;
        }
        const doc = parseModelsJsonTmpl(res.content);
        tmplDocRef.current = doc.data;
        setEndpoints(doc.endpoints);
        setEndpointsNote(null);
      } catch {
        setEndpoints(null);
      }
    },
    [],
  );

  useEffect(() => {
    if (!fsReady) return;
    void loadProviders(launcherDirPath);
    void loadModels(launcherDirPath);
    void loadAuth(launcherDirPath);
    void loadEndpoints(launcherDirPath);
  }, [fsReady, launcherDirPath, loadProviders, loadModels, loadAuth, loadEndpoints]);

  const modelOptions = useMemo(
    () => (models && piProvider ? modelsForProvider(models, piProvider) : []),
    [models, piProvider],
  );
  const smolOptions = useMemo(
    () => (models ? models.map((m) => `${m.provider}/${m.model}`) : []),
    [models],
  );

  const checkPath = async (
    id: string,
    path: string,
    wantDir: boolean,
  ): Promise<boolean> => {
    const stat = await statPath(path);
    if (!stat) {
      setReveal((r) => ({ ...r, [id]: `missing: ${path}` }));
      return false;
    }
    if (wantDir && stat.kind !== "dir") {
      setReveal((r) => ({ ...r, [id]: `not a directory: ${path}` }));
      return false;
    }
    setReveal((r) => ({ ...r, [id]: path }));
    return true;
  };

  // The launcher dir is found when either binary exists.
  const checkLauncher = async () => {
    const efficientPi = `${launcherDirPath}/bin/efficient-pi`;
    const pi = `${launcherDirPath}/bin/pi`;
    if (await statPath(efficientPi)) {
      setReveal((r) => ({ ...r, launcher: efficientPi }));
      return;
    }
    if (await statPath(pi)) {
      setReveal((r) => ({ ...r, launcher: pi }));
      return;
    }
    setReveal((r) => ({
      ...r,
      launcher: `missing: ${efficientPi} and ${pi}`,
    }));
  };

  const statusFor = (id: string): PiAuthStatus =>
    authStatus(authEntries, id);

  const saveKey = async (providerId: string) => {
    const key = keyDraft.trim();
    if (!key) return;
    const next = setProviderApiKey(authEntries, providerId, key);
    try {
      await native.writeFile(
        `${agentDirPath}/auth.json`,
        `${JSON.stringify(next, null, 2)}\n`,
      );
      setKeyInputFor(null);
      setKeyDraft("");
      await loadAuth(launcherDirPath);
    } catch {
      setProvidersError("could not write auth.json");
    }
  };

  const removeAuth = async (providerId: string) => {
    const next = removeProviderAuth(authEntries, providerId);
    try {
      await native.writeFile(
        `${agentDirPath}/auth.json`,
        `${JSON.stringify(next, null, 2)}\n`,
      );
      await loadAuth(launcherDirPath);
    } catch {
      setProvidersError("could not write auth.json");
    }
  };

  const signIn = async (providerId: string) => {
    await emit(PI_OPEN_TERMINAL_EVENT, piSignInPayload(launcherDirPath));
    setReveal((r) => ({
      ...r,
      signIn: `terminal requested for ${providerId}`,
    }));
  };

  const filteredProviders = useMemo(() => {
    if (!providers) return [];
    const q = search.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) =>
      [p.id, p.name, p.aliases.join(" "), p.authEnv.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [providers, search]);

  const updateEndpoint = (index: number, patch: Partial<PiEndpointView>) => {
    setEndpoints((list) =>
      list
        ? list.map((ep, i) => (i === index ? { ...ep, ...patch } : ep))
        : list,
    );
  };

  const saveEndpoints = async () => {
    if (!endpoints) return;
    const out = serializeModelsJsonTmpl(
      { data: tmplDocRef.current, endpoints },
      endpoints,
    );
    try {
      await native.writeFile(
        `${agentDirPath}/models.json.tmpl`,
        out,
      );
      setEndpointsNote("saved models.json.tmpl");
    } catch {
      setEndpointsNote("could not write models.json.tmpl");
    }
  };

  const pathNote = (id: string): { text: string; ok: boolean } | null => {
    const note = reveal[id];
    if (note === null || note === undefined) return null;
    return { text: note, ok: !note.startsWith("missing") && !note.startsWith("not a") };
  };

  return (
    <div className="flex flex-col gap-6 text-[14px]">
      <SectionHeader
        title="Pi"
        description="Roles, providers and endpoints for the pi agent sessions."
      />

      <div className="flex flex-col gap-2">
        <GroupTitle>Paths</GroupTitle>
        <SettingRow
          title="Launcher dir"
          description="Checkout holding bin/efficient-pi and bin/pi. $HOME/ expands."
        >
          <div className="flex items-center gap-2">
            <CommitInput
              value={piLauncherDir}
              onCommit={setPiLauncherDir}
              className="w-64"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              onClick={() => void checkLauncher()}
            >
              Reveal
            </Button>
          </div>
        </SettingRow>
        <PathNote note={pathNote("launcher")} />
        <SettingRow
          title="Board bin"
          description="Efficient-pi board CLI used by the board pane."
        >
          <div className="flex items-center gap-2">
            <CommitInput value={piBoardBin} onCommit={setPiBoardBin} className="w-64" />
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              onClick={() => checkPath("board", expandHomePath(piBoardBin, home), false)}
            >
              Reveal
            </Button>
          </div>
        </SettingRow>
        <PathNote note={pathNote("board")} />
        <SettingRow
          title="Agent bin"
          description="Harness agent binary for board actions."
        >
          <div className="flex items-center gap-2">
            <CommitInput value={piAgentBin} onCommit={setPiAgentBin} className="w-64" />
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              onClick={() => checkPath("agent", expandHomePath(piAgentBin, home), false)}
            >
              Reveal
            </Button>
          </div>
        </SettingRow>
        <PathNote note={pathNote("agent")} />
        <SettingRow
          title="Agent dir"
          description="pi agent dir override. Empty keeps the launcher default."
        >
          <div className="flex items-center gap-2">
            <CommitInput value={piAgentDir} onCommit={setPiAgentDir} className="w-64" />
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              onClick={() => {
                const dir = piAgentDir.trim()
                  ? expandHomePath(piAgentDir, home)
                  : agentDirPath;
                void checkPath("agentDir", dir, true);
              }}
            >
              Reveal
            </Button>
          </div>
        </SettingRow>
        <PathNote note={pathNote("agentDir")} />
      </div>

      <div className="flex flex-col gap-2">
        <GroupTitle>Roles</GroupTitle>
        <SettingRow
          title="Orchestrator provider"
          description="Passed to pi as --provider on every session."
        >
          <Select
            value={piProvider}
            onValueChange={(v) => void setPiProvider(v)}
          >
            <SelectTrigger className="h-7 w-56 text-[14px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(providers
                ? [
                    ...new Set([
                      piProvider,
                      ...endpoints?.map((e) => e.id) ?? [],
                      ...providers.map((p) => p.id),
                    ]),
                  ].filter((id) => id.length > 0)
                : [piProvider]
              ).map((id) => (
                <SelectItem key={id} value={id} className="text-[14px]">
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Model"
          description="Free text allowed; suggestions come from pi --list-models."
        >
          <CommitInput
            value={piModel}
            onCommit={setPiModel}
            listId="pi-model-options"
            className="w-56"
          />
          <datalist id="pi-model-options">
            {modelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </SettingRow>
        <SettingRow
          title="Thinking"
          description="Reasoning effort for the orchestrator model."
        >
          <Select
            value={piThinking}
            onValueChange={(v) => void setPiThinking(v as typeof piThinking)}
          >
            <SelectTrigger className="h-7 w-32 text-[14px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PI_THINKING_LEVELS.map((level) => (
                <SelectItem key={level} value={level} className="text-[14px]">
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Subagent model"
          description="provider/model passed to pi as --smol."
        >
          <CommitInput
            value={piSmol}
            onCommit={setPiSmol}
            listId="pi-smol-options"
            className="w-56"
          />
          <datalist id="pi-smol-options">
            {smolOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <GroupTitle>Providers</GroupTitle>
        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter 102 providers"
            className="h-7 w-64 text-[14px]"
          />
          <span className="text-[12px] text-muted-foreground">
            {providers ? `${filteredProviders.length} shown` : "loading"}
          </span>
          {providersError ? (
            <span className="text-[12px] text-destructive">{providersError}</span>
          ) : null}
        </div>
        <div className="max-h-96 overflow-y-auto rounded-lg border border-border/60">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border/60 text-left text-[12px] text-muted-foreground">
                <th className="px-3 py-1.5 font-medium">provider</th>
                <th className="px-3 py-1.5 font-medium">name</th>
                <th className="px-3 py-1.5 font-medium">auth env</th>
                <th className="px-3 py-1.5 font-medium">status</th>
                <th className="px-3 py-1.5 font-medium">actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProviders.map((p) => {
                const status = statusFor(p.id);
                const isOAuth = (PI_OAUTH_PROVIDERS as readonly string[]).includes(p.id);
                return (
                  <ProviderRow
                    key={p.id}
                    row={p}
                    status={status}
                    isOAuth={isOAuth}
                    keyInputActive={keyInputFor === p.id}
                    keyDraft={keyDraft}
                    setKeyDraft={setKeyDraft}
                    onToggleKeyInput={() => {
                      setKeyDraft("");
                      setKeyInputFor(keyInputFor === p.id ? null : p.id);
                    }}
                    onSaveKey={() => void saveKey(p.id)}
                    onRemove={() => void removeAuth(p.id)}
                    onSignIn={() => void signIn(p.id)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Keys are written to {agentDirPath}/auth.json. OAuth providers sign in
          through the pi prompt.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <GroupTitle>Endpoints</GroupTitle>
        <p className="text-[12px] text-muted-foreground">
          Custom OpenAI-compatible providers in {agentDirPath}/models.json.tmpl.
          Placeholders like __BPPC_HOST__ and __OMLX_KEY__ are preserved.
        </p>
        {endpoints?.map((ep, i) => (
          <div
            key={ep.id || `new-${i}`}
            className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="w-20 text-[12px] text-muted-foreground">id</span>
              <CommitInput
                value={ep.id}
                onCommit={(id) => updateEndpoint(i, { id })}
                className="w-48"
              />
              <span className="text-[12px] text-muted-foreground">
                apiKey: {ep.apiKey || "empty"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-20 text-[12px] text-muted-foreground">base URL</span>
              <CommitInput
                value={ep.baseUrl}
                onCommit={(baseUrl) => updateEndpoint(i, { baseUrl })}
                className="w-72"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-20 text-[12px] text-muted-foreground">model id</span>
              <CommitInput
                value={ep.modelId}
                onCommit={(modelId) => updateEndpoint(i, { modelId })}
                className="w-56"
              />
              <span className="w-16 text-[12px] text-muted-foreground">name</span>
              <CommitInput
                value={ep.name}
                onCommit={(name) => updateEndpoint(i, { name })}
                className="w-48"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-20 text-[12px] text-muted-foreground">context</span>
              <CommitInput
                value={String(ep.contextWindow)}
                onCommit={(v) =>
                  updateEndpoint(i, { contextWindow: Number(v) || 0 })
                }
                type="number"
                className="w-32"
              />
              <span className="w-16 text-[12px] text-muted-foreground">max out</span>
              <CommitInput
                value={String(ep.maxTokens)}
                onCommit={(v) => updateEndpoint(i, { maxTokens: Number(v) || 0 })}
                type="number"
                className="w-32"
              />
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={() =>
              setEndpoints((list) => [...(list ?? []), blankEndpoint()])
            }
          >
            Add endpoint
          </Button>
          <Button
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => void saveEndpoints()}
          >
            Save endpoints
          </Button>
          {endpointsNote ? (
            <span className="text-[12px] text-muted-foreground">{endpointsNote}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PathNote({ note }: { note: { text: string; ok: boolean } | null }) {
  if (!note) return null;
  return (
    <p
      className={cn(
        "-mt-1 px-3 text-[12px]",
        note.ok ? "text-muted-foreground" : "text-destructive",
      )}
    >
      {note.text}
    </p>
  );
}

type ProviderRowProps = {
  row: PiProviderRow;
  status: PiAuthStatus;
  isOAuth: boolean;
  keyInputActive: boolean;
  keyDraft: string;
  setKeyDraft: (v: string) => void;
  onToggleKeyInput: () => void;
  onSaveKey: () => void;
  onRemove: () => void;
  onSignIn: () => void;
};

function ProviderRow({
  row,
  status,
  isOAuth,
  keyInputActive,
  keyDraft,
  setKeyDraft,
  onToggleKeyInput,
  onSaveKey,
  onRemove,
  onSignIn,
}: ProviderRowProps) {
  return (
    <>
      <tr className="border-b border-border/40 text-[12px] last:border-b-0">
        <td className="px-3 py-1.5 font-mono">{row.id}</td>
        <td className="max-w-40 truncate px-3 py-1.5">{row.name}</td>
        <td className="max-w-52 truncate px-3 py-1.5 font-mono text-muted-foreground">
          {row.authEnv.join(", ")}
        </td>
        <td
          className={cn(
            "px-3 py-1.5",
            status === "none" && "text-muted-foreground",
          )}
        >
          {piAuthStatusLabel(status)}
        </td>
        <td className="px-3 py-1.5">
          <div className="flex items-center gap-1">
            {row.authEnv.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[12px]"
                onClick={onToggleKeyInput}
              >
                {status === "key" ? "Edit key" : "Set key"}
              </Button>
            ) : null}
            {status !== "none" ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[12px]"
                onClick={onRemove}
              >
                Remove
              </Button>
            ) : null}
            {isOAuth ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[12px]"
                onClick={onSignIn}
              >
                Sign in
              </Button>
            ) : null}
          </div>
        </td>
      </tr>
      {keyInputActive ? (
        <tr className="border-b border-border/40 last:border-b-0">
          <td colSpan={5} className="px-3 py-1.5">
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveKey();
                  if (e.key === "Escape") onToggleKeyInput();
                }}
                placeholder={`${row.authEnv[0] ?? "API key"} for ${row.id}`}
                className="h-6 w-80 font-mono text-[12px]"
              />
              <Button size="sm" className="h-6 text-[12px]" onClick={onSaveKey}>
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[12px]"
                onClick={onToggleKeyInput}
              >
                Cancel
              </Button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
