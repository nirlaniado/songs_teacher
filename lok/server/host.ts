/**
 * Supervises the C++ LOK host (ADR-002 §5).
 *
 * This is the ONLY module that knows the host's wire protocol, and the only
 * place LibreOffice concepts (`.uno:` commands, slide parts) appear. Callers
 * get `duplicateSlide(i)`, never `.uno:DuplicatePage` — ADR-002 §3.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";

export interface HostOptions {
  /** argv for the host process — the native binary in dev; a container
   *  entrypoint once packaging returns (deferred, see CLAUDE.md). */
  command: string;
  args: string[];
  /** Fails a wedged LOK rather than letting it wedge the app (ADR-002 §12). */
  requestTimeoutMs?: number;
}

/** One LOK callback, forwarded verbatim — see host.cpp's EVENT line comment
 *  for why event-before-response ordering can be relied on. */
export interface HostEvent {
  type: string;
  payload: string;
}

class HostError extends Error {}

export class LokHost extends EventEmitter {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #lines: Interface | null = null;
  /** Serialises requests: the protocol is one line in, one line out, so
   *  concurrent writers would interleave and mis-attribute replies. */
  #queue: Promise<unknown> = Promise.resolve();
  #crashes: number[] = [];

  constructor(private readonly opts: HostOptions) {
    super();
  }

  get running(): boolean {
    return this.#proc !== null && !this.#proc.killed;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const proc = spawn(this.opts.command, this.opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#proc = proc;
    this.#lines = createInterface({ input: proc.stdout });

    proc.stderr.on("data", (b: Buffer) => {
      // LibreOffice is chatty on stderr; surface it without letting it
      // masquerade as protocol output.
      const s = b.toString().trim();
      if (s) console.error(`[host] ${s}`);
    });

    proc.on("exit", (code, signal) => {
      console.error(`[host] exited code=${code} signal=${signal}`);
      this.#proc = null;
      this.#lines = null;
      this.#crashes.push(Date.now());
    });

    // The host prints READY once LOK has initialised. Waiting for it means a
    // slow LibreOffice start can never be mistaken for a protocol error.
    const ready = await this.#readResponseLine(60_000);
    if (ready.trim() !== "READY") {
      throw new HostError(`host did not report READY (got: ${ready})`);
    }
  }

  /** ADR-002 §5: restart, but refuse to thrash. */
  async restart(): Promise<void> {
    const recent = this.#crashes.filter((t) => Date.now() - t < 60_000);
    if (recent.length > 3) {
      throw new HostError("host crashed more than 3 times in 60s — not retrying");
    }
    this.stop();
    await this.start();
  }

