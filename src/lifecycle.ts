/**
 * Pane identity rules for the desktop client. Runtime ids are ephemeral process
 * handles; a transcript path remains readable and attachable after any process
 * loss, daemon reconnect, or idle eviction.
 */
import { isRecord } from "./guards";
import type { RuntimeInfo } from "./protocol";
import type { FileReference } from "./file-drop";

export type PaneBinding = {
  runtimeId: string | null;
  title: string | null;
  sessionFile: string | null;
  cwd?: string;
  /** Drafts belong to transcript paths or a new-session workspace directory. */
  drafts?: Record<string, string>;
  /** Only references are retained; image bytes are read on explicit submission. */
  draftFiles?: Record<string, FileReference[]>;
  /** Input not yet attributable to a transcript is retained until its identity arrives. */
  orphanDraft?: string;
  /** Explicitly closed view: retain its placeholder instead of adopting a sidebar runtime. */
  keepEmpty?: true;
};

/** The state of a pane that has no runtime and no session. */
export function emptyBinding(): PaneBinding {
  return { runtimeId: null, title: null, sessionFile: null };
}

/** A binding for an existing runtime. */
export function bindingForRuntime(runtime: RuntimeInfo, title?: string): PaneBinding {
  return {
    runtimeId: runtime.id,
    title: title ?? runtime.title,
    sessionFile: runtime.sessionFile,
    cwd: runtime.cwd,
  };

}
/** Parse a stored binding, retaining durable transcript identity and valid drafts. */
export function bindingFromStored(entry: unknown): PaneBinding | null {
  if (!isRecord(entry)) return null;
  const drafts: Record<string, string> = {};
  if (isRecord(entry.drafts)) {
    for (const [path, text] of Object.entries(entry.drafts)) {
      if (path.length > 0 && typeof text === "string") drafts[path] = text;
    }
  }
  const draftFiles: Record<string, FileReference[]> = {};
  if (isRecord(entry.draftFiles)) {
    for (const [identity, refs] of Object.entries(entry.draftFiles)) {
      if (!Array.isArray(refs)) continue;
      const files = refs.filter((ref): ref is FileReference =>
        isRecord(ref) && typeof ref.path === "string" && ref.path.length > 0
        && typeof ref.text === "string" && ref.text.length > 0,
      );
      if (files.length) draftFiles[identity] = files;
    }
  }
  const runtimeId = typeof entry.runtimeId === "string" ? entry.runtimeId : null;
  const sessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile : null;
  const orphanDraft = typeof entry.orphanDraft === "string" ? entry.orphanDraft : undefined;
  return {
    ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
    runtimeId,
    title: typeof entry.title === "string" ? entry.title : null,
    sessionFile,
    ...(Object.keys(drafts).length ? { drafts } : {}),
    ...(Object.keys(draftFiles).length ? { draftFiles } : {}),
    ...(orphanDraft ? { orphanDraft } : {}),
    ...(entry.keepEmpty === true && runtimeId === null && sessionFile === null ? { keepEmpty: true as const } : {}),
  };
}

/** A reserved runtime can start on attach; an exited process cannot. */
export function attachable(runtime: RuntimeInfo): boolean {
  return runtime.alive || runtime.status !== "exited";
}

/** An already-running or reserved runtime writing this exact transcript, if any. */
export function runtimeForSession(sessionFile: string | null, runtimes: RuntimeInfo[]): RuntimeInfo | null {
  if (!sessionFile) return null;
  return runtimes.find((runtime) => attachable(runtime) && runtime.sessionFile === sessionFile) ?? null;
}
