import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

if (process.platform !== "linux") throw new Error("The desktop launcher installer currently supports Linux only.");

const root = resolve(import.meta.dir, "..");
const target = process.env.CARGO_TARGET_DIR
  ? resolve(root, process.env.CARGO_TARGET_DIR)
  : join(root, "src-tauri", "target");
const source = join(target, "release", "omp-desktop");
if (!(await Bun.file(source).exists())) throw new Error(`Build the app first: bun run app:build (missing ${source})`);

// A private rendering runtime is opt-in at install time. ELF RUNPATH confines
// it to this executable and its helpers; LD_LIBRARY_PATH would also leak into
// external browsers opened by the app.
const runtimePrefix = process.env.OMP_DESKTOP_WEBKIT_PREFIX
  ? resolve(process.env.OMP_DESKTOP_WEBKIT_PREFIX)
  : null;
const privateLibraries = [
  "libwebkit2gtk-4.1.so.0", "libjavascriptcoregtk-4.1.so.0",
  "libgtk-3.so.0", "libgdk-3.so.0",
];
const patchelf = runtimePrefix ? Bun.which("patchelf") : null;
if (runtimePrefix) {
  if (runtimePrefix.includes(":")) throw new Error("The private runtime path cannot contain ':' (ELF search-path separator).");
  if (!patchelf) throw new Error("patchelf is required to install the private rendering runtime.");
  if (!(await Bun.file(join(runtimePrefix, "runtime.json")).exists())) {
    throw new Error(`Private rendering runtime has not completed its build: ${runtimePrefix}`);
  }
  for (const helper of ["WebKitWebProcess", "WebKitNetworkProcess", "WebKitGPUProcess"]) {
    if (!(await Bun.file(join(runtimePrefix, "libexec/webkit2gtk-4.1", helper)).exists())) {
      throw new Error(`Private rendering runtime is missing ${helper}`);
    }
  }
  for (const library of privateLibraries) {
    if (!(await Bun.file(join(runtimePrefix, "lib", library)).exists())) {
      throw new Error(`Incomplete private rendering runtime: missing ${library} in ${runtimePrefix}/lib`);
    }
  }
}

const home = homedir();
const dataHome = process.env.XDG_DATA_HOME;
const dataRoot = dataHome && isAbsolute(dataHome) ? dataHome : join(home, ".local/share");
const applications = join(dataRoot, "applications");
const icons = join(dataRoot, "icons/hicolor/scalable/apps");
const binary = join(home, ".local/bin/omp-desktop");
await mkdir(dirname(binary), { recursive: true });
await mkdir(applications, { recursive: true });
await mkdir(icons, { recursive: true });
await copyFile(join(root, "src-tauri/icons/icon.svg"), join(icons, "sh.omp.desktop.svg"));

// Replace atomically: an already-open window can keep using the old executable.
const temporary = `${binary}.${process.pid}.tmp`;
try {
  await copyFile(source, temporary);
  if (runtimePrefix && patchelf) {
    const previous = Bun.spawnSync([patchelf, "--print-rpath", temporary]);
    if (previous.exitCode !== 0) throw new Error(previous.stderr.toString());
    const rpath = [join(runtimePrefix, "lib"), previous.stdout.toString().trim()].filter(Boolean).join(":");
    const patched = Bun.spawnSync([patchelf, "--set-rpath", rpath, temporary]);
    if (patched.exitCode !== 0) throw new Error(patched.stderr.toString());
    const dependencies = Bun.spawnSync(["ldd", temporary]);
    const linked = dependencies.stdout.toString();
    if (dependencies.exitCode !== 0 || linked.includes("=> not found")) {
      throw new Error(`Private runtime has unresolved dependencies:\n${linked}\n${dependencies.stderr}`);
    }
    for (const library of privateLibraries) {
      if (!linked.includes(`${library} => ${join(runtimePrefix, "lib", library)} `)) {
        throw new Error(`Private runtime did not resolve ${library} from ${runtimePrefix}/lib:\n${linked}`);
      }
    }
  }
  await chmod(temporary, 0o755);
  await rename(temporary, binary);
} finally {
  await rm(temporary, { force: true });
}

// Desktop Entry Exec quoting has two escaping layers; percent introduces field codes.
const executable = `"${binary.replaceAll("%", "%%").replaceAll(/([\\"`$])/g, "\\$1")}"`
  .replaceAll("\\", "\\\\");
const desktopFile = join(applications, "omp-desktop.desktop");
// env lets launchers resolve a literal executable path containing percent field codes.
await Bun.write(desktopFile, `[Desktop Entry]\nType=Application\nName=OMP Desktop\nComment=OMP sessions in a native desktop window\nExec=/usr/bin/env ${executable}\nIcon=sh.omp.desktop\nTerminal=false\nCategories=Development;\nStartupNotify=true\nStartupWMClass=omp-desktop\n`);
// Match GTK's Wayland app ID (the executable name), replacing the old unmatched entry.
await rm(join(applications, "sh.omp.desktop.desktop"), { force: true });

if (Bun.which("update-desktop-database")) {
  const result = Bun.spawnSync(["update-desktop-database", applications]);
  if (result.exitCode !== 0) console.warn(result.stderr.toString());
}

// Plasma caches missing icons in its long-running shell; refreshing the desktop
// database alone does not invalidate KIconLoader's cache.
if (process.env.DBUS_SESSION_BUS_ADDRESS && Bun.which("gdbus")) {
  const result = Bun.spawnSync([
    "gdbus", "emit", "--session", "--object-path", "/KIconLoader",
    "--signal", "org.kde.KIconLoader.iconChanged", "0",
  ]);
  if (result.exitCode !== 0) console.warn(result.stderr.toString());
}
console.log(`Installed ${binary}\nLauncher: ${desktopFile}\nOpen “OMP Desktop” from your application menu.`);
if (runtimePrefix) console.log(`Private rendering runtime: ${runtimePrefix}`);
