/**
 * Which systemd unit, if any, this daemon may ask to restart it.
 *
 * `INVOCATION_ID` and the cgroup path are inherited by every descendant of a
 * unit, so neither proves this process is the unit's main program: a daemon
 * started from a terminal that itself runs inside a service would find that
 * terminal's unit and restarting it would be destructive. Auto-detection
 * therefore requires the cgroup's own `.service` component, a matching
 * `InvocationID`, *and* a `MainPID` equal to this process. The latter is the
 * ownership test; `InvocationID` only ties the name to the unit systemd knows.
 *
 * `OMP_DESKTOP_SYSTEMD_UNIT` is the explicit escape hatch for unusual unit
 * names or non-user services: it bypasses detection entirely, including the
 * `MainPID` check, because the user has stated which unit owns the daemon.
 */
import { readFileSync } from "node:fs";

type ShowResult = {
  exitCode: number;
  stdout: string;
};

export type SystemdProbe = {
  /** Environment to inspect; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** PID compared with the unit's `MainPID`; defaults to `process.pid`. */
  pid?: number;
  /** Reads this process's cgroup; injectable so tests never touch `/proc`. */
  readCgroup?: () => string;
  /** Runs `systemctl --user show`; injectable so tests never touch real units. */
  showUnit?: (unit: string) => ShowResult | null;
  /** `systemctl` executable to invoke; defaults to `systemctl` on `PATH`. */
  systemctl?: string;
};

function showUnit(executable: string, unit: string): ShowResult | null {
  try {
    const shown = Bun.spawnSync(
      [executable, "--user", "show", "-p", "InvocationID", "-p", "MainPID", unit],
      { stdout: "pipe", stderr: "ignore" },
    );
    return { exitCode: shown.exitCode, stdout: shown.stdout.toString() };
  } catch {
    return null;
  }
}

/** Parse systemctl's `Key=Value` show output; values may be empty. */
function systemdProperties(output: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return properties;
}

/** The innermost `.service` component of a cgroup path, excluding systemd's own. */
function unitFromCgroup(cgroup: string): string | null {
  for (const line of cgroup.split("\n")) {
    if (line.trim().length === 0) continue;
    // cgroup v2 is `0::/path`; v1 lines end in `:<controller>:/path`.
    const path = line.slice(line.lastIndexOf(":") + 1);
    const candidate = path
      .split("/")
      .filter((part) => part.endsWith(".service") && !part.startsWith("user@") && !part.startsWith("systemd-"))
      .at(-1);
    if (candidate) return candidate;
  }
  return null;
}

export function activeSystemdUnit(probe: SystemdProbe = {}): string | null {
  const env = probe.env ?? process.env;
  const explicit = env.OMP_DESKTOP_SYSTEMD_UNIT?.trim();
  if (explicit) return explicit;
  const invocation = env.INVOCATION_ID;
  if (!invocation) return null;

  let cgroup: string;
  try {
    cgroup = (probe.readCgroup ?? (() => readFileSync("/proc/self/cgroup", "utf8")))();
  } catch {
    return null;
  }
  const unit = unitFromCgroup(cgroup);
  if (!unit) return null;

  const shown = probe.showUnit ? probe.showUnit(unit) : showUnit(probe.systemctl ?? "systemctl", unit);
  if (!shown || shown.exitCode !== 0) return null;
  const properties = systemdProperties(shown.stdout);
  if (properties.get("InvocationID") !== invocation) return null;
  // A unit that is merely an ancestor of this process has a different main
  // program (a terminal emulator, a login shell, ...). Only the unit whose
  // MainPID is this PID may be restarted on this daemon's behalf.
  if (Number(properties.get("MainPID")) !== (probe.pid ?? process.pid)) return null;
  return unit;
}
