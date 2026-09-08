import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { native } from "@/lib/native";
import { cn } from "@/lib/utils";
import {
  buildRows,
  chosenLocalEndpoints,
  effectiveRoles,
  probeUrlFor,
  rolesScopeLabel,
  summarize,
  type CheckRow,
  type CheckStatus,
  type PiHealthMap,
  type PiHealthResult,
  type PiLocalKeyStatus,
  type PiRoles,
} from "@/modules/pi/lib/firstRun";
import {
  expandHomePath,
  parseModelsJsonTmpl,
  parsePiProviders,
  PI_OPEN_CWDS_EVENT,
  PI_OPEN_CWDS_QUERY_EVENT,
  type PiEndpointView,
  type PiProviderRow,
  type PiResolvedPaths,
  type PiRuntimePrefs,
} from "@/modules/pi/lib/providers";
import { omlxSettingsFallback } from "@/modules/pi/lib/secrets";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  Alert02Icon,
  CancelCircleIcon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

type PiFirstRunProps = {
  onFocusPaths: () => void;
  onFocusRoles: () => void;
  onFocusEndpoints: () => void;
  onSignIn: (provider: string) => void;
  /** Kept for the section's call site; Add key now focuses the Cloud keys
   *  group instead of opening a per-provider input. */
  onAddKey: (provider: string) => void;
};

type Probe = { id: string; url: string };

const STATUS_STYLES: Record<
  CheckStatus,
  { icon: typeof Tick02Icon; className: string }
> = {
  ok: { icon: Tick02Icon, className: "text-emerald-600 dark:text-emerald-400" },
  warn: { icon: Alert02Icon, className: "text-amber-600 dark:text-amber-300" },
  missing: { icon: CancelCircleIcon, className: "text-destructive" },
};

