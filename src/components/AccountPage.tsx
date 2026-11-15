import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useAuthStore } from "../store/authStore.js";
import { Button, Field } from "./controls.js";

export function AccountPage({ onBack }: { onBack: () => void }) {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;
  return (
    <div className="h-screen overflow-y-auto">
      <div className="mx-auto flex max-w-md flex-col gap-8 px-6 py-8">
        <div>
          <Button variant="subtle" size="sm" onClick={onBack}>← Back</Button>
          <h1 className="mt-4 text-2xl font-semibold text-fg">Your account</h1>
          <p className="text-sm text-muted">Signed in as <strong className="font-semibold text-fg">{user.username}</strong></p>
        </div>
        <ChangePassword />
        <SignOutEverywhere />
        {user.admin
          ? <p className="text-sm text-faint">This is the admin account, so it can't be deleted.</p>
          : <DeleteAccount username={user.username} />}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t border-line pt-6">
      <h2 id={id} className="text-lg font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1 text-sm text-muted">{label}{children}</label>;
}

function Problem({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-sm text-danger">{error}</p> : null;
}

/** Busy and error state around one store action that returns the error to show, or null. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    const failure = await action();
    setBusy(false);
    setError(failure);
    return failure === null;
  }
  return { busy, error, setError, run };
}

function ChangePassword() {
  const change = useAuthStore((s) => s.changePassword);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useAction();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setDone(false);
    if (next !== repeat) return setError("The new passwords don't match.");
    if (await run(() => change(current, next))) {
      setCurrent("");
      setNext("");
      setRepeat("");
      setDone(true);
    }
  }

  return (
    <Section title="Change password">
      <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)}>
        <Labelled label="Current password">
          <Field type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Labelled>
        <Labelled label="New password">
          <Field type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
        </Labelled>
        <Labelled label="Repeat new password">
          <Field type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </Labelled>
        <Problem error={error} />
        {done && <p role="status" className="text-sm text-muted">Password changed. Every other browser and device signed in to this account has been signed out.</p>}
        <Button type="submit" variant="primary" disabled={busy}>Change password</Button>
      </form>
    </Section>
  );
}

function SignOutEverywhere() {
  const signOutEverywhere = useAuthStore((s) => s.signOutEverywhere);
  const { busy, error, run } = useAction();
  return (
    <Section title="Sign out everywhere">
      <p className="text-sm text-muted">Signs out every browser and device signed in to this account, this one included.</p>
      <Problem error={error} />
      <Button disabled={busy} onClick={() => void run(signOutEverywhere)}>Sign out everywhere</Button>
    </Section>
  );
}

function DeleteAccount({ username }: { username: string }) {
  const remove = useAuthStore((s) => s.deleteAccount);
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const { busy, error, run } = useAction();
  const ready = typed === username && password !== "";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (ready) void run(() => remove(password));
  }

  return (
    <Section title="Delete account">
      <p className="text-sm text-muted">
        Deletes your account and signs it out everywhere. This can't be undone. Your presentations and songs stay on this
        computer: they were never stored on the server.
      </p>
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <Labelled label="Password">
          <Field type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Labelled>
        <Labelled label={`Type ${username} to confirm`}>
          <Field autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Labelled>
        <Problem error={error} />
        <Button type="submit" variant="destructive" disabled={busy || !ready}>Delete my account</Button>
      </form>
    </Section>
  );
}
