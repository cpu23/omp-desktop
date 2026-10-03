/**
 * Canonical shape guard for this package. Every boundary in omp-desktop (daemon
 * HTTP/JSON, websocket control frames, localStorage blobs) hands us `unknown`;
 * the property checks for each contract live next to the type they validate
 * (protocol.ts), and they all start here.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
