/**
 * Canonical shape guard for this package. Every boundary in omp-desktop (daemon
 * HTTP/JSON, websocket control frames, localStorage blobs) hands us `unknown`;
 * the property checks for each contract live next to the type they validate
 * (protocol.ts), and they all start here.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
