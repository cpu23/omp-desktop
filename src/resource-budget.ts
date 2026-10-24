export type RuntimeResourceBudgetConfig = {
  /** Maximum scrollback rows retained by one terminal when aggregate space allows. */
  replayRowsPerRuntime: number;
  /** Aggregate terminal cell budget, including both visible buffers and scrollback. */
  replayCellsTotal: number;
  imageBytesPerRuntime: number;
  imageBytesTotal: number;
  snapshotBytesPerRuntime: number;
  snapshotBytesTotal: number;
};

export const DEFAULT_RUNTIME_RESOURCE_BUDGETS: Readonly<RuntimeResourceBudgetConfig> = Object.freeze({
  replayRowsPerRuntime: 20_000,
  // 32M cells preserves 20,000 rows plus both 80x32 viewports for 16 runtimes,
  // while remaining bounded at wider/larger geometries.
  replayCellsTotal: 32 * 1024 * 1024,
  imageBytesPerRuntime: 128 * 1024 * 1024,
  imageBytesTotal: 512 * 1024 * 1024,
  snapshotBytesPerRuntime: 8 * 1024 * 1024,
  snapshotBytesTotal: 64 * 1024 * 1024,
});

const MAX_RUNTIME_COLS = 500;
const MAX_RUNTIME_ROWS = 300;
const ENV_KEYS: Record<keyof RuntimeResourceBudgetConfig, string> = {
  replayRowsPerRuntime: "OMP_DESKTOP_REPLAY_ROWS_PER_RUNTIME",
  replayCellsTotal: "OMP_DESKTOP_REPLAY_CELLS_TOTAL",
  imageBytesPerRuntime: "OMP_DESKTOP_IMAGE_BYTES_PER_RUNTIME",
  imageBytesTotal: "OMP_DESKTOP_IMAGE_BYTES_TOTAL",
  snapshotBytesPerRuntime: "OMP_DESKTOP_SNAPSHOT_BYTES_PER_RUNTIME",
  snapshotBytesTotal: "OMP_DESKTOP_SNAPSHOT_BYTES_TOTAL",
};

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function resolveRuntimeResourceBudgetConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeResourceBudgetConfig {
  const config = { ...DEFAULT_RUNTIME_RESOURCE_BUDGETS };
  for (const key of Object.keys(ENV_KEYS) as (keyof RuntimeResourceBudgetConfig)[]) {
    const parsed = parseLimit(env[ENV_KEYS[key]]);
    if (parsed !== undefined) config[key] = parsed;
  }
  return config;
}

type LeaseState = {
  cols: number;
  rows: number;
  scrollbackRows: number;
  imageBytes: number;
  snapshotBytes: number;
  onScrollbackRows?: (rows: number) => void;
};

/** A runtime-scoped claim on the manager's aggregate terminal resource limits. */
export class RuntimeResourceLease {
  #released = false;

  constructor(
    private readonly owner: RuntimeResourceBudget,
    private readonly state: LeaseState,
    readonly replayRowsPerRuntime: number,
    readonly imageBytesPerRuntime: number,
    readonly snapshotBytesPerRuntime: number,
  ) {}

  get scrollbackRows(): number {
    return this.state.scrollbackRows;
  }

  get released(): boolean {
    return this.#released;
  }

