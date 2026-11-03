export const MAX_IDLE_REQUEST_BYTES = 128 * 1024;
export const IDLE_REQUEST_TOO_LARGE = "session request exceeds the 128 KiB IPC envelope; the request was not sent";

/** Measure the actual UTF-8 JSON envelope, including transcript identity and attachments. */
export function idleRequestTooLarge(body: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_IDLE_REQUEST_BYTES;
}