async function invokeHealth(probe: Probe): Promise<PiHealthResult> {
  try {
    return await invoke<PiHealthResult>("pi_health", { url: probe.url });
  } catch (e) {
    return {
      ok: false,
      status: null,
      ms: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function loadAuthEntries(
  agentDir: string | null,
  ready: boolean,
): Promise<Record<string, unknown> | null> {
  if (!ready || !agentDir) return null;
  try {
    const res = await native.readFile(`${agentDir}/auth.json`);
    return res.kind === "text"
      ? (JSON.parse(res.content) as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function loadEndpoints(
  agentDir: string | null,
  ready: boolean,
): Promise<PiEndpointView[] | null> {
  if (!ready || !agentDir) return null;
  try {
    const res = await native.readFile(`${agentDir}/models.json.tmpl`);
    return res.kind === "text"
      ? parseModelsJsonTmpl(res.content).endpoints
      : null;
  } catch {
    return null;
  }
}

async function loadProviderList(
  piBin: string | null,
  agentDir: string | null,
  ready: boolean,
): Promise<PiProviderRow[]> {
  if (!ready || !piBin || !agentDir) return [];
  try {
    const out = await native.runCommand(
      `PI_CODING_AGENT_DIR="${agentDir}" "${piBin}" --list-providers`,
      agentDir,
      20,
    );
    return out.exit_code === 0 ? parsePiProviders(out.stdout) : [];
  } catch {
    return [];
  }
}

/** The parsed `<cwd>/.pi/terax.json`; unreadable or missing resolves to null. */
async function loadWorkspaceOverrides(cwd: string | null): Promise<unknown> {
  if (!cwd) return null;
  try {
    const res = await native.readFile(`${cwd}/.pi/terax.json`);
    if (res.kind !== "text" || !res.content) return null;
    return JSON.parse(res.content) as unknown;
  } catch {
    return null;
  }
}

/**
 * Which cloud providers hold a key stored under the app data dir
 * (pi_secret_status answers "set"/"unset"; the key itself never leaves the
 * backend). A failed load degrades to empty, so the role rows just fall back
 * to the auth.json check.
 */
async function loadStoredCloudKeys(): Promise<Record<string, boolean>> {
  try {
    const res = await invoke<Record<string, string>>("pi_secret_status");
    const stored: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(res ?? {})) {
      stored[id] = value === "set";
    }
    return stored;
  } catch {
    return {};
  }
}

/** Which cloud env vars the app process already carries (booleans only). */
async function loadCloudEnvPresence(): Promise<Record<string, boolean>> {
  try {
    return (
      (await invoke<Record<string, boolean>>("pi_secret_env_status")) ?? {}
    );
  } catch {
    return {};
  }
}

/** The app home dir; a failed resolve leaves $HOME unexpanded and unreadable. */
async function loadHomeDir(): Promise<string | null> {
  try {
    return await invoke<string | null>("pi_home_dir");
  } catch {
    return null;
  }
}

/**
 * True when the launcher's own ~/.omlx/settings.json carries a non-empty
 * auth.api_key, the same read and parse the Pi section's endpoints badge
 * uses; anything unreadable or malformed counts as absent.
 */
async function loadOmlxSettingsFallback(home: string | null): Promise<boolean> {
  try {
    const res = await native.readFile(
      expandHomePath("$HOME/.omlx/settings.json", home),
    );
    return res.kind === "text" && omlxSettingsFallback(JSON.parse(res.content));
  } catch {
    return false;
  }
}

/**
 * Key source per local endpoint as a session would see it: omlx counts the
 * app's stored key, then the ~/.omlx/settings.json fallback, then a real key
 * rendered into models.json.tmpl; bppc only has the template. A __...__
 * placeholder in the template is not a key.
 */
async function loadLocalKeySources(
  endpoints: PiEndpointView[] | null,
  storedOmlx: boolean,
  home: string | null,
): Promise<Record<string, PiLocalKeyStatus>> {
  const templateKey = (id: string): boolean => {
    const apiKey = endpoints?.find((ep) => ep.id === id)?.apiKey.trim() ?? "";
    return apiKey.length > 0 && !/^__.+__$/.test(apiKey);
  };
  const omlxTemplate = templateKey("omlx");
  const bppcTemplate = templateKey("bppc");
  const fallback =
    !storedOmlx && (await loadOmlxSettingsFallback(home));
  return {
    omlx: storedOmlx
      ? "stored"
      : fallback
        ? "fallback"
        : omlxTemplate
          ? "template"
          : "none",
    bppc: bppcTemplate ? "template" : "none",
  };
}

export function PiFirstRun({
  onFocusPaths,
  onFocusRoles,
  onFocusEndpoints,
  onSignIn,
}: PiFirstRunProps) {
  const piLauncherDir = usePreferencesStore((s) => s.piLauncherDir);
  const piBoardBin = usePreferencesStore((s) => s.piBoardBin);
  const piAgentBin = usePreferencesStore((s) => s.piAgentBin);
  const piAgentDir = usePreferencesStore((s) => s.piAgentDir);
  const piProvider = usePreferencesStore((s) => s.piProvider);
  const piModel = usePreferencesStore((s) => s.piModel);
  const piThinking = usePreferencesStore((s) => s.piThinking);
  const piSmol = usePreferencesStore((s) => s.piSmol);
  const piBppcHost = usePreferencesStore((s) => s.piBppcHost);

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<CheckRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Open pi tabs, most recently active cwd first, mirrored from the main
  // window over the pi:open-cwds events. The roles rows report the effective
  // prefs for the selected cwd; with no pi tab they report the globals.
  const [openCwds, setOpenCwds] = useState<string[]>([]);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<{ cwds: string[] }>(PI_OPEN_CWDS_EVENT, (e) => {
      if (!alive) return;
      const cwds = Array.isArray(e.payload?.cwds) ? e.payload.cwds : [];
      setOpenCwds(cwds);
      setSelectedCwd((cur) =>
        cur && cwds.includes(cur) ? cur : (cwds[0] ?? null),
      );
    }).then((un) => {
      if (!alive) un();
      else unlisten = un;
    });
    // A fresh settings window missed the earlier broadcasts; pull the list.
    void emit(PI_OPEN_CWDS_QUERY_EVENT, {}).catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const paths = await invoke<PiResolvedPaths>("pi_paths", {
        prefs: {
          piBin: "",
          agentBin: piAgentBin,
          agentDir: piAgentDir,
          launcherDir: piLauncherDir,
        },
      });
      const globalPrefs: Partial<PiRuntimePrefs> = {
        launcherDir: piLauncherDir,
        boardBin: piBoardBin,
        agentBin: piAgentBin,
        agentDir: piAgentDir,
        provider: piProvider,
        model: piModel,
        thinking: piThinking,
        smol: piSmol,
        bppcHost: piBppcHost,
      };
      const overrides = await loadWorkspaceOverrides(selectedCwd);
      const roles: PiRoles = effectiveRoles(globalPrefs, overrides);
      const scope = rolesScopeLabel(selectedCwd);
      // pi runs from the runtime agent dir (the seeded copy when the source
      // is bundled), so the credentials, endpoints and provider table are
      // read there, not from the launcher dir.
      const runtimeDir = paths.runtimeAgentDir.path;
      const ready = !!runtimeDir && !runtimeDir.startsWith("$HOME");
      const [
        authEntries,
        endpoints,
        providerList,
        storedKeys,
        envPresence,
        homeDir,
      ] = await Promise.all([
        loadAuthEntries(runtimeDir, ready),
        loadEndpoints(runtimeDir, ready),
        loadProviderList(paths.pi.path, runtimeDir, ready),
        loadStoredCloudKeys(),
        loadCloudEnvPresence(),
        loadHomeDir(),
      ]);
      const local = await loadLocalKeySources(
        endpoints,
        storedKeys.omlx === true,
        homeDir,
      );
      const probes: Probe[] = chosenLocalEndpoints(roles).map((id) => ({
        id,
        url: probeUrlFor(endpoints, id, piBppcHost),
      }));
      const results = await Promise.all(probes.map(invokeHealth));
      const health: PiHealthMap = {};
      probes.forEach((probe, i) => {
        health[probe.id] = results[i];
      });
      setRows(
        buildRows({
          paths,
          roles,
          authEntries,
          providerList,
          endpoints,
          health,
          rolesScope: scope,
          cloudKeys: { stored: storedKeys, env: envPresence, local },
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [
    piAgentBin,
    piAgentDir,
    piBppcHost,
    piBoardBin,
    piLauncherDir,
    piModel,
    piProvider,
    piSmol,
    piThinking,
    selectedCwd,
  ]);

  // Runs on mount and whenever the project selector changes, so the rows
  // never describe a project other than the selected one; every other later
  // run comes from the Run check button.
  const runRef = useRef(runCheck);
  runRef.current = runCheck;
  useEffect(() => {
    void runRef.current();
  }, [selectedCwd]);

  const summary = summarize(rows);

  const runAction = (row: CheckRow) => {
    const action = row.action;
    if (!action) return;
    switch (action.kind) {
      case "focus-paths":
        onFocusPaths();
        break;
      case "focus-roles":
        onFocusRoles();
        break;
      case "focus-endpoints":
        onFocusEndpoints();
        break;
      case "sign-in":
        if (action.provider) onSignIn(action.provider);
        break;
      case "add-key":
        // Cloud keys live in their own group now: the check row scrolls to
        // it instead of opening the legacy per-provider input.
        document
          .getElementById("pi-group-cloud-keys")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
    }
  };

  const verdictIcon =
    summary.missing > 0
      ? STATUS_STYLES.missing
      : summary.warn > 0
        ? STATUS_STYLES.warn
        : STATUS_STYLES.ok;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <HugeiconsIcon
            icon={verdictIcon.icon}
            size={14}
            strokeWidth={1.75}
            className={verdictIcon.className}
          />
          <span className="text-[13px] font-medium">
            {loading && rows.length === 0 ? "Checking" : summary.verdict}
          </span>
          {loading && rows.length === 0 ? null : (
            <span className="text-[12px] text-muted-foreground">
              {summary.ok} ok, {summary.warn} warn, {summary.missing} missing
            </span>
          )}
        </div>
        {openCwds.length > 1 ? (
          <Select value={selectedCwd ?? ""} onValueChange={setSelectedCwd}>
            <SelectTrigger className="h-7 w-44 shrink-0 text-[12px]">
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              {openCwds.map((cwd) => (
                <SelectItem key={cwd} value={cwd} className="text-[12px]">
                  {rolesScopeLabel(cwd)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 text-[12px]"
          disabled={loading}
          onClick={() => void runCheck()}
        >
          <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
          Run check
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60">
        {error ? (
          <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 last:border-b-0">
            <HugeiconsIcon
              icon={CancelCircleIcon}
              size={14}
              strokeWidth={1.75}
              className="shrink-0 text-destructive"
            />
            <span
              className="min-w-0 truncate text-[12px] text-destructive"
              title={error}
            >
              {error}
            </span>
          </div>
        ) : null}
        {loading && rows.length === 0
          ? [0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center gap-2 border-b border-border/40 px-3 py-2 last:border-b-0"
              >
                <div className="size-3.5 animate-pulse rounded-full bg-muted" />
                <div className="h-3 w-48 animate-pulse rounded bg-muted" />
              </div>
            ))
          : rows.map((row) => (
              <FirstRunRow key={row.id} row={row} onAction={runAction} />
            ))}
      </div>
    </div>
  );
}

function FirstRunRow({
  row,
  onAction,
}: {
  row: CheckRow;
  onAction: (row: CheckRow) => void;
}) {
  const style = STATUS_STYLES[row.status];
  return (
    <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 last:border-b-0">
      <HugeiconsIcon
        icon={style.icon}
        size={14}
        strokeWidth={1.75}
        className={cn("shrink-0", style.className)}
      />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-[13px]">{row.label}</span>
        <span
          className="min-w-0 truncate font-mono text-[12px] text-muted-foreground"
          title={row.detail}
        >
          {row.detail}
        </span>
      </div>
      {row.action ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 text-[12px]"
          onClick={() => onAction(row)}
        >
          {row.action.label}
        </Button>
      ) : null}
    </div>
  );
}
