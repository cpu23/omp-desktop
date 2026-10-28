import { describe, expect, test } from "bun:test";
import { DEFAULT_RUNTIME_RESOURCE_BUDGETS, resolveRuntimeResourceBudgetConfig, RuntimeResourceBudget } from "./resource-budget";

describe("runtime resource budgets", () => {
  test("shares total replay cells fairly and adjusts grants monotonically on resize", () => {
    const budget = new RuntimeResourceBudget({
      replayRowsPerRuntime: 20_000,
      replayCellsTotal: 1_000,
    }, 2);
    const cols = 10;
    const rows = 4;
    const first = budget.createLease(cols, rows);
    const second = budget.createLease(cols, rows);
    const cells = (columns: number, scrollbackRows: number) => (scrollbackRows + 2 * rows) * columns;

    expect(first.scrollbackRows).toBe(second.scrollbackRows);
    expect(cells(cols, first.scrollbackRows) + cells(cols, second.scrollbackRows)).toBeLessThanOrEqual(1_000);

    const beforeResizeFirst = first.scrollbackRows;
    const beforeResizeSecond = second.scrollbackRows;
    expect(first.setGeometry(20, rows)).toBe(true);
    expect(first.scrollbackRows).toBeLessThanOrEqual(beforeResizeFirst);
    expect(second.scrollbackRows).toBeLessThanOrEqual(beforeResizeSecond);
    // Whole rows have different cell costs after resize; fair grants may differ by one row.
    expect(Math.abs(first.scrollbackRows - second.scrollbackRows)).toBeLessThanOrEqual(1);
    expect(cells(20, first.scrollbackRows) + cells(cols, second.scrollbackRows)).toBeLessThanOrEqual(1_000);

    const beforeRejectedResizeFirst = first.scrollbackRows;
    const beforeRejectedResizeSecond = second.scrollbackRows;
    expect(first.setGeometry(500, 300)).toBe(false);
    expect(first.scrollbackRows).toBe(beforeRejectedResizeFirst);
    expect(second.scrollbackRows).toBe(beforeRejectedResizeSecond);
    first.release();
    expect(first.released).toBe(true);
    expect(second.scrollbackRows).toBeGreaterThan(beforeRejectedResizeSecond);
    expect(cells(cols, second.scrollbackRows)).toBeLessThanOrEqual(1_000);
  });

  test("preserves the per-runtime scrollback ceiling when the pool fits the cell budget", () => {
    const replayRowsPerRuntime = 20_000;
    const cols = 80;
    const rows = 24;
    const budget = new RuntimeResourceBudget({
      replayRowsPerRuntime,
      replayCellsTotal: 2 * (replayRowsPerRuntime + 2 * rows) * cols,
    }, 2);
    const first = budget.createLease(cols, rows);
    const second = budget.createLease(cols, rows);

    expect(first.scrollbackRows).toBe(replayRowsPerRuntime);
    expect(second.scrollbackRows).toBe(replayRowsPerRuntime);
    first.release();
    second.release();
  });

  test("bounds shared image and snapshot reservations and releases them with a lease", () => {
    const budget = new RuntimeResourceBudget({
      imageBytesPerRuntime: 8,
      imageBytesTotal: 10,
      snapshotBytesPerRuntime: 5,
      snapshotBytesTotal: 6,
    }, 2);
    const first = budget.createLease(10, 4);
    const second = budget.createLease(10, 4);

    expect(first.reserveImage(9)).toBe(false);
    expect(first.reserveImage(6)).toBe(true);
    expect(second.reserveImage(5)).toBe(false);
    first.releaseImage(6);
    expect(second.reserveImage(5)).toBe(true);

    expect(first.reserveSnapshot(6)).toBe(false);
    expect(first.reserveSnapshot(4)).toBe(true);
    expect(second.reserveSnapshot(3)).toBe(false);
    first.releaseSnapshot(4);
    expect(second.reserveSnapshot(3)).toBe(true);

    second.release();
    const replacement = budget.createLease(10, 4);
    expect(replacement.reserveImage(8)).toBe(true);
    replacement.release();
    first.release();
  });

  test("reads bounded overrides from environment and ignores malformed values", () => {
    const resolved = resolveRuntimeResourceBudgetConfig({
      OMP_DESKTOP_REPLAY_ROWS_PER_RUNTIME: "0",
      OMP_DESKTOP_REPLAY_CELLS_TOTAL: "100000",
      OMP_DESKTOP_IMAGE_BYTES_PER_RUNTIME: "not-a-number",
      OMP_DESKTOP_IMAGE_BYTES_TOTAL: "0",
      OMP_DESKTOP_SNAPSHOT_BYTES_PER_RUNTIME: "256",
      OMP_DESKTOP_SNAPSHOT_BYTES_TOTAL: "512",
    });
    expect(resolved).toEqual({
      ...DEFAULT_RUNTIME_RESOURCE_BUDGETS,
      replayRowsPerRuntime: 0,
      replayCellsTotal: 100_000,
      imageBytesTotal: 0,
      snapshotBytesPerRuntime: 256,
      snapshotBytesTotal: 512,
    });
  });
});
