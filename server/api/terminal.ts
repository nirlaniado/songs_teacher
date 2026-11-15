import { createInterface } from "node:readline/promises";
import type { Prompts } from "./makeAdmin.js";

interface Input extends NodeJS.ReadableStream { isTTY?: boolean; setRawMode?(on: boolean): unknown }

/** Reads one line from a terminal without echoing it. Refuses anything that isn't a terminal, such as a pipe. */
export function readSecret(question: string, input: Input = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<string> {
  const setRawMode = input.setRawMode?.bind(input);
  if (!input.isTTY || !setRawMode) return Promise.reject(new Error("The password must be typed at a terminal."));
  return new Promise((resolve, reject) => {
    let value: string[] = [];
    let done = false;
    const finish = (settle: () => void, newline = true) => {
      if (done) return;
      done = true;
      input.off("data", onData);
      input.off("error", onError);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.pause();
      setRawMode(false);
      if (newline) output.write("\n");
      settle();
    };
    const onError = (error: Error) => finish(() => reject(error), false);
    const onEnd = () => finish(() => reject(new Error("The input closed before the password was entered.")), false);
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish(() => resolve(value.join("")));
        if (ch === "\u0003") return finish(() => reject(new Error("Cancelled.")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value.push(ch);
      }
    };
    setRawMode(true);
    try {
      input.on("data", onData);
      input.on("error", onError);
      input.on("end", onEnd);
      input.on("close", onEnd);
      output.write(question);
      input.resume();
    } catch (error) {
      finish(() => reject(error), false);
    }
  });
}

export const terminalPrompts: Prompts = {
  async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  secret: (question) => readSecret(question),
  say: (line) => console.log(line),
};