  setScrollbackHandler(handler: ((rows: number) => void) | undefined): void {
    if (this.#released) return;
    this.state.onScrollbackRows = handler;
    handler?.(this.state.scrollbackRows);
  }

  setGeometry(cols: number, rows: number): boolean {
    if (this.#released) return false;
    return this.owner.resize(this, cols, rows);
  }

  reserveImage(bytes: number): boolean {
    if (this.#released || bytes < 0 || this.state.imageBytes + bytes > this.imageBytesPerRuntime) return false;
    if (!this.owner.reserveImage(bytes)) return false;
    this.state.imageBytes += bytes;
    return true;
  }

  releaseImage(bytes: number): void {
    if (this.#released || bytes <= 0) return;
    const released = Math.min(bytes, this.state.imageBytes);
    this.state.imageBytes -= released;
    this.owner.releaseImage(released);
  }

  reserveSnapshot(bytes: number): boolean {
    if (this.#released || bytes < 0 || bytes > this.snapshotBytesPerRuntime || this.state.snapshotBytes + bytes > this.snapshotBytesPerRuntime) {
      return false;
    }
    if (!this.owner.reserveSnapshot(bytes)) return false;
    this.state.snapshotBytes += bytes;
    return true;
  }

  releaseSnapshot(bytes: number): void {
    if (this.#released || bytes <= 0) return;
    const released = Math.min(bytes, this.state.snapshotBytes);
    this.state.snapshotBytes -= released;
    this.owner.releaseSnapshot(released);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.owner.release(this, this.state);
  }
}

/**
 * Shares replay cells, encoded images, and cached snapshots across live runtimes.
 * Replay grants are recomputed from each terminal's actual geometry on create,
 * resize, and release; the visible viewport is reserved before scrollback.
 */
export class RuntimeResourceBudget {
  readonly config: RuntimeResourceBudgetConfig;
  #leases = new Map<RuntimeResourceLease, LeaseState>();
  #imageBytes = 0;
  #snapshotBytes = 0;
  readonly #maxRuntimes: number;

  constructor(config: Partial<RuntimeResourceBudgetConfig> = {}, maxRuntimes = 16) {
    const resolved = { ...DEFAULT_RUNTIME_RESOURCE_BUDGETS, ...config };
    for (const key of Object.keys(ENV_KEYS) as (keyof RuntimeResourceBudgetConfig)[]) {
      if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 0) {
        resolved[key] = DEFAULT_RUNTIME_RESOURCE_BUDGETS[key];
      }
    }
    this.config = resolved;
    this.#maxRuntimes = Number.isSafeInteger(maxRuntimes) && maxRuntimes > 0 ? maxRuntimes : 16;
  }

  createLease(cols: number, rows: number): RuntimeResourceLease {
    if (this.#leases.size >= this.#maxRuntimes) throw new Error("runtime resource lease limit reached");
    if (!this.#fitsGeometry(cols, rows)) {
      throw new Error("terminal viewport exceeds the aggregate replay cell budget");
    }
    const state: LeaseState = { cols, rows, scrollbackRows: 0, imageBytes: 0, snapshotBytes: 0 };
    const lease = new RuntimeResourceLease(
      this,
      state,
      this.config.replayRowsPerRuntime,
      this.config.imageBytesPerRuntime,
      this.config.snapshotBytesPerRuntime,
    );
    this.#leases.set(lease, state);
    this.#recomputeScrollbackRows();
    return lease;
  }

  resize(lease: RuntimeResourceLease, cols: number, rows: number): boolean {
    if (!this.#leases.has(lease) || !this.#fitsGeometry(cols, rows, lease)) return false;
    const state = this.#leases.get(lease)!;
    state.cols = cols;
    state.rows = rows;
    this.#recomputeScrollbackRows();
    return true;
  }

  reserveImage(bytes: number): boolean {
    if (this.#imageBytes + bytes > this.config.imageBytesTotal) return false;
    this.#imageBytes += bytes;
    return true;
  }

  releaseImage(bytes: number): void {
    this.#imageBytes = Math.max(0, this.#imageBytes - bytes);
  }

  reserveSnapshot(bytes: number): boolean {
    if (this.#snapshotBytes + bytes > this.config.snapshotBytesTotal) return false;
    this.#snapshotBytes += bytes;
    return true;
  }

  releaseSnapshot(bytes: number): void {
    this.#snapshotBytes = Math.max(0, this.#snapshotBytes - bytes);
  }

  release(lease: RuntimeResourceLease, state: LeaseState): void {
    if (!this.#leases.delete(lease)) return;
    this.#imageBytes = Math.max(0, this.#imageBytes - state.imageBytes);
    this.#snapshotBytes = Math.max(0, this.#snapshotBytes - state.snapshotBytes);
    state.imageBytes = 0;
    state.snapshotBytes = 0;
    state.onScrollbackRows = undefined;
    this.#recomputeScrollbackRows();
  }

  #fitsGeometry(cols: number, rows: number, resizing?: RuntimeResourceLease): boolean {
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) ||
        cols < 2 || cols > MAX_RUNTIME_COLS || rows < 2 || rows > MAX_RUNTIME_ROWS) {
      return false;
    }
    let cells = cols * rows * 2;
    for (const [lease, state] of this.#leases) {
      if (lease !== resizing) cells += state.cols * state.rows * 2;
    }
    return cells <= this.config.replayCellsTotal;
  }

  #recomputeScrollbackRows(): void {
    let remaining = this.config.replayCellsTotal;
    for (const state of this.#leases.values()) remaining -= state.cols * state.rows * 2;
    if (remaining < 0) throw new Error("runtime replay viewport accounting exceeded its budget");

    const grants = new Map<LeaseState, number>();
    const active = new Set(this.#leases.values());
    for (const state of active) grants.set(state, 0);

    while (active.size > 0 && remaining > 0) {
      let columns = 0;
      for (const state of active) columns += state.cols;
      if (columns === 0) break;
      const sharedRows = Math.floor(remaining / columns);
      if (sharedRows === 0) {
        let progress = false;
        for (const state of active) {
          const current = grants.get(state)!;
          if (current >= this.config.replayRowsPerRuntime || remaining < state.cols) {
            active.delete(state);
            continue;
          }
          grants.set(state, current + 1);
          remaining -= state.cols;
          progress = true;
        }
        if (!progress) break;
        continue;
      }
      for (const state of active) {
        const current = grants.get(state)!;
        const add = Math.min(sharedRows, this.config.replayRowsPerRuntime - current);
        if (add > 0) {
          grants.set(state, current + add);
          remaining -= add * state.cols;
        }
        if (current + add >= this.config.replayRowsPerRuntime) active.delete(state);
      }
    }

    for (const state of this.#leases.values()) {
      const rows = grants.get(state) ?? 0;
      if (rows === state.scrollbackRows) continue;
      state.scrollbackRows = rows;
      state.onScrollbackRows?.(rows);
    }
  }
}
