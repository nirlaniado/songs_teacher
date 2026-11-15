import type { Hasher } from "./auth.js";
import { Credentials, NewPassword } from "./rules.js";
import { UsernameTaken, type AuthStore } from "./store.js";

/** The terminal, injected so the command can be tested without one. `secret` must not echo what is typed. */
export interface Prompts {
  ask(question: string): Promise<string>;
  secret(question: string): Promise<string>;
  say(line: string): void;
}

/**
 * Creates the ADMIN_USERNAME account, or sets a new password on it if it exists. The password is only ever typed
 * at the prompt, never taken from an argument or the environment. Returns the process exit code.
 */
export async function makeAdmin(options: { store: AuthStore; hasher: Hasher; adminUsername: string | undefined; prompts: Prompts }) {
  const { store, hasher, adminUsername, prompts } = options;
  if (!adminUsername) {
    prompts.say("ADMIN_USERNAME is not set. Add it to .env (see .env.example).");
    return 1;
  }
  const name = Credentials.shape.username.safeParse(adminUsername);
  if (!name.success) {
    prompts.say(`ADMIN_USERNAME: ${name.error.issues[0]!.message}`);
    return 1;
  }
  const existing = await store.findUser(adminUsername);
  if (existing) {
    const answer = await prompts.ask(`The admin account "${existing.username}" already exists. Set a new password for it? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      prompts.say("Nothing changed.");
      return 0;
    }
  }
  const password = await prompts.secret("Password: ");
  if ((await prompts.secret("Repeat password: ")) !== password) {
    prompts.say("The passwords don't match. Nothing changed.");
    return 1;
  }
  const rule = NewPassword.safeParse(password);
  if (!rule.success) {
    prompts.say(`${rule.error.issues[0]!.message} Nothing changed.`);
    return 1;
  }
  const passwordHash = await hasher.hash(password);
  if (existing) {
    await store.setPassword(existing.id, passwordHash);
    prompts.say(`New password set for "${existing.username}". Every session of that account has been signed out.`);
    return 0;
  }
  try {
    await store.createUser(adminUsername, passwordHash);
  } catch (error) {
    if (!(error instanceof UsernameTaken)) throw error;
    prompts.say(`"${adminUsername}" was created by someone else meanwhile. Run the command again to set its password.`);
    return 1;
  }
  prompts.say(`Admin account "${adminUsername}" created.`);
  return 0;
}
