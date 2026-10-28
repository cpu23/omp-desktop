export type AccessibilityRect = { x: number; y: number; width: number; height: number };

export type AccessibilityNode = {
  processid: number;
  name: string;
  role: string;
  states: string[];
  extents: AccessibilityRect | null;
  windowExtents: AccessibilityRect | null;
  children: AccessibilityNode[];
};

type AccessibilityReply = {
  id: number;
  ok: boolean;
  tree?: unknown;
  error?: string;
  code?: string;
};

type AccessibilityChild = {
  proc: Bun.Subprocess;
  stdout: { lines: string[] };
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRect(value: unknown): AccessibilityRect | null {
  if (value === null) return null;
  if (!record(value) || !["x", "y", "width", "height"].every((key) => Number.isFinite(value[key]))) {
    throw new Error(`AT-SPI returned an invalid extent: ${JSON.stringify(value)}`);
  }
  return {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
}

function parseNode(value: unknown, depth = 0, budget = { remaining: 2_000 }): AccessibilityNode {
  if (depth > 64 || --budget.remaining < 0) throw new Error("AT-SPI tree exceeded the fixture's depth or node limit.");
  if (!record(value) || !Number.isInteger(value.processid) || typeof value.name !== "string" ||
      typeof value.role !== "string" || !Array.isArray(value.states) || !value.states.every((state) => typeof state === "string") ||
      !Array.isArray(value.children)) {
    throw new Error(`AT-SPI returned an invalid accessible node: ${JSON.stringify(value)}`);
  }
  return {
    processid: value.processid as number,
    name: value.name,
    role: value.role,
    states: value.states,
    extents: parseRect(value.extents),
    windowExtents: parseRect(value.window_extents),
    children: value.children.map((child) => parseNode(child, depth + 1, budget)),
  };
}

/** Sends bounded newline-delimited snapshot requests to the read-only PyGObject AT-SPI helper. */
export class AccessibilityClient {
  readonly #child: AccessibilityChild;
  #nextId = 1;
  #busy = false;
  #closed = false;

  constructor(child: AccessibilityChild) {
    this.#child = child;
  }

  async snapshot(pid: number, timeoutMs = 8_000): Promise<AccessibilityNode> {
    if (this.#closed) throw new Error("AT-SPI helper is closed.");
    if (this.#busy) throw new Error("Concurrent AT-SPI snapshots are not supported.");
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid target application pid ${pid}.`);
    this.#busy = true;
    const id = this.#nextId++;
    const firstLine = this.#child.stdout.lines.length;
    try {
      const input = this.#child.proc.stdin;
      if (!input || typeof input === "number") throw new Error("AT-SPI helper has no writable command pipe.");
      input.write(`${JSON.stringify({ id, op: "snapshot", pid })}\n`);
      input.flush();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.#child.proc.exitCode !== null) throw new Error(`AT-SPI helper exited: ${this.#child.proc.exitCode}.`);
        const lines = this.#child.stdout.lines;
        for (let index = Math.min(firstLine, lines.length); index < lines.length; index += 1) {
          let value: unknown;
          try {
            value = JSON.parse(lines[index]!);
          } catch {
            continue;
          }
          if (!record(value) || value.id !== id) continue;
          const reply = value as unknown as AccessibilityReply;
          if (reply.ok !== true) throw new Error(`AT-SPI snapshot failed (${reply.code ?? "error"}): ${reply.error ?? "unspecified helper error"}`);
          if (record(reply.tree) && reply.tree.truncated === true) {
            throw new Error(`AT-SPI snapshot for process ${pid} was truncated at the fixture's node/depth bound.`);
          }
          return parseNode(reply.tree);
        }
        await Bun.sleep(20);
      }
      throw new Error(`AT-SPI snapshot for process ${pid} exceeded ${timeoutMs}ms.`);
    } finally {
      this.#busy = false;
    }
  }

  async waitForRegistry(nonAccessiblePid: number): Promise<void> {
    try {
      await this.snapshot(nonAccessiblePid);
    } catch (error) {
      if (/AT-SPI snapshot failed \(process-not-found\):/.test(String(error))) return;
      throw error;
    }
    throw new Error(`AT-SPI unexpectedly reported the runner PID ${nonAccessiblePid} as an application.`);
  }

  close(): void {
    this.#closed = true;
  }
}

export function walkAccessibilityTree(root: AccessibilityNode): AccessibilityNode[] {
  const result: AccessibilityNode[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    result.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index]!);
  }
  return result;
}
