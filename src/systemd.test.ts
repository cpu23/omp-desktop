/**
 * Regression tests for systemd auto-restart detection.
 *
 * The bug these pin: `INVOCATION_ID` and the cgroup path are inherited by every
 * descendant of a unit, so a daemon started from a terminal that is itself part
 * of a service used to identify (and restart) that terminal's unit. Only the
 * unit whose `MainPID` is this process may be restarted automatically; the
 * explicit `OMP_DESKTOP_SYSTEMD_UNIT` override is intentionally exempt.
 *
 * `/proc/self/cgroup` is injected as text and `systemctl` is a fake script in a
 * temporary PATH (or a direct function), so no real unit database or service is
 * touched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeSystemdUnit, type SystemdProbe } from "./systemd";

const CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/gnome-terminal-server.service\n";

const bin = mkdtempSync(join(tmpdir(), "omp-systemd-test-"));
const fakeSystemctl = join(bin, "systemctl");
// Emulates `systemctl show`: prints only the properties requested with `-p`,
// so the default probe must actually ask for both ownership properties. The
// probe invokes this path directly, because `Bun.spawnSync` resolves the
// executable from the startup environment, not a later `process.env.PATH` edit.
writeFileSync(
  fakeSystemctl,
  `#!/bin/sh
invocation=""
main_pid=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ]; then
    shift
    case "$1" in
      InvocationID) invocation="InvocationID=inv-fake" ;;
      MainPID) main_pid="MainPID=4242" ;;
    esac
  fi
  shift
done
if [ -n "$invocation" ]; then printf '%s\\n' "$invocation"; fi
if [ -n "$main_pid" ]; then printf '%s\\n' "$main_pid"; fi
exit 0
`,
);
chmodSync(fakeSystemctl, 0o755);

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
});

/**
 * A unit probe with a fixed cgroup and `systemctl show` output. `MainPID`
 * defaults to the injected PID, which is what a daemon started by that unit
 * would see.
 */
function probe(values: {
  env: Record<string, string | undefined>;
  pid: number;
  output?: string;
  exitCode?: number;
}): SystemdProbe {
  return {
    env: values.env,
    pid: values.pid,
    readCgroup: () => CGROUP,
    showUnit: () => ({
      exitCode: values.exitCode ?? 0,
      stdout: values.output ?? `InvocationID=inv-1\nMainPID=${values.pid}\n`,
    }),
  };
}

describe("systemd unit ownership", () => {
  test("the explicit unit override is returned without probing systemd", () => {
    const unit = activeSystemdUnit({
      env: { OMP_DESKTOP_SYSTEMD_UNIT: "custom-omp.service" },
      readCgroup: () => {
        throw new Error("the override must not read /proc/self/cgroup");
      },
      showUnit: () => {
        throw new Error("the override must not call systemctl");
      },
    });
    expect(unit).toBe("custom-omp.service");
  });

  test("an inherited terminal unit is not this process's unit", () => {
    // The invocation matches the containing unit, but its main program is the
    // terminal emulator, not this daemon.
    const unit = activeSystemdUnit(
      probe({
        env: { INVOCATION_ID: "inv-1" },
        pid: 9001,
        output: "InvocationID=inv-1\nMainPID=4100\n",
      }),
    );
    expect(unit).toBeNull();
  });

  test("the unit whose MainPID is this process is restartable", () => {
    const unit = activeSystemdUnit(
      probe({
        env: { INVOCATION_ID: "inv-1" },
        pid: 9001,
        output: "InvocationID=inv-1\nMainPID=9001\n",
      }),
    );
    expect(unit).toBe("gnome-terminal-server.service");
  });

  test("a matching MainPID under a different invocation is not trusted", () => {
    const unit = activeSystemdUnit(
      probe({
        env: { INVOCATION_ID: "inv-1" },
        pid: 9001,
        output: "InvocationID=inv-other\nMainPID=9001\n",
      }),
    );
    expect(unit).toBeNull();
  });

  test("missing or failed systemd properties never identify a unit", () => {
    const cases: SystemdProbe[] = [
      probe({ env: { INVOCATION_ID: "inv-1" }, pid: 9001, output: "InvocationID=inv-1\n" }),
      probe({ env: { INVOCATION_ID: "inv-1" }, pid: 9001, output: "MainPID=9001\n" }),
      probe({ env: { INVOCATION_ID: "inv-1" }, pid: 9001, exitCode: 1 }),
      probe({ env: {}, pid: 9001 }),
    ];
    for (const candidate of cases) expect(activeSystemdUnit(candidate)).toBeNull();
  });

  test("the default probe asks systemctl for both ownership properties", () => {
    // Uses the fake systemctl above: InvocationID=inv-fake, MainPID=4242.
    expect(
      activeSystemdUnit({
        env: { INVOCATION_ID: "inv-fake" },
        pid: 4242,
        readCgroup: () => CGROUP,
        systemctl: fakeSystemctl,
      }),
    ).toBe("gnome-terminal-server.service");
    expect(
      activeSystemdUnit({
        env: { INVOCATION_ID: "inv-fake" },
        pid: 4243,
        readCgroup: () => CGROUP,
        systemctl: fakeSystemctl,
      }),
    ).toBeNull();
  });
});
