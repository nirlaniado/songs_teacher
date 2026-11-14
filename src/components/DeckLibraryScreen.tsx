import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { filterDecks, newestFirst, waveformBars, type LibraryView } from "../deck/library.js";
import type { DeckSummary, Slide, Theme } from "../schema/deck.js";
import { useDeckStore } from "../store/deckStore.js";
import { Button, Field } from "./controls.js";
import { SlideRenderer, imagePathsOf } from "./deck/SlideRenderer.js";
import { useDeckAssets } from "./deck/useDeckAssets.js";
import { Icon } from "./icons.js";

/** A row and a card both fit a 16:9 box to these, because a slide is never cropped to suit a layout. */
const ROW_THUMB_SCALE = 0.1;
const CARD_THUMB_SCALE = 0.125;
const ROW_BARS = 110;
const CARD_BARS = 80;

/** `undefined` while loading; a null slide is a deck that has none, or could not be read. */
export type DeckCover = { slide: Slide | null; theme: Theme | null } | undefined;

/** `DeckSummary` has no slides in it, and carrying them there would be a schema change for one screen. */
function useDeckCover(id: string, updatedAt: string): DeckCover {
  const adapter = useDeckStore((s) => s.adapter);
  const [cover, setCover] = useState<DeckCover>();
  useEffect(() => {
    let stale = false;
    adapter.readDeck(id).then(
      (deck) => !stale && setCover({ slide: deck.slides[0] ?? null, theme: deck.theme }),
      () => !stale && setCover({ slide: null, theme: null }),
    );
    return () => {
      stale = true;
    };
  }, [adapter, id, updatedAt]);
  return cover;
}

export function DeckThumbnail({
  cover,
  scale,
  assetUrls,
}: {
  cover: DeckCover;
  scale: number;
  assetUrls?: Record<string, string>;
}) {
  if (cover?.slide && cover.theme) {
    return (
      <div className="deck-thumb" aria-hidden="true">
        <SlideRenderer slide={cover.slide} theme={cover.theme} scale={scale} assetUrls={assetUrls} className="ring-1 ring-line" />
      </div>
    );
  }
  return (
    <div className="deck-thumb deck-thumb-empty" aria-hidden="true" style={{ width: 1280 * scale, height: 720 * scale }}>
      {cover && <Icon name="music" size={20} />}
    </div>
  );
}

