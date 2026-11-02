import { invoke } from "@tauri-apps/api/core";

type WorkspacePickerWindow = Window & {
  __OMP_SELECT_WORKSPACE_DIRECTORY__?: () => Promise<unknown>;
};

function selectedDirectory(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("The native workspace picker returned an invalid directory.");
  }
  return value;
}

/** Opens the native single-directory chooser, or returns null when canceled. */
export async function selectWorkspaceDirectory(): Promise<string | null> {
  if (typeof window === "undefined") {
    throw new Error("Native workspace directory selection requires a desktop window.");
  }
  if (window.top !== window) {
    throw new Error("Workspace directory selection is only available in the top-level window.");
  }

  if ("__TAURI_INTERNALS__" in window) {
    return selectedDirectory(await invoke<unknown>("select_workspace_directory"));
  }

  const nativePicker = (window as WorkspacePickerWindow).__OMP_SELECT_WORKSPACE_DIRECTORY__;
  if (nativePicker) {
    return selectedDirectory(await nativePicker());
  }

  throw new Error("Native workspace directory selection is only available in OMP Desktop.");
}