  stop(): void {
    if (!this.#proc) return;
    const proc = this.#proc;
    this.#proc = null;
    this.#lines = null;
    try {
      proc.stdin.write("QUIT\n");
    } catch {
      /* already gone */
    }
    // Grace period, then insist.
    const t = setTimeout(() => proc.kill("SIGKILL"), 2000);
    proc.once("exit", () => clearTimeout(t));
  }

  /**
   * Reads one line, transparently absorbing any `EVENT <type> <payload>`
   * lines along the way rather than returning one to the caller — the host
   * emits those as a side effect of MOUSE/KEY/UNO and they always arrive
   * *before* that command's own OK/ERR line (see host.cpp's top comment for
   * why the single-threaded, synchronous host guarantees that ordering).
   * Each one is re-emitted here as a 'lokevent' for whoever wants it (the
   * server's WebSocket broadcast), then reading continues for the real reply.
   */
  #readResponseLine(timeoutMs: number): Promise<string> {
    const lines = this.#lines;
    if (!lines) return Promise.reject(new HostError("host not running"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        lines.off("line", onLine);
        reject(new HostError(`host timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onLine = (line: string) => {
        if (line.startsWith("EVENT ")) {
          const rest = line.slice("EVENT ".length);
          const sp = rest.indexOf(" ");
          const type = sp === -1 ? rest : rest.slice(0, sp);
          const payload = sp === -1 ? "" : rest.slice(sp + 1);
          this.emit("lokevent", { type, payload } satisfies HostEvent);
          lines.once("line", onLine);
          return;
        }
        clearTimeout(timer);
        resolve(line);
      };
      lines.once("line", onLine);
    });
  }

  /** One request, one response, strictly serialised. */
  async send(message: string): Promise<string> {
    const run = async (): Promise<string> => {
      if (!this.running) await this.start();
      const proc = this.#proc;
      if (!proc) throw new HostError("host not running");

      proc.stdin.write(message + "\n");
      const reply = await this.#readResponseLine(this.opts.requestTimeoutMs ?? 30_000);

      if (reply.startsWith("OK")) return reply.slice(2).trim();
      if (reply.startsWith("ERR")) throw new HostError(reply.slice(3).trim());
      throw new HostError(`unparseable host reply: ${reply}`);
    };

    // Chain regardless of whether the previous call resolved or rejected, or
    // one failure would deadlock every request behind it.
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  // ---- domain-shaped API; callers never see `.uno:` --------------------

  async open(path: string): Promise<number> {
    return Number(await this.send(`OPEN ${path}`));
  }

  async slideName(index: number): Promise<string> {
    return this.send(`NAME ${index}`);
  }

  /** Document size in twips — NOT the render pixel size `render()` writes.
   *  A blank presentation measures 15875x8930 (Stage 0); a real file can be
   *  any size or aspect ratio, so callers must ask rather than assume. */
  async docSize(): Promise<{ w: number; h: number }> {
    const reply = await this.send("SIZE");
    const [w, h] = reply.split(" ").map(Number);
    return { w: w ?? 0, h: h ?? 0 };
  }

  async render(index: number, w: number, h: number, out: string): Promise<string> {
    return this.send(`RENDER ${index} ${w} ${h} ${out}`);
  }

  async duplicateSlide(index: number): Promise<number> {
    await this.send(`RENDER ${index} 1 1 /dev/null`); // selects the part
    return Number(await this.send(`UNO .uno:DuplicatePage`));
  }

  async deleteSlide(index: number): Promise<number> {
    await this.send(`RENDER ${index} 1 1 /dev/null`);
    return Number(await this.send(`UNO .uno:DeletePage`));
  }

  async saveAs(format: "odp" | "pptx" | "pdf", out: string): Promise<string> {
    return this.send(`SAVEAS ${format} ${out}`);
  }

  /** `type` matches host.cpp's MOUSE verb: DOWN, UP or MOVE. Coordinates are
   *  in twips (LOK's document space), not pixels — Stage 2's canvas owns
   *  that conversion, this layer stays a dumb pass-through. */
  async mouse(
    type: "DOWN" | "UP" | "MOVE",
    x: number,
    y: number,
    count: number,
    buttons: number,
    modifier: number,
  ): Promise<void> {
    await this.send(`MOUSE ${type} ${x} ${y} ${count} ${buttons} ${modifier}`);
  }

  /** `type` matches host.cpp's KEY verb: INPUT or UP. `charCode` is the
   *  Unicode code point for character entry, `keyCode` the virtual key for
   *  non-printable keys (0 for plain character input). */
  async key(type: "INPUT" | "UP", charCode: number, keyCode: number): Promise<void> {
    await this.send(`KEY ${type} ${charCode} ${keyCode}`);
  }

  // ---- Stage 2/3: toolbar commands, still domain-shaped -----------------
  // ADR-002 §3: TS above this file must never learn a `.uno:` string exists.
  // index.ts's /api/uno maps a symbolic command name to one of these, the
  // same way duplicateSlide()/deleteSlide() already hide `.uno:DuplicatePage`
  // above. Bold/Italic/Underline/Undo/Redo/Escape/SelectAll/Delete are among
  // the oldest, most stable command names in the whole UNO API; `.uno:Rect`
  // was measured working directly in Stage 0 (LOK_CAPABILITY_MATRIX.md §2).
  // `.uno:Text` (draw-mode text box) and the rest are unverified by a probe —
  // lok/tests/smoke.mjs exercises each one with a real pixel-diff check
  // before Stage 2/3 is reported as working, same discipline as Stage 0.
  async bold(): Promise<number> { return Number(await this.send(`UNO .uno:Bold`)); }
  async italic(): Promise<number> { return Number(await this.send(`UNO .uno:Italic`)); }
  async underline(): Promise<number> { return Number(await this.send(`UNO .uno:Underline`)); }
  async undo(): Promise<number> { return Number(await this.send(`UNO .uno:Undo`)); }
  async redo(): Promise<number> { return Number(await this.send(`UNO .uno:Redo`)); }
  async escape(): Promise<number> { return Number(await this.send(`UNO .uno:Escape`)); }
  async selectAll(): Promise<number> { return Number(await this.send(`UNO .uno:SelectAll`)); }
  async deleteSelection(): Promise<number> { return Number(await this.send(`UNO .uno:Delete`)); }
  async startDrawRectangle(): Promise<number> { return Number(await this.send(`UNO .uno:Rect`)); }
  async startInsertTextBox(): Promise<number> { return Number(await this.send(`UNO .uno:Text`)); }
}

export { HostError };