/** Ornament, drawn from the deck id: it never shows a time, and a silent deck gets a flat line rather than a sound it lacks. */
export function Waveform({ seed, bars, silent }: { seed: string; bars: number; silent: boolean }) {
  const gradient = `wave${useId().replace(/\W/g, "")}`;
  const heights = useMemo(() => (silent ? Array<number>(bars).fill(0.08) : waveformBars(seed, bars)), [seed, bars, silent]);
  return (
    <svg
      className={silent ? "waveform waveform-silent" : "waveform"}
      viewBox={`0 0 ${bars * 3} 24`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {!silent && (
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="0" x2={bars * 3} y1="0" y2="0">
          <stop className="waveform-from" offset="0" />
          <stop className="waveform-mid" offset="0.55" />
          <stop className="waveform-to" offset="1" />
        </linearGradient>
      )}
      <g fill={silent ? "currentColor" : `url(#${gradient})`}>
        {heights.map((height, i) => (
          <rect key={i} x={i * 3} y={12 - height * 12} width="1.3" height={height * 24} rx="0.65" />
        ))}
      </g>
    </svg>
  );
}

function DeckMenu({ title, onDelete }: { title: string; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={root}
      className="deck-menu"
      onBlur={(e) => {
        if (open && !root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Button
        ref={trigger}
        size="sm"
        icon
        aria-label={`More actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" />
      </Button>
      {open && (
        <div className="pop deck-menu-list" role="menu" aria-label={`Actions for ${title}`}>
          <button
            ref={first}
            role="menuitem"
            className="menu-item menu-item-danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete <Icon name="trash" />
          </button>
        </div>
      )}
    </div>
  );
}

function DeckBadges({ deck }: { deck: DeckSummary }) {
  return (
    <div className="deck-badges">
      <span className="badge">
        <Icon name="file" size={12} /> {deck.slideCount} slide{deck.slideCount === 1 ? "" : "s"}
      </span>
      {deck.hasAudio && (
        <span className="badge badge-accent">
          <Icon name="music" size={12} /> has audio
        </span>
      )}
    </div>
  );
}

export function DeckItem({
  deck,
  view,
  cover,
  assetUrls,
  onOpen,
  onDelete,
}: {
  deck: DeckSummary;
  view: LibraryView;
  cover: DeckCover;
  assetUrls?: Record<string, string>;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const open = (
    <button className="deck-open" title={deck.title} onClick={onOpen}>
      {deck.title}
    </button>
  );
  const menu = <DeckMenu title={deck.title} onDelete={onDelete} />;

  if (view === "grid") {
    return (
      <li className="row deck-card">
        <DeckThumbnail cover={cover} scale={CARD_THUMB_SCALE} assetUrls={assetUrls} />
        <div className="deck-info">
          <div className="deck-card-head">
            {open}
            <div className="deck-actions">{menu}</div>
          </div>
          <DeckBadges deck={deck} />
          <Waveform seed={deck.id} bars={CARD_BARS} silent={!deck.hasAudio} />
        </div>
      </li>
    );
  }
  return (
    <li className="row deck-row">
      <DeckThumbnail cover={cover} scale={ROW_THUMB_SCALE} assetUrls={assetUrls} />
      <div className="deck-info">
        {open}
        <DeckBadges deck={deck} />
      </div>
      <Waveform seed={deck.id} bars={ROW_BARS} silent={!deck.hasAudio} />
      <div className="deck-date">
        Last updated
        <time dateTime={deck.updatedAt}>
          {new Date(deck.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
        </time>
      </div>
      <div className="deck-actions">
        {menu}
        <Button variant="primary" aria-label={`Open ${deck.title}`} onClick={onOpen}>
          Open <Icon name="arrowRight" />
        </Button>
      </div>
    </li>
  );
}

function LoadedDeck({ deck, view, onOpen, onDelete }: { deck: DeckSummary; view: LibraryView; onOpen: () => void; onDelete: () => void }) {
  const cover = useDeckCover(deck.id, deck.updatedAt);
  const assetUrls = useDeckAssets(imagePathsOf(cover?.slide ? [cover.slide] : [], cover?.theme ?? undefined), deck.id);
  return <DeckItem deck={deck} view={view} cover={cover} assetUrls={assetUrls} onOpen={onOpen} onDelete={onDelete} />;
}

/** No matches has to read as a result of the search, not as a library with nothing in it. */
export function DeckResultsEmpty({ query, onClear }: { query: string; onClear?: () => void }) {
  if (!query.trim()) {
    return <p className="deck-empty">No presentations yet. Name one above and hit Create.</p>;
  }
  return (
    <div className="deck-empty">
      <p>No presentations match “{query.trim()}”.</p>
      <Button size="sm" onClick={onClear}>
        Clear search
      </Button>
    </div>
  );
}

function Notice({ danger, children }: { danger?: boolean; children: ReactNode }) {
  return <p className={danger ? "hero-notice hero-notice-danger" : "hero-notice"}>{children}</p>;
}

/** The start screen: make a presentation, or find one. Roughly the role LibreOffice's Start Center plays. */
export function DeckLibraryScreen({ onOpen }: { onOpen: () => void }) {
  const decks = useDeckStore((s) => s.decks);
  const loading = useDeckStore((s) => s.loadingDecks);
  const error = useDeckStore((s) => s.error);
  const createDeck = useDeckStore((s) => s.createDeck);
  const openDeck = useDeckStore((s) => s.openDeck);
  const deleteDeck = useDeckStore((s) => s.deleteDeck);
  const detach = useDeckStore((s) => s.detach);
  const usingFallbackStorage = useDeckStore((s) => s.usingFallbackStorage);
  const importDeck = useDeckStore((s) => s.importDeck);
  const view = useDeckStore((s) => s.libraryView);
  const setView = useDeckStore((s) => s.setLibraryView);

  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const bundleInput = useRef<HTMLInputElement>(null);

  // In the render, never a selector: a filtered array is a fresh object, and Zustand would read that as a change forever.
  const shown = useMemo(() => newestFirst(filterDecks(decks, query)), [decks, query]);

  async function handleImport(file: File) {
    setImporting(true);
    try {
      await importDeck(file);
      onOpen();
    } finally {
      setImporting(false);
    }
  }

  async function create() {
    const name = title.trim() || "Untitled presentation";
    setCreating(true);
    try {
      await createDeck(name);
      setTitle("");
      onOpen();
    } finally {
      setCreating(false);
    }
  }

  async function open(id: string) {
    await openDeck(id);
    onOpen();
  }

  function remove(deck: DeckSummary) {
    if (confirm(`Delete "${deck.title}"? This cannot be undone.`)) void deleteDeck(deck.id);
  }

  return (
    <div className="library">
      <section className="hero">
        <div className="hero-art" />
        <div className="hero-photo" />
        <div className="hero-scrim" />
        <div className="library-width">
          <header className="topbar">
            <span className="wordmark">
              <Icon name="library" size={22} /> songs-teacher
            </span>
            <Button variant="subtle" size="sm" onClick={() => void detach()}>
              <Icon name="exit" /> Close library
            </Button>
          </header>

          <div className="hero-copy hero-rise">
            <p className="hero-eyebrow">Your music, in presentations</p>
            <h1 className="hero-title">
              Turn songs into <span className="hero-sweep">beautiful presentations</span>
            </h1>
            <p className="hero-subtitle">
              Slides that follow the music — build a deck, attach an MP3, cue each slide to a moment in the song.
            </p>
          </div>

          {usingFallbackStorage && (
            <Notice>
              This browser can't open a real folder, so presentations are stored inside the browser. Clearing site data
              will delete them. Chrome, Edge, or Brave keep them as files on disk.
            </Notice>
          )}
          {error && <Notice danger>{error}</Notice>}

          <form
            className="create-row"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="field-icon">
              <Icon name="file" size={16} />
              <Field
                size="lg"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="New presentation title…"
                aria-label="New presentation title"
              />
            </label>
            <Button variant="primary" size="lg" type="submit" disabled={creating}>
              <Icon name="plus" size={16} /> {creating ? "Creating…" : "Create"}
            </Button>
            <Button
              size="lg"
              onClick={() => bundleInput.current?.click()}
              disabled={importing}
              title="Open a .zip exported from songs-teacher"
            >
              <Icon name="upload" size={16} /> {importing ? "Importing…" : "Import…"}
            </Button>
            <input
              ref={bundleInput}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImport(f);
                e.target.value = "";
              }}
            />
          </form>
        </div>
      </section>

      <section className="deck-panel library-width" aria-labelledby="your-presentations">
        <div className="deck-panel-inner">
          <div className="deck-panel-head">
            <h2 className="deck-panel-title" id="your-presentations">
              <Icon name="layers" size={18} /> Your Presentations
            </h2>
            {decks.length > 0 && (
              <span className="deck-count" role="status">
                {query.trim() ? `${shown.length} of ${decks.length}` : `${decks.length} presentation${decks.length === 1 ? "" : "s"}`}
              </span>
            )}
            {decks.length > 0 && (
              <div className="deck-tools">
                <label className="field-icon deck-search">
                  <Icon name="search" />
                  <Field
                    size="md"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search presentations…"
                    aria-label="Search presentations"
                  />
                </label>
                <Button variant="subtle" icon pressed={view === "list"} aria-label="List view" title="List view" onClick={() => setView("list")}>
                  <Icon name="list" size={16} />
                </Button>
                <Button variant="subtle" icon pressed={view === "grid"} aria-label="Grid view" title="Grid view" onClick={() => setView("grid")}>
                  <Icon name="gridView" size={16} />
                </Button>
              </div>
            )}
          </div>

          {loading && decks.length === 0 && <p className="deck-empty">Loading…</p>}
          {!loading && shown.length === 0 && <DeckResultsEmpty query={query} onClear={() => setQuery("")} />}
          {shown.length > 0 && (
            <ul className={view === "grid" ? "deck-grid" : "deck-list"}>
              {shown.map((deck) => (
                <LoadedDeck key={deck.id} deck={deck} view={view} onOpen={() => void open(deck.id)} onDelete={() => remove(deck)} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
