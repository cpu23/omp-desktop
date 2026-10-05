import { copyFile, mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// Pinned to the local Ubuntu runtime so GTK can keep using its system modules,
// themes and input methods. Neither build installs anything into /usr.
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("This private rendering build targets Linux x86_64.");
}
const cache = resolve(process.env.OMP_DESKTOP_WEBKIT_CACHE ?? join(homedir(), ".cache/omp-desktop"));
const prefix = resolve(process.env.OMP_DESKTOP_WEBKIT_PREFIX ?? join(homedir(), ".local/share/omp-desktop/webkitgtk-2.52.6-refresh1"));
const jobs = Number(process.env.OMP_DESKTOP_WEBKIT_JOBS ?? 4);
if (!Number.isInteger(jobs) || jobs < 1) throw new Error("OMP_DESKTOP_WEBKIT_JOBS must be a positive integer.");
const webkitRoot = join(cache, "webkit-2.52.6");
const gtkRoot = join(cache, "gtk-3.24.52");
const env: Record<string, string | undefined> = { ...process.env, WEBKIT_NINJA_LINK_MAX: "1", WEBKIT_NINJA_COMPILE_MAX: String(jobs) };
const sysroot = process.env.OMP_DESKTOP_WEBKIT_SYSROOT;
if (sysroot) {
  const root = resolve(sysroot);
  const prepend = (key: string, value: string) => { env[key] = [value, env[key]].filter(Boolean).join(":"); };
  prepend("PATH", join(root, "usr/bin"));
  prepend("LD_LIBRARY_PATH", join(root, "usr/lib/x86_64-linux-gnu"));
  prepend("LIBRARY_PATH", join(root, "usr/lib/x86_64-linux-gnu"));
  prepend("CPATH", `${root}/usr/include:${root}/usr/include/x86_64-linux-gnu`);
  prepend("CMAKE_PREFIX_PATH", join(root, "usr"));
  prepend("PYTHONPATH", join(root, "usr/lib/python3/dist-packages"));
  const rubyVersions = (await readdir(join(root, "usr/lib/ruby"))).filter(name => /^\d+\.\d+\.\d+$/.test(name));
  prepend("RUBYLIB", rubyVersions.flatMap(version => [
    `${root}/usr/lib/ruby/${version}`, `${root}/usr/lib/x86_64-linux-gnu/ruby/${version}`,
  ]).join(":"));
  env.BISON_PKGDATADIR = join(root, "usr/share/bison");
  env.M4 = join(root, "usr/bin/m4");
  // Multiarch .pc files do not relocate correctly with pkg-config --define-prefix.
  const metadata = join(webkitRoot, "pkgconfig");
  await mkdir(metadata, { recursive: true });
  for await (const file of new Bun.Glob("usr/**/pkgconfig/*.pc").scan(root)) {
    await Bun.write(join(metadata, basename(file)), (await Bun.file(join(root, file)).text()).replaceAll("/usr", `${root}/usr`));
  }
  prepend("PKG_CONFIG_PATH", metadata);
}
function tool(name: string): string {
  const path = Bun.which(name, { PATH: env.PATH });
  if (!path) throw new Error(`Missing build tool: ${name}. See README's private WebKit build dependencies.`);
  return path;
}
async function run(args: string[], cwd?: string): Promise<void> {
  console.log(`$ ${args.join(" ")}`);
  const child = Bun.spawn(args, { cwd, env, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Command failed: ${args[0]}`);
}
async function capture(args: string[], cwd?: string, childEnv = env): Promise<string> {
  const child = Bun.spawn(args, { cwd, env: childEnv, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed:\n${out}\n${err}`);
  return out.trim();
}
for (const [pkg, version] of [["webkit2gtk-4.1", "2.52.6"], ["gtk+-3.0", "3.24.52"]]) {
  const installed = await capture([tool("pkg-config"), "--modversion", pkg]);
  if (installed !== version) throw new Error(`${pkg} is ${installed}; this patch set targets ${version}. Update the source pins before rebuilding.`);
}
const webkitPatch = join(import.meta.dir, "webkit-high-refresh.patch");
const gtkPatch = join(import.meta.dir, "gtk-high-refresh.patch");
const patchHash = new Bun.CryptoHasher("sha256").update(await Bun.file(webkitPatch).arrayBuffer()).update(await Bun.file(gtkPatch).arrayBuffer()).digest("hex");
const manifest = join(prefix, "runtime.json");
const libraries = ["libwebkit2gtk-4.1.so.0", "libjavascriptcoregtk-4.1.so.0", "libgtk-3.so.0", "libgdk-3.so.0"];
const helpers = ["WebKitWebProcess", "WebKitNetworkProcess", "WebKitGPUProcess"].map(name => join(prefix, "libexec/webkit2gtk-4.1", name));
async function verifyRuntime(): Promise<void> {
  const runtimeEnv = { ...process.env };
  delete runtimeEnv.LD_LIBRARY_PATH; // Build-only dependencies must not hide missing runtime libraries.
  for (const file of [...libraries.map(name => join(prefix, "lib", name)), ...helpers]) {
    if (!(await Bun.file(file).exists())) throw new Error(`Incomplete rendering runtime: ${file}`);
    const linked = await capture(["ldd", file], undefined, runtimeEnv);
    if (linked.includes("=> not found")) throw new Error(`Unresolved runtime dependency in ${file}:\n${linked}`);
  }
}
if (await Bun.file(manifest).exists()) {
  const saved = await Bun.file(manifest).json();
  if (saved.version !== 1 || saved.webkit !== "2.52.6" || saved.gtk !== "3.24.52" || saved.patchHash !== patchHash) {
    throw new Error("This prefix contains another runtime version or patch set. Choose a new OMP_DESKTOP_WEBKIT_PREFIX; do not overwrite libraries used by a running app.");
  }
  await verifyRuntime();
  console.log(`Private rendering runtime already built: ${prefix}`);
  process.exit(0);
}
const cmake = tool("cmake"), meson = tool("meson"), ninja = tool("ninja"), patchelf = tool("patchelf");
const clang = tool("clang"), clangxx = tool("clang++");
for (const name of ["ld.lld", "ruby", "gperf", "bison", "flex", "unifdef", "msgfmt", "sassc", "patch", "tar"]) tool(name);

async function archive(root: string, name: string, sha256: string, upstream: string): Promise<string> {
  const directory = join(root, "downloads");
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  const present = await Bun.file(path).exists();
  const candidate = present ? path : `${path}.download`;
  if (!present) {
    const response = await fetch(`${upstream}/${name}`);
    if (!response.ok || !response.body) throw new Error(`Source download failed: ${response.status} ${name}`);
    await Bun.write(candidate, response);
  }
  const hash = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(candidate).stream().getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (hash.digest("hex") !== sha256) throw new Error(`Source checksum mismatch: ${candidate}`);
  if (!present) await rename(candidate, path);
  return path;
}
async function applyPatch(source: string, patch: string): Promise<void> {
  // --force prevents patch from silently ignoring --reverse on a pristine tree:
  // a successful reverse dry-run must mean the patch is actually present.
  const check = Bun.spawn(["patch", "-p1", "--force", "--reverse", "--dry-run", "-i", patch], { cwd: source, env, stdout: "ignore", stderr: "ignore" });
  if (await check.exited !== 0) await run(["patch", "-p1", "--batch", "--forward", "-i", patch], source);
}
async function prepare(root: string, upstream: string, original: [string, string], distribution: [string, string], patch: string): Promise<string> {
  const source = join(root, "src");
  const tar = await archive(root, original[0], original[1], upstream);
  const delta = await archive(root, distribution[0], distribution[1], upstream);
  const sourceStamp = `${original[1]}:${distribution[1]}`;
  const stamp = join(source, ".omp-source");
  if (!(await Bun.file(stamp).exists()) || (await Bun.file(stamp).text()) !== sourceStamp) {
    // Ordered distro patches can overlap: reversing individual patches cannot
    // reliably identify an already-patched tree. Prepare a stamped tree once.
    const staging = join(root, `src.prepare-${process.pid}`);
    await mkdir(staging, { recursive: true });
    await run(["tar", "-xf", tar, "--strip-components=1", "-C", staging]);
    await run(["tar", "-xf", delta, "-C", staging]);
    for (const name of (await Bun.file(join(staging, "debian/patches/series")).text()).split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"))) {
      await run(["patch", "-p1", "--batch", "--forward", "-i", join(staging, "debian/patches", name)], staging);
    }
    await Bun.write(join(staging, ".omp-source"), sourceStamp);
    try {
      await rename(source, join(root, `src.previous-${Date.now()}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, source);
  }
  await applyPatch(source, patch);
  return source;
}
const gtkSource = await prepare(gtkRoot, "https://archive.ubuntu.com/ubuntu/pool/main/g/gtk+3.0",
  ["gtk+3.0_3.24.52.orig.tar.xz", "80931fa472a77b9a164f6740e3c0b444fac6770054632d35a7ff9d679e5e7b9f"],
  ["gtk+3.0_3.24.52-0ubuntu1.debian.tar.xz", "f8ad3b251e5b17c2579f5ea5eda842c8f18e258a09dc2974c6f459d4eafd3d39"], gtkPatch);
const gtkBuild = join(gtkRoot, "build");
await run([meson, "setup", ...(await Bun.file(join(gtkBuild, "build.ninja")).exists() ? ["--reconfigure"] : []), gtkBuild, gtkSource,
  "--prefix=/usr", "--libdir=lib/x86_64-linux-gnu", "--sysconfdir=/etc", "--default-library=shared", "--buildtype=debugoptimized", "-Ddebug=false",
  "-Dx11_backend=true", "-Dwayland_backend=true", "-Dbroadway_backend=true", "-Dintrospection=false", "-Dgtk_doc=false", "-Dman=false",
  "-Dtests=false", "-Ddemos=false", "-Dexamples=false", "-Dinstalled_tests=false", "-Dprint_backends=cups,file", "-Dcolord=yes",
  "-Dcloudproviders=false", "-Dtracker3=false", "-Dprofiler=true"]);
await run([ninja, "-C", gtkBuild, "-j", String(jobs), "gtk/libgtk-3.so.0.2420.32", "gdk/libgdk-3.so.0.2420.32"]);

const webkitSource = await prepare(webkitRoot, "https://archive.ubuntu.com/ubuntu/pool/main/w/webkit2gtk",
  ["webkit2gtk_2.52.6.orig.tar.xz", "179a2ea3f8f6edd4be7f31fdc55afc57bd0729f1fba648c61d4181539ac116fc"],
  ["webkit2gtk_2.52.6-0ubuntu0.26.04.1.debian.tar.xz", "ea13e2ad9a7093351ac379770692544f984d83f4720587bc2669bdc14c8cb33d"], webkitPatch);
const webkitBuild = join(webkitRoot, "build");
await run([cmake, "-S", webkitSource, "-B", webkitBuild, "-G", "Ninja", "-DPORT=GTK", "-DUSE_GTK4=OFF", "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_C_FLAGS_RELEASE=-O2 -DNDEBUG -DG_DISABLE_CAST_CHECKS", "-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG -DG_DISABLE_CAST_CHECKS",
  `-DCMAKE_C_COMPILER=${clang}`, `-DCMAKE_CXX_COMPILER=${clangxx}`, "-DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=lld", "-DCMAKE_SHARED_LINKER_FLAGS=-fuse-ld=lld",
  `-DCMAKE_INSTALL_PREFIX=${prefix}`, "-DCMAKE_INSTALL_LIBDIR=lib", "-DCMAKE_INSTALL_LIBEXECDIR=libexec", `-DCMAKE_INSTALL_RPATH=${prefix}/lib`,
  "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON", "-DCMAKE_INSTALL_RPATH_USE_LINK_PATH=OFF", "-DENABLE_DOCUMENTATION=OFF", "-DENABLE_INTROSPECTION=OFF",
  "-DENABLE_WEBDRIVER=OFF", "-DUSE_LIBBACKTRACE=OFF", "-DUSE_SYSPROF_CAPTURE=ON", "-DUSE_AVIF=OFF", "-DENABLE_SPEECH_SYNTHESIS=OFF",
  "-DENABLE_GAMEPAD=OFF", "-DENABLE_BUBBLEWRAP_SANDBOX=ON", "-DUSER_AGENT_BRANDING=Ubuntu"]);
await run([cmake, "--build", webkitBuild, "--parallel", String(jobs)]);
await run([cmake, "--install", webkitBuild]);
// Do not install GTK: its compiled /usr paths intentionally reuse the existing
// system modules and resources. Only the matching shared libraries are private.
await mkdir(join(prefix, "lib"), { recursive: true });
for (const name of ["gtk", "gdk"]) {
  const library = `lib${name}-3.so.0.2420.32`;
  const target = join(prefix, "lib", library);
  await copyFile(join(gtkBuild, name, library), target);
  await run([patchelf, "--set-rpath", "$ORIGIN", target]);
  for (const suffix of [".so", ".so.0"]) {
    const link = join(prefix, "lib", `lib${name}-3${suffix}`);
    await rm(link, { force: true });
    await symlink(library, link);
  }
}
await verifyRuntime();
await Bun.write(manifest, `${JSON.stringify({ version: 1, webkit: "2.52.6", gtk: "3.24.52", patchHash }, null, 2)}\n`);
console.log(`Built private rendering runtime: ${prefix}\nFollow README's private-runtime installation command; patchelf must be on PATH.`);
