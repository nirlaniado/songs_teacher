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
}

export const useAuthStore = create<AuthState>()((set) => ({
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
    set({ status: "signedOut", user: null });
    return null;
  },
}));
