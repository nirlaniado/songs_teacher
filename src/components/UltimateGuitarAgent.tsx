import { useEffect, useState } from "react";
import type { AgentJob, ChordResult } from "../ug/types.js";
import { useDeckStore } from "../store/deckStore.js";
import { Button, Field, buttonClass } from "./controls.js";

// Sends a JSON request to the local agent service with the required header and converts network or response errors into a user-facing message.
async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/ug/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "X-UG-Agent": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new Error("השירות המקומי אינו זמין. הפעל npm run dev:agent."); }
  let data;
  try { data = await response.json(); } catch { throw new Error("השירות המקומי אינו זמין. הפעל npm run dev:agent."); }
  if (!response.ok) throw new Error(data.error ?? "הבקשה נכשלה.");
  return data as T;
}
// Creates and downloads a JSON file from the result, then releases the temporary download URL.
function download(result: ChordResult) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `ultimate-guitar-${result.source.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Renders the agent screen: song input, progress, login completion, version selection, and chords with source details.
export function UltimateGuitarAgent({ onBack, onDeckCreated }: { onBack: () => void; onDeckCreated: () => void }) {
  const [query, setQuery] = useState("VIVA LA VIDA — COLDPALY");
  const [job, setJob] = useState<AgentJob | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [mp3, setMp3] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressDetail, setProgressDetail] = useState<string | undefined>();
  const attached = useDeckStore((s) => s.attached);
  const createDeckFromChords = useDeckStore((s) => s.createDeckFromChords);

  // Builds a presentation from the extracted chords and opens it in the editor.
  // The MP3 is required: the store analyses it and cues every slide to the
  // song's sections before saving, so the deck opens already synced.
  async function createPresentation(result: ChordResult) {
    if (!mp3) return;
    setCreating(true);
    setProgress(0);
    setProgressDetail(undefined);
    try {
      await createDeckFromChords(result, mp3, (fraction, detail) => { setProgress(fraction); setProgressDetail(detail); });
      onDeckCreated();
    } finally {
      setCreating(false);
    }
  }

  // On entry, checks service availability and restores a previous request for this browser tab if its ID was saved.
  useEffect(() => {
    let stopped = false;
    void request<{ agentApiKeyConfigured: boolean }>("status").then(status => {
      if (stopped) return;
      setAvailable(true);
      if (!status.agentApiKeyConfigured) setError("חסר OPENROUTER_API_KEY ב־ENV של השירות המקומי.");
    }).catch(e => { if (!stopped) { setAvailable(false); setError(e.message); } });
    const saved = sessionStorage.getItem("ug-agent-job");
    if (saved) void request<AgentJob>(`jobs/${saved}`).then(j => { if (!stopped) setJob(j); }).catch(() => sessionStorage.removeItem("ug-agent-job"));
    return () => { stopped = true; };
  }, []);

  // Polls while the request is running and stops when the screen unmounts or the request status changes.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    // Fetches the latest job status and updates the display. Schedules another check only after the current one finishes.
    async function poll() {
      try {
        const next = await request<AgentJob>(`jobs/${job!.id}`);
        if (stopped) return;
        setJob(next); setError(null);
        if (next.status === "running") timeout = setTimeout(() => void poll(), 1000);
      } catch (e) {
        if (!stopped) { setError(e instanceof Error ? e.message : "לא ניתן לבדוק את מצב הבקשה."); timeout = setTimeout(() => void poll(), 3000); }
      }
    }
    timeout = setTimeout(() => void poll(), 500);
    return () => { stopped = true; clearTimeout(timeout); };
  }, [job?.id, job?.status]);

  // Starts a new search or resumes an existing request, saving its ID so it can be restored after a tab refresh.
  async function run(action: "start" | "resume", candidateId?: string) {
    setPending(true); setError(null); setCopied(false);
    try {
      const next = await request<AgentJob>(action === "start" ? "jobs" : `jobs/${job!.id}/resume`, action === "start" ? { query } : { candidateId });
      setAvailable(true); setJob(next); sessionStorage.setItem("ug-agent-job", next.id);
    } catch (e) { setError(e instanceof Error ? e.message : "הפעולה נכשלה."); }
    finally { setPending(false); }
  }
  // Asks the service to cancel the request, then clears local state and the saved ID after success.
  async function cancel() {
    if (!job) return;
    setPending(true);
    try { await request(`jobs/${job.id}/cancel`, {}); setJob(null); sessionStorage.removeItem("ug-agent-job"); }
    catch (e) { setError(e instanceof Error ? e.message : "הביטול נכשל."); }
    finally { setPending(false); }
  }
  const busy = pending || job?.status === "running";
  const result = job?.result;
  return (
    <main dir="rtl" className="mx-auto max-w-4xl space-y-6 p-6 text-fg md:p-10">
      <Button variant="subtle" onClick={onBack}>→ חזרה למצגות</Button>
      <header>
        <p className="mb-2 text-xs uppercase tracking-widest text-accent-light">Ultimate Guitar</p>
        <h1 className="text-3xl font-semibold">סוכן האקורדים</h1>
        <p className="mt-3 text-sm text-muted">תן לי שיר ואמן. אחפש קודם גרסה רשמית; אם אין, אבחר גרסת אקורדים לפי מספר הצפיות באתר.</p>
      </header>
      <form className="flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); void run("start"); }}>
        <label className="flex-1 space-y-2 text-sm">
          <span>שיר ואמן</span>
          <Field dir="auto" size="lg" value={query} onChange={e => setQuery(e.target.value)} required minLength={3} maxLength={500}
            className="w-full" placeholder="Viva La Vida — Coldplay" />
        </label>
        <Button type="submit" variant="primary" size="lg" className="self-end" disabled={busy || job?.status === "needs_login" || query.trim().length < 3}>
          {busy ? "הסוכן עובד…" : "מצא אקורדים"}
        </Button>
      </form>
      {error && <p role="alert" className="rounded-control border border-danger-soft bg-danger-soft p-4 text-sm text-danger">{error}</p>}
      {available === false && <p className="text-sm text-muted">לאחר הפעלת השירות אפשר לנסות שוב באמצעות ״מצא אקורדים״.</p>}
      {job && <section className="space-y-4 rounded-surface border border-line bg-panel p-5">
        {job.identity && <h2 dir="auto" className="font-semibold">{job.identity.title} — {job.identity.artist}</h2>}
        <p role="status" aria-live="polite" className={job.status === "error" ? "text-danger" : "text-success"}>{job.message}</p>
        {job.status === "needs_login" && <div className="flex gap-3">
          <Button variant="primary" size="lg" disabled={pending} onClick={() => void run("resume")}>השלמתי התחברות — המשך</Button>
          <Button variant="subtle" size="lg" disabled={pending} onClick={() => void cancel()}>ביטול הבקשה</Button>
        </div>}
        {job.status === "error" && <Button variant="primary" size="lg" disabled={pending} onClick={() => void run("resume")}>נסה שוב</Button>}
        {job.status === "needs_choice" && <ul className="space-y-3">
          {job.candidates?.map(c => <li key={`${c.official}:${c.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line p-3">
            <div><a href={c.url} target="_blank" rel="noreferrer" dir="auto" className="text-sm underline">{c.title} — {c.artist}</a>
              <p className="mt-1 text-xs text-muted">{c.official ? "Official באתר" : "גרסת משתמשים"} · גרסה {c.version ?? c.id} · {c.views === null ? "צפיות לא ידועות" : `${c.views.toLocaleString()} צפיות`}</p></div>
            <Button variant="primary" size="lg" disabled={pending} onClick={() => void run("resume", `${c.official}:${c.id}`)}>בחר גרסה</Button>
          </li>)}
        </ul>}
        {!!job.events.length && <details className="text-xs text-muted"><summary className="cursor-pointer">מה הסוכן בדק</summary><ol className="mt-2 list-inside list-decimal space-y-1">{job.events.map((event, i) => <li key={i}>{event}</li>)}</ol></details>}
      </section>}
      {result && <section className="space-y-4 rounded-surface border border-line p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`rounded-control px-3 py-1 text-sm ${result.source.official ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>{result.source.official ? "Official באתר" : "גרסה לא רשמית"}</span>
          <a href={result.source.url} target="_blank" rel="noreferrer" className="text-sm underline">פתח את המקור</a>
        </div>
        {result.warning && <p role="alert" className="rounded-control bg-warning-soft p-3 text-warning">{result.warning}</p>}
        <p className="text-sm text-muted">קאפו: {result.capo ?? "לא צוין"} · כיוון: {result.tuning ?? "לא צוין"} · סולם: {result.key ?? "לא צוין"}</p>
        <p className="text-xs text-faint">בחירה: {result.selection === "official" ? "גרסה רשמית" : result.selection === "most_viewed" ? "מספר הצפיות הגבוה ביותר" : "בחירה ידנית"} · צפיות: {result.source.views?.toLocaleString() ?? "לא ידוע"} · נשלף: {new Date(result.retrievedAt).toLocaleString("he-IL")}</p>
        <pre dir="ltr" className="overflow-x-auto rounded-control bg-canvas p-4 text-left font-mono text-sm leading-7">{result.chart}</pre>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" onClick={() => download(result)}>הורד JSON</Button>
          <Button size="lg" onClick={() => { void navigator.clipboard.writeText(result.chart).then(() => setCopied(true)).catch(() => setError("לא ניתן להעתיק. אפשר להוריד JSON.")); }}>{copied ? "הועתק" : "העתק אקורדים"}</Button>
          {/* English by request, unlike the rest of this screen. */}
          <label dir="ltr" className={buttonClass({ size: "lg" })}>
            {mp3 ? `MP3: ${mp3.name}` : "Choose MP3 (required)"}
            <input type="file" accept="audio/*" className="sr-only" onChange={(e) => setMp3(e.target.files?.[0] ?? null)} />
          </label>
          <Button dir="ltr" variant="primary" size="lg" disabled={!attached || !mp3 || creating} onClick={() => void createPresentation(result)}>
            {creating ? `${progressDetail ?? "Syncing to the music"}… ${Math.round(progress * 100)}%` : "Create Presentation"}
          </Button>
          {!attached && <span dir="ltr" className="text-xs text-faint">Open a library folder first</span>}
          {attached && !mp3 && <span dir="ltr" className="text-xs text-faint">Choose the song's MP3 so the slides can be synced to it</span>}
          <p dir="ltr" className="basis-full text-xs text-faint">
            The slides are timed by finding the lyrics in the MP3, in this browser: nothing is uploaded. The first time, a
            ~91MB model is downloaded and kept. If too few sections are found, the music alone is used.
          </p>
        </div>
      </section>}
    </main>
  );
}
