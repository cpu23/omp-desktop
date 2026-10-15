import type { RuntimeInfo } from "./protocol";

/** Tracks authoritative extension completion identities, never PTY activity. */
export class CompletionTracker {
  #seen = new Map<string, { baseline: boolean; identities: Set<string> }>();

  /**
   * The first valid observation for each runtime is a baseline, so opening or
   * reconnecting the desktop does not replay an old completion. Missing
   * presentation data is ignored: it cannot clear a baseline or prove a new
   * completion. Each later identity is emitted at most once per runtime.
   */
  observe(runtimes: readonly RuntimeInfo[], onCompletion: (runtime: RuntimeInfo, identity: string) => void): void {
    for (const runtime of runtimes) {
      const presentation = runtime.presentation;
      if (!presentation) continue;
      const identity = presentation.completion?.identity ?? null;
      let state = this.#seen.get(runtime.id);
      if (!state) {
        state = { baseline: false, identities: new Set() };
        this.#seen.set(runtime.id, state);
      }
      if (!state.baseline) {
        state.baseline = true;
        if (identity) state.identities.add(identity);
        continue;
      }
      if (!identity || state.identities.has(identity)) continue;
      state.identities.add(identity);
      onCompletion(runtime, identity);
    }
  }
}
