/**
 * omp tells Tern (TERM_PROGRAM=tern) which session file it is writing by emitting
 *
 *   ESC ] 1337 ; SetUserVar = omp_session_file = <base64 of the absolute path> BEL|ST
 *
 * (iTerm2 user-var encoding; verified against omp on this machine). Sniffing it is
 * the only way to learn the file of a *freshly started* session without parsing
 * omp's internals, and it keeps working when the TUI itself switches sessions.
 *
 * Bytes are never consumed: the daemon still forwards every byte to the client, so
 * OSC handling in the terminal stays intact.
 */

const OSC_1337 = /\x1b\]1337;SetUserVar=omp_session_file=([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;
/** Longest prefix we keep between chunks: enough for a split OSC header + base64 path. */
const CARRY = 1024;

export function sniffSessionFile(carry: string, chunk: string): { carry: string; sessionFile: string | null } {
  const buffer = carry + chunk;
  let sessionFile: string | null = null;
  OSC_1337.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OSC_1337.exec(buffer)) !== null) {
    try {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      if (decoded.startsWith("/")) sessionFile = decoded;
    } catch {
      // not base64 after all; ignore
    }
  }
  return { carry: buffer.slice(-CARRY), sessionFile };
}
