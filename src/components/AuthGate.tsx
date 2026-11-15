import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { Mode } from "../auth/client.js";
import { useAuthStore } from "../store/authStore.js";
import { Button, Field } from "./controls.js";

/** Nothing below this renders until the server says who is signed in. */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const check = useAuthStore((s) => s.check);

  useEffect(() => {
    void check();
  }, [check]);

  if (status === "checking") return <Centered><p className="text-sm text-faint">Checking your sign-in…</p></Centered>;
  if (status === "unreachable") return <Unreachable onRetry={() => void check()} />;
  if (status === "signedOut") return <SignIn />;
  // SEAM (#39, #38): when the API reports that an admin reset this account's password, route to a
  // change-password form here instead of the app. /api/auth/me carries no such flag yet.
  return children;
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <Centered>
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-xl font-semibold text-fg">Can't reach the server</h1>
        <p className="text-sm text-muted">songs-teacher needs its server to check who you are. Nothing is lost: your work stays on this machine.</p>
        <Button variant="primary" onClick={onRetry}>Retry</Button>
      </div>
    </Centered>
  );
}

function SignIn() {
  const submit = useAuthStore((s) => s.submit);
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const signup = mode === "signup";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const failure = await submit(mode, username, password);
    setBusy(false);
    setError(failure);
  }

  function switchMode() {
    setMode(signup ? "login" : "signup");
    setError(null);
  }

  return (
    <Centered>
      <form className="flex w-full max-w-xs flex-col gap-3" onSubmit={(e) => void onSubmit(e)} aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} className="text-center text-2xl font-semibold text-fg">{signup ? "Create an account" : "Sign in"}</h1>
        <p className="text-center text-sm text-muted">to songs-teacher</p>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Username
          <Field autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} invalid={!!error} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Password
          <Field type="password" autoComplete={signup ? "new-password" : "current-password"} required value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!error} />
        </label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "One moment…" : signup ? "Create account" : "Sign in"}
        </Button>
        <Button variant="subtle" onClick={switchMode} disabled={busy}>
          {signup ? "I already have an account" : "Create an account"}
        </Button>
      </form>
    </Centered>
  );
}

/** "Signed in as …" and the way out. */
export function AccountBadge({ onAccount }: { onAccount?: () => void }) {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  async function leave() {
    setBusy(true);
    const failure = await signOut();
    setBusy(false);
    setError(failure);
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span>Signed in as <strong className="font-semibold text-fg">{user.username}</strong></span>
      {onAccount && <Button variant="subtle" size="sm" onClick={onAccount}>Account</Button>}
      <Button variant="subtle" size="sm" onClick={() => void leave()} disabled={busy}>Sign out</Button>
      {error && <span role="alert" className="text-danger">{error}</span>}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-screen items-center justify-center px-6">{children}</div>;
}
