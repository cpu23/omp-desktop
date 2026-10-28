import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

if (process.env.OMP_DESKTOP_WEBKIT_PREFIX) {
  throw new Error("Private WebKit runtimes are no longer supported; unset OMP_DESKTOP_WEBKIT_PREFIX and use system GTK4/WebKitGTK 6 packages.");
}
if (process.platform !== "linux") throw new Error("The desktop launcher installer currently supports Linux only.");

const root = resolve(import.meta.dir, "..");
const target = process.env.CARGO_TARGET_DIR
  ? resolve(root, process.env.CARGO_TARGET_DIR)
  : join(root, "src-tauri", "target");
const source = join(target, "release", "omp-desktop");
if (!(await Bun.file(source).exists())) throw new Error(`Build the app first: bun run app:build (missing ${source})`);
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
  await chmod(temporary, 0o755);
  await rename(temporary, binary);
} finally {
  await rm(temporary, { force: true });
}

// Desktop Entry Exec quoting has two escaping layers; percent introduces field codes.
const executable = `"${binary.replaceAll("%", "%%").replaceAll(/([\\"`$])/g, "\\$1")}"`
  .replaceAll("\\", "\\\\");
const desktopFile = join(applications, "sh.omp.desktop.desktop");
// env lets launchers resolve a literal executable path containing percent field codes.
await Bun.write(desktopFile, `[Desktop Entry]\nType=Application\nName=OMP Desktop\nComment=OMP sessions in a native desktop window\nExec=/usr/bin/env ${executable}\nIcon=sh.omp.desktop\nTerminal=false\nCategories=Development;\nStartupNotify=true\nStartupWMClass=sh.omp.desktop\n`);
// Remove the installer-owned legacy entry from earlier shell IDs.
await rm(join(applications, "omp-desktop.desktop"), { force: true });

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
