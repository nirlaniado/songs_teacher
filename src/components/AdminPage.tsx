import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as admin from "../auth/admin.js";
import type { Answer, Refusal } from "../auth/client.js";
import { useAuthStore } from "../store/authStore.js";
import { Button, Field } from "./controls.js";

// The owner's panel. The server decides who may use it: every answer is read for 401 (signed out),
// must_change_password and 403 (not the admin), whatever the badge believed when it offered the way in.

type Tab = "users" | "audit";
const when = (iso: string) => new Date(iso).toLocaleString();
const pages = (total: number, perPage: number) => Math.max(1, Math.ceil(total / perPage));

export function AdminPage({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("users");
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <div className="h-screen overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
        <div>
          <Button variant="subtle" size="sm" onClick={onBack}>← Back</Button>
          <h1 className="mt-4 text-2xl font-semibold text-fg">Admin</h1>
        </div>
        {refused ? (
          <p role="alert" className="text-sm text-danger">{refused} This page is for the admin account only.</p>
        ) : (
          <>
            <div className="flex gap-2" role="group" aria-label="Admin views">
              <Button size="sm" pressed={tab === "users"} onClick={() => setTab("users")}>Users</Button>
              <Button size="sm" pressed={tab === "audit"} onClick={() => setTab("audit")}>Audit log</Button>
            </div>
            {tab === "users" ? <Users onRefused={setRefused} /> : <Audit onRefused={setRefused} />}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Loads a page of something and keeps only the latest answer. A refusal is passed to the auth store first, which
 * signs out or holds the account to a password change as the server says; a plain 403 refuses the whole page.
 */
function useListing<T>(load: () => Promise<Answer<T>>, onRefused: (why: string) => void) {
  const heard = useAuthStore((s) => s.heard);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const ticket = ++latest.current;
    const answer = await load();
    if (ticket !== latest.current) return;
    if (answer.ok) {
      setData(answer.data);
      setError(null);
      return;
    }
    heard(answer);
    if (answer.forbidden) onRefused(answer.error);
    else setError(answer.error);
  }, [load, heard, onRefused]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

function Users({ onRefused }: { onRefused: (why: string) => void }) {
  const heard = useAuthStore((s) => s.heard);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const load = useCallback(() => admin.listUsers(query, page), [query, page]);
  const { data, error, reload } = useListing(load, onRefused);
  const [pending, setPending] = useState<{ kind: "reset" | "delete"; user: admin.AccountRow } | null>(null);
  const [temporary, setTemporary] = useState<{ username: string; password: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act<T>(run: () => Promise<Answer<T>>, then?: (data: T) => void) {
    setBusy(true);
    const answer = await run();
    setBusy(false);
    setPending(null);
    if (answer.ok) {
      setActionError(null);
      then?.(answer.data);
    } else {
      heard(answer as Refusal);
      setActionError(answer.error);
    }
    void reload();
  }

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setQuery(search.trim());
    setPage(1);
  }

  const total = data ? pages(data.total, data.perPage) : 1;
  return (
    <section aria-label="Users" className="flex flex-col gap-4">
      <form className="flex gap-2" role="search" onSubmit={onSearch}>
        <Field type="search" aria-label="Search by username" placeholder="Search by username" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button type="submit">Search</Button>
      </form>
      {error && <Problem error={error} onRetry={() => void reload()} />}
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
      {pending && (
        <Confirm
          label={pending.kind === "reset" ? `Reset ${pending.user.username}'s password` : `Delete ${pending.user.username}`}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void (pending.kind === "reset"
            ? act(() => admin.resetPassword(pending.user.id), (d) => setTemporary({ username: pending.user.username, password: d.temporaryPassword }))
            : act(() => admin.deleteUser(pending.user.id)))}
        >
          {pending.kind === "reset"
            ? <>Reset the password of <strong>{pending.user.username}</strong>? Their sessions end, and they must choose a new password when they sign in with the temporary one.</>
            : <>Delete <strong>{pending.user.username}</strong> permanently? Their account and sessions are removed. This can't be undone.</>}
        </Confirm>
      )}
      {data && (
        <>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-faint">
              <tr>
                <th className="pb-2">Username</th>
                <th className="pb-2">Created</th>
                <th className="pb-2">Last sign-in</th>
                <th className="pb-2">Status</th>
                <th className="pb-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((user) => (
                <tr key={user.id} className="border-t border-line">
                  <td className="py-2 text-fg">{user.username}</td>
                  <td className="py-2 text-muted">{when(user.createdAt)}</td>
                  <td className="py-2 text-muted">{user.lastSignInAt ? when(user.lastSignInAt) : "Never"}</td>
                  <td className="py-2 text-muted">{user.disabled ? "Disabled" : user.mustChangePassword ? "Must change password" : "Active"}</td>
                  <td className="py-2">
                    {user.admin ? (
                      <span className="text-xs text-faint">Your account</span>
                    ) : (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="subtle" disabled={busy} aria-label={`${user.disabled ? "Enable" : "Disable"} ${user.username}`}
                          onClick={() => void act(() => admin.setDisabled(user.id, !user.disabled))}>
                          {user.disabled ? "Enable" : "Disable"}
                        </Button>
                        <Button size="sm" variant="subtle" disabled={busy} aria-label={`Reset ${user.username}'s password…`}
                          onClick={() => setPending({ kind: "reset", user })}>
                          Reset password…
                        </Button>
                        <Button size="sm" variant="destructive-subtle" disabled={busy} aria-label={`Delete ${user.username}…`}
                          onClick={() => setPending({ kind: "delete", user })}>
                          Delete…
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.users.length === 0 && <p className="text-sm text-faint">{query ? `No username contains "${query}".` : "No users."}</p>}
          <Pager page={page} pages={total} count={`${data.total} ${data.total === 1 ? "user" : "users"}`} onPage={setPage} />
        </>
      )}
      {temporary && <TemporaryPassword {...temporary} onClose={() => setTemporary(null)} />}
    </section>
  );
}

function Audit({ onRefused }: { onRefused: (why: string) => void }) {
  const [page, setPage] = useState(1);
  const load = useCallback(() => admin.listAudit(page), [page]);
  const { data, error, reload } = useListing(load, onRefused);
  const label: Record<string, string> = { disable: "Disabled", enable: "Enabled", "reset-password": "Reset password", delete: "Deleted" };
  return (
    <section aria-label="Audit log" className="flex flex-col gap-4">
      {error && <Problem error={error} onRetry={() => void reload()} />}
      {data && (
        <>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-faint">
              <tr><th className="pb-2">When</th><th className="pb-2">Action</th><th className="pb-2">User</th></tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.id} className="border-t border-line">
                  <td className="py-2 text-muted">{when(entry.at)}</td>
                  <td className="py-2 text-fg">{label[entry.action] ?? entry.action}</td>
                  <td className="py-2 text-muted">{entry.targetUsername} <span className="text-faint">#{entry.targetUserId}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.entries.length === 0 && <p className="text-sm text-faint">No admin actions yet.</p>}
          <Pager page={page} pages={pages(data.total, data.perPage)} count={`${data.total} ${data.total === 1 ? "entry" : "entries"}`} onPage={setPage} />
        </>
      )}
    </section>
  );
}

function Pager({ page, pages, count, onPage }: { page: number; pages: number; count: string; onPage: (page: number) => void }) {
  return (
    <nav aria-label="Pages" className="flex items-center gap-3 text-xs text-muted">
      <Button size="sm" variant="subtle" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page} of {pages} · {count}</span>
      <Button size="sm" variant="subtle" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </nav>
  );
}

function Problem({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <p role="alert" className="text-sm text-danger">{error}</p>
      <Button size="sm" onClick={onRetry}>Retry</Button>
    </div>
  );
}

function Confirm({ label, busy, onConfirm, onCancel, children }: {
  label: string; busy: boolean; onConfirm: () => void; onCancel: () => void; children: ReactNode;
}) {
  return (
    <div role="group" aria-label={`Confirm: ${label}`} className="flex flex-col gap-3 rounded-surface border border-line p-4 text-sm text-muted">
      <p>{children}</p>
      <div className="flex gap-2">
        <Button variant="destructive" disabled={busy} onClick={onConfirm}>{label}</Button>
        <Button variant="subtle" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** The temporary password, shown once. It lives only in this component's props and the parent's state. */
function TemporaryPassword({ username, password, onClose }: { username: string; password: string; onClose: () => void }) {
  const id = useId();
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/80 px-6" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="flex w-full max-w-sm flex-col gap-3 rounded-surface border border-line bg-panel p-6">
        <h2 id={`${id}-title`} className="text-lg font-semibold text-fg">Temporary password for {username}</h2>
        <Field readOnly aria-label="Temporary password" value={password} onFocus={(e) => e.currentTarget.select()} />
        <p className="text-sm text-muted">
          This is the only time it is shown: it isn't stored anywhere you can see it again. Give it to {username}; they
          must choose a new password when they sign in with it.
        </p>
        {copied === "yes" && <p role="status" className="text-xs text-muted">Copied.</p>}
        {copied === "failed" && <p role="status" className="text-xs text-danger">Couldn't copy. Select it and copy it by hand.</p>}
        <div className="flex gap-2">
          <Button onClick={() => void copy()}>Copy</Button>
          <Button variant="primary" autoFocus onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  );
}
