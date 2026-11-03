const MAX_RENDERERS = 2;
const MAX_DIMENSION = 1_000;

type Waiter = {
  signal: AbortSignal | undefined;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: (() => void) | null;
};

let activeRenderers = 0;
const rendererWaiters: Waiter[] = [];

function abortError(): DOMException {
  return new DOMException("Session history rendering was cancelled", "AbortError");
}

function acquireRenderer(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (activeRenderers < MAX_RENDERERS) {
    activeRenderers++;
    return Promise.resolve(rendererRelease());
  }
  const pending = Promise.withResolvers<() => void>();
  const waiter: Waiter = { signal, resolve: pending.resolve, reject: pending.reject, abort: null };
  if (signal) {
    waiter.abort = () => {
      const index = rendererWaiters.indexOf(waiter);
      if (index >= 0) rendererWaiters.splice(index, 1);
      pending.reject(abortError());
    };
    signal.addEventListener("abort", waiter.abort, { once: true });
  }
  rendererWaiters.push(waiter);
  return pending.promise;
}

function rendererRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    while (rendererWaiters.length > 0) {
      const waiter = rendererWaiters.shift()!;
      if (waiter.signal?.aborted) {
        waiter.abort && waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.reject(abortError());
        continue;
      }
      if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.resolve(rendererRelease());
      return;
    }
    activeRenderers--;
  };
}

function invalidRequest(): Response {
  return new Response("Invalid session history render request", { status: 400 });
}

/**
 * Render a saved transcript through OMP's production, offline transcript renderer.
 * The returned body streams stdout without retaining the full transcript in memory.
 */
export async function renderSessionHistory(options: {
  file: string;
  cols: number;
  rows: number;
  omp: string;
  args?: string[];
  signal?: AbortSignal;
}): Promise<Response> {
  const { file, omp, args = [], signal } = options;
  const { cols, rows } = options;
  if (
    !file || !omp || !Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) ||
    cols < 1 || rows < 1 || cols > MAX_DIMENSION || rows > MAX_DIMENSION
  ) return invalidRequest();
  if (signal?.aborted) return new Response(null, { status: 499 });

  let release: (() => void) | null = null;
  let child: Bun.Subprocess | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abortChild);
    release?.();
    release = null;
  };
  const abortChild = () => {
    child?.kill("SIGKILL");
    void reader?.cancel().catch(() => undefined).finally(async () => {
      await child?.exited.catch(() => undefined);
      finish();
    });
  };

  try {
    release = await acquireRenderer(signal);
    if (signal?.aborted) {
      finish();
      return new Response(null, { status: 499 });
    }
    const subprocess = Bun.spawn([omp, ...args, "render", file, "--width", String(cols), "--height", String(rows)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        PI_FORCE_IMAGE_PROTOCOL: process.env.PI_FORCE_IMAGE_PROTOCOL ?? "iterm2",
      },
    });
    child = subprocess;
    const output = subprocess.stdout.getReader();
    reader = output;
    signal?.addEventListener("abort", abortChild, { once: true });
    if (signal?.aborted) abortChild();

    const first = await output.read();
    if (first.done) {
      const exitCode = await child.exited;
      finish();
      if (signal?.aborted) return new Response(null, { status: 499 });
      if (exitCode !== 0) return new Response("OMP could not render this session history", { status: 502 });
      return new Response(null, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first.value);
      },
      async pull(controller) {
        try {
          const next = await output.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          const exitCode = await subprocess.exited;
          finish();
          if (exitCode !== 0) controller.error(new Error(`OMP history renderer exited with status ${exitCode}`));
          else controller.close();
        } catch (error) {
          subprocess.kill("SIGKILL");
          await subprocess.exited.catch(() => undefined);
          finish();
          controller.error(error);
        }
      },
      async cancel() {
        subprocess.kill("SIGKILL");
        await output.cancel().catch(() => undefined);
        await subprocess.exited.catch(() => undefined);
        finish();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch {
    child?.kill("SIGKILL");
    await child?.exited.catch(() => undefined);
    await reader?.cancel().catch(() => undefined);
    finish();
    if (signal?.aborted) return new Response(null, { status: 499 });
    return new Response("OMP could not render this session history", { status: 502 });
  }
}
