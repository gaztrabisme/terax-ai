import { Button } from "@/components/ui/button";
import { native } from "@/lib/native";
import { cn } from "@/lib/utils";
import {
  buildRows,
  chosenLocalEndpoints,
  probeUrlFor,
  summarize,
  type CheckRow,
  type CheckStatus,
  type PiHealthMap,
  type PiHealthResult,
  type PiRoles,
} from "@/modules/pi/lib/firstRun";
import {
  expandHomePath,
  parseModelsJsonTmpl,
  parsePiProviders,
  type PiEndpointView,
  type PiProviderRow,
  type PiResolvedPaths,
} from "@/modules/pi/lib/providers";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  Alert02Icon,
  CancelCircleIcon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

type PiFirstRunProps = {
  onFocusPaths: () => void;
  onFocusRoles: () => void;
  onFocusEndpoints: () => void;
  onSignIn: (provider: string) => void;
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
  agentDir: string,
  ready: boolean,
): Promise<Record<string, unknown> | null> {
  if (!ready) return null;
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
  agentDir: string,
  ready: boolean,
): Promise<PiEndpointView[] | null> {
  if (!ready) return null;
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
  dir: string,
  ready: boolean,
): Promise<PiProviderRow[]> {
  if (!ready) return [];
  try {
    const out = await native.runCommand(
      `PI_CODING_AGENT_DIR="${dir}/pi-home/agent" "${dir}/bin/pi" --list-providers`,
      dir,
      20,
    );
    return out.exit_code === 0 ? parsePiProviders(out.stdout) : [];
  } catch {
    return [];
  }
}

export function PiFirstRun({
  onFocusPaths,
  onFocusRoles,
  onFocusEndpoints,
  onSignIn,
  onAddKey,
}: PiFirstRunProps) {
  const piLauncherDir = usePreferencesStore((s) => s.piLauncherDir);
  const piAgentBin = usePreferencesStore((s) => s.piAgentBin);
  const piAgentDir = usePreferencesStore((s) => s.piAgentDir);
  const piProvider = usePreferencesStore((s) => s.piProvider);
  const piSmol = usePreferencesStore((s) => s.piSmol);

  const [home, setHome] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<CheckRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const autoRan = useRef(false);

  useEffect(() => {
    void invoke<string | null>("pi_home_dir")
      .then(setHome)
      .catch(() => setHome(""));
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
      const roles: PiRoles = { provider: piProvider, smol: piSmol };
      const dir = expandHomePath(piLauncherDir, home);
      const ready = !dir.startsWith("$HOME");
      const agentDir = `${dir}/pi-home/agent`;
      const [authEntries, endpoints, providerList] = await Promise.all([
        loadAuthEntries(agentDir, ready),
        loadEndpoints(agentDir, ready),
        loadProviderList(dir, ready),
      ]);
      const probes: Probe[] = chosenLocalEndpoints(roles).map((id) => ({
        id,
        url: probeUrlFor(endpoints, id),
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
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [piAgentBin, piAgentDir, piLauncherDir, piProvider, piSmol, home]);

  // First run waits for pi_home_dir so auth.json and models.json.tmpl are
  // reachable; every later run comes from the Run check button only.
  useEffect(() => {
    if (home === null || autoRan.current) return;
    autoRan.current = true;
    void runCheck();
  }, [home, runCheck]);

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
        if (action.provider) onAddKey(action.provider);
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
