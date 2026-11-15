import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Hasher } from "./auth";
import { makeAdmin, type Prompts } from "./makeAdmin";
import { MemoryStore } from "./store";
import { readSecret } from "./terminal";

const plain: Hasher = { hash: async (p) => `h:${p}`, verify: async (h, p) => h === `h:${p}` };

/** Scripted answers. Passwords come only from `secret` (no echo); `ask` is for the yes/no question. */
function scripted(answers: string[], secrets: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  const prompts: Prompts = {
    ask: async (q) => (asked.push(q), answers.shift() ?? ""),
    secret: async (q) => {
      asked.push(q);
      if (!secrets.length) throw new Error(`unexpected secret prompt: ${q}`);
      return secrets.shift()!;
    },
    say: (line) => void said.push(line),
  };
  return { prompts, said, asked, left: () => answers.length + secrets.length };
}
const run = async (store: MemoryStore, adminUsername: string | undefined, io: ReturnType<typeof scripted>) =>
  makeAdmin({ store, hasher: plain, adminUsername, prompts: io.prompts });

describe("api:make-admin", () => {
  it("refuses when ADMIN_USERNAME is unset, without asking anything", async () => {
    const io = scripted([], []);
    expect(await run(new MemoryStore(), undefined, io)).toBe(1);
    expect(io.said).toEqual(["ADMIN_USERNAME is not set. Add it to .env (see .env.example)."]);
    expect(io.asked).toEqual([]);
  });

  it("refuses an ADMIN_USERNAME that sign-up could never have accepted", async () => {
    const io = scripted([], []);
    expect(await run(new MemoryStore(), "the owner", io)).toBe(1);
    expect(io.said[0]).toMatch(/^ADMIN_USERNAME: Username must be/);
  });

  it("creates the account from a password typed twice without echo, and never prints it", async () => {
    const store = new MemoryStore();
    const io = scripted([], ["a strong password", "a strong password"]);
    expect(await run(store, "owner", io)).toBe(0);
    expect(io.asked).toEqual(["Password: ", "Repeat password: "]);
    expect(await store.findUser("owner")).toMatchObject({ username: "owner", passwordHash: "h:a strong password", disabled: false, mustChangePassword: false });
    expect(io.said).toEqual(['Admin account "owner" created.']);
    expect(io.said.join()).not.toContain("a strong password");
  });

  it.each([
    ["mismatched", ["a strong password", "a strong pasword"], "The passwords don't match. Nothing changed."],
    ["too short (the sign-up rule)", ["short", "short"], "Password must be at least 10 characters. Nothing changed."],
  ])("refuses a %s password and creates nothing", async (_why, secrets, message) => {
    const store = new MemoryStore();
    const io = scripted([], secrets);
    expect(await run(store, "owner", io)).toBe(1);
    expect(io.said).toEqual([message]);
    expect(await store.findUser("owner")).toBeNull();
  });

  describe("when the account exists", () => {
    async function existing() {
      const store = new MemoryStore();
      const { id } = await store.createUser("Owner", "h:old password");
      await store.createSession("s1", id, new Date(Date.now() + 60_000));
      await store.adminChange(id, { action: "reset-password", passwordHash: "h:temporary" }, new Date());
      await store.createSession("s2", id, new Date(Date.now() + 60_000));
      return { store, id };
    }

    it.each(["", "n", "no", "maybe"])("only offers a new password, and %j changes nothing", async (answer) => {
      const { store } = await existing();
      const io = scripted([answer], []);
      expect(await run(store, "owner", io)).toBe(0);
      expect(io.asked).toEqual(['The admin account "Owner" already exists. Set a new password for it? [y/N] ']);
      expect(io.said).toEqual(["Nothing changed."]);
      expect((await store.findUser("owner"))!.passwordHash).toBe("h:temporary");
      expect(store.sessionCount()).toBe(1);
    });

    it.each(["y", "Y", "yes", " YES "])("sets the new password on %j, ending its sessions and clearing must-change", async (answer) => {
      const { store } = await existing();
      const io = scripted([answer], ["a new strong password", "a new strong password"]);
      expect(await run(store, "OWNER", io)).toBe(0);
      expect(await store.findUser("owner")).toMatchObject({ passwordHash: "h:a new strong password", mustChangePassword: false });
      expect(store.sessionCount()).toBe(0);
      expect(io.said).toEqual(['New password set for "Owner". Every session of that account has been signed out.']);
    });
  });
});

describe("readSecret", () => {
  function tty() {
    const input = Object.assign(new PassThrough(), { isTTY: true, raw: [] as boolean[], setRawMode(on: boolean) { this.raw.push(on); return this; } });
    const output = new PassThrough();
    let shown = "";
    output.on("data", (d) => (shown += String(d)));
    return { input, output, shown: () => shown };
  }

  it("reads a line in raw mode without echoing it, honouring backspace", async () => {
    const t = tty();
    const secret = readSecret("Password: ", t.input, t.output);
    t.input.write("hunter22x\u007f2\r");
    expect(await secret).toBe("hunter222");
    expect(t.shown()).toBe("Password: \n");
    expect(t.input.raw).toEqual([true, false]);
  });

  it("is cancelled by Ctrl+C, leaving raw mode", async () => {
    const t = tty();
    const secret = readSecret("Password: ", t.input, t.output);
    t.input.write("abc\u0003");
    await expect(secret).rejects.toThrow("Cancelled.");
    expect(t.input.raw).toEqual([true, false]);
  });

  it("refuses input that isn't a terminal, such as a pipe", async () => {
    const piped = new PassThrough();
    await expect(readSecret("Password: ", piped, new PassThrough())).rejects.toThrow("The password must be typed at a terminal.");
  });
});
