import { useId, useState, type FormEvent } from "react";
import { useAuthStore } from "../store/authStore.js";
import { Button, Field } from "./controls.js";

/**
 * Everything a signed-in account sees after an admin reset its password, until it chooses a new one. The server
 * refuses everything else meanwhile (must_change_password); this only says so.
 */
export function ForcedPasswordChange() {
  const user = useAuthStore((s) => s.user);
  const change = useAuthStore((s) => s.changePassword);
  const signOut = useAuthStore((s) => s.signOut);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    const failure = await action();
    setBusy(false);
    setError(failure);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) return setError("The new passwords don't match.");
    void run(() => change(current, next));
  }

  return (
    <div className="flex h-screen items-center justify-center px-6">
      <form className="flex w-full max-w-xs flex-col gap-3" onSubmit={onSubmit} aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} className="text-center text-2xl font-semibold text-fg">Choose a new password</h1>
        <p className="text-center text-sm text-muted">
          The admin reset the password for <strong className="font-semibold text-fg">{user?.username}</strong>. Choose
          your own to carry on.
        </p>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Temporary password
          <Field type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          New password
          <Field type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Repeat new password
          <Field type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy}>Set new password</Button>
        <Button variant="subtle" disabled={busy} onClick={() => void run(signOut)}>Sign out</Button>
      </form>
    </div>
  );
}
