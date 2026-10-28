/** Identifies native shell capabilities without granting them to browser tabs. */
export function isNativeShell(): boolean {
  return typeof window !== "undefined" && (
    "__TAURI_INTERNALS__" in window
    || (window as Window & { __OMP_DESKTOP_SHELL__?: unknown }).__OMP_DESKTOP_SHELL__ === "gtk"
  );
}
