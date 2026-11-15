import { create } from "zustand";
import * as api from "../auth/client.js";

// Who is signed in is session state, never deck data (hard rule 8). The cookie is httpOnly, so the
// server is the only source of truth: this store holds its last answer.
export type AuthStatus = "checking" | "signedOut" | "signedIn" | "unreachable";

interface AuthState {
  status: AuthStatus;
  user: api.User | null;
  check(): Promise<void>;
  /** Signs in or up; returns the error to show inline, or null once signed in. */
  submit(mode: api.Mode, username: string, password: string): Promise<string | null>;
  /** Returns the error to show, or null once signed out. */
  signOut(): Promise<string | null>;
  /** Each returns the error to show, or null on success. A session the server no longer knows signs out here too. */
  changePassword(current: string, next: string): Promise<string | null>;
  signOutEverywhere(): Promise<string | null>;
  deleteAccount(password: string): Promise<string | null>;
  /**
   * Acts on what a refusal says about this session: signed out (401), or held to a password change by an admin
   * reset (must_change_password), whatever this store believed before.
   */
  heard(refusal: api.Refusal): void;
}

export const useAuthStore = create<AuthState>()((set, get) => {
  const out = () => set({ status: "signedOut", user: null });
  const flag = (mustChangePassword: boolean) => {
    const { user } = get();
    if (user) set({ user: { ...user, mustChangePassword } });
  };
  const heard = (refusal: api.Refusal) => {
    if (refusal.signedOut) out();
    else if (refusal.mustChange) flag(true);
  };
  const settle = (done: api.Done, signsOut: boolean) => {
    if (done.ok) {
      if (signsOut) out();
      return null;
    }
    heard(done);
    return done.error;
  };
  return {
    status: "checking",
    user: null,

    async check() {
      set({ status: "checking" });
      const session = await api.currentSession();
      set(session.kind === "signedIn" ? { status: "signedIn", user: session.user } : { status: session.kind, user: null });
    },

    async submit(mode, username, password) {
      const outcome = await api.submit(mode, username, password);
      if (!outcome.ok) return outcome.error;
      set({ status: "signedIn", user: outcome.user });
      return null;
    },

    async signOut() {
      if (!(await api.signOut())) return "Couldn't sign out: the server didn't answer. Try again.";
      out();
      return null;
    },

    async changePassword(current, next) {
      const done = await api.changePassword(current, next);
      if (done.ok) flag(false);
      return settle(done, false);
    },
    async signOutEverywhere() {
      return settle(await api.signOutEverywhere(), true);
    },
    async deleteAccount(password) {
      return settle(await api.deleteAccount(password), true);
    },
    heard,
  };
});
