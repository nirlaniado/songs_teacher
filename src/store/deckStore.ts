import { create } from "zustand";
import {
  Deck,
  newDeck,
  SLIDE_H,
  SLIDE_W,
  type Background,
  type DeckSummary,
  type LayoutId,
  type Slide,
  type SlideElement,
  type Stem,
  type StemId,
  type Theme,
} from "../schema/deck.js";
import { initialStemState, sortStems, type StemState } from "../audio/mix.js";
import { applyLayout, layoutById } from "../deck/templates.js";
import { alignedFrame, boundsOf, slideBounds, type AlignMode } from "../deck/geometry.js";
import { bundleFilename, downloadBlob, exportDeckBundle, readDeckBundle } from "../deck/bundle.js";
import { chordDeckSlides, chordSectionPlan } from "../deck/fromChords.js";
import { cuesForAudio } from "../audio/autoCue.js";
import type { ChordResult } from "../ug/types.js";
import {
  sharedLibraryAdapter,
  isAnyLibrarySupported,
  isBrowserLibrarySupported,
  LibraryError,
  type AudioHandle,
  type LibraryAdapter,
} from "../adapters/index.js";

/**
 * Editor state for the presentation app.
 *
 * Mutations funnel through `#commit`, which snapshots the previous deck onto
 * an undo stack before applying. That's why every editing action here is
 * written as a pure `Deck -> Deck` transform: undo/redo is then just swapping
 * which snapshot is current, with no per-action inverse to write and keep
 * correct.
 */

const HISTORY_LIMIT = 60;

/**
 * `Omit<SlideElement, "id">` would collapse the discriminated union into a
 * single object type with only the *common* keys, so `kind: "shape"` would
 * reject `shape`/`fill`. Distributing over the members keeps each variant's
 * own fields.
 */
type NewElement = SlideElement extends infer T
  ? T extends SlideElement
    ? Omit<T, "id">
    : never
  : never;

/** Impress's Shape ▸ Arrange, which moves within the slide's z-order. */
export type ArrangeDirection = "front" | "back" | "forward" | "backward";

/** How far a paste is offset from its source, so the copy is visibly on top. */
const PASTE_OFFSET = 24;

interface DeckState {
  adapter: LibraryAdapter;
  supported: boolean;
  usingFallbackStorage: boolean;
  attached: boolean;
  attaching: boolean;
  error: string | null;

  decks: DeckSummary[];
  loadingDecks: boolean;

  deck: Deck | null;
  savedSnapshot: string | null;
  saving: boolean;

  /** Resolved object URL for `deck.audio`, or null when the deck has no track. */
  audio: AudioHandle | null;

  currentSlide: number;
  /**
   * The selection, in the order it was built up.
   *
   * An array rather than a single id because align, distribute and "delete
   * these three" are meaningless on one element — and because the agent's ops
   * have always taken `elementIds`, so a single-selection UI was the narrower
   * half of a vocabulary the app already spoke.
   */
  selectedElementIds: string[];
  /** Element currently in text-edit mode, if any. */
  editingElementId: string | null;

  /**
   * Cut/copied elements, deliberately session state.
   *
   * Same reasoning as `stemMix`: what sits on the clipboard is not a property
   * of the presentation. Storing it would dirty the document and consume undo
   * slots for something nobody wants to undo.
   */
  clipboard: SlideElement[];
  /** How many times the clipboard has been pasted, for cascading offsets. */
  pasteCount: number;

  /** Canvas zoom, or "fit" to keep matching the window. View state, not deck data. */
  zoom: number | "fit";
  showGrid: boolean;
  snapEnabled: boolean;

  past: Deck[];
  future: Deck[];

  // library
  restoreOnLoad(): Promise<void>;
  attach(): Promise<void>;
  detach(): Promise<void>;
  refreshDecks(): Promise<void>;
  createDeck(title: string): Promise<void>;
  /** Builds a deck from an Ultimate Guitar chord chart (one slide per section) and opens it. The MP3 is required: the slides are cued to it by audio analysis before the deck is saved. If the analysis fails the deck is still created, uncued, and `error` says so. */
  createDeckFromChords(
    result: ChordResult,
    audio: File,
    onProgress?: (fraction: number) => void,
  ): Promise<void>;
  openDeck(id: string): Promise<void>;
  closeDeck(): void;
  deleteDeck(id: string): Promise<void>;
  saveDeck(): Promise<void>;
  isDirty(): boolean;

  // deck-level
  setTitle(title: string): void;
  setTheme(theme: Partial<Theme>): void;
  /** Saves an image into the deck's assets and returns its deck-relative path. */
  uploadImage(file: File): Promise<string | null>;
  /** Deck-wide backdrop (the master). */
  setThemeBackground(background: Background): void;
  /** Per-slide backdrop; `undefined` reverts the slide to the theme's. */
  setSlideBackground(index: number, background: Background | undefined): void;
  attachAudio(file: File): Promise<void>;
  removeAudio(): Promise<void>;
  setAudioDuration(seconds: number): void;

  /**
   * Stores separated instrument tracks and records them on the deck.
   * Stems supplement the mix; they never replace `audio.path`.
   */
  attachStems(stems: Array<{ id: StemId; data: Blob | ArrayBuffer; ext?: string }>): Promise<void>;
  removeStems(): Promise<void>;

  /**
   * Mixer state, deliberately session-only.
   *
   * Muting vocals to run a singalong is a rehearsal setting, not a property of
   * the presentation — storing it on the deck would mark the document dirty
   * and eat undo slots for something nobody wants to undo.
   */
  stemMix: StemState[];
  setStemMix(next: StemState[]): void;

  /** Zips the open deck with its media and triggers a download. */
  exportDeck(options?: { includeStems?: boolean }): Promise<void>;
  /** Reads a bundle in as a new deck, then opens it. */
  importDeck(file: Blob): Promise<void>;

  // slides
  selectSlide(index: number): void;
  addSlide(layout?: LayoutId): void;
  duplicateSlide(index: number): void;
  deleteSlide(index: number): void;
  moveSlide(from: number, to: number): void;
  setSlideLayout(index: number, layout: LayoutId): void;
  updateSlide(index: number, updater: (s: Slide) => Slide): void;
  setSlideCue(index: number, seconds: number | undefined): void;
  /** Sets several cues as ONE undo step. Returns false (and changes nothing) if the result wouldn't run forward. */
  setSlideCues(cues: Array<{ index: number; seconds: number | undefined }>): boolean;

  // elements
  /** Replaces the selection. `null` clears it. */
  selectElement(id: string | null): void;
  /** Adds or removes one element — Impress's Shift+click. */
  toggleElementSelection(id: string): void;
  selectElements(ids: readonly string[]): void;
  selectAllElements(): void;
  setEditingElement(id: string | null): void;
  addElement(element: NewElement): void;
  updateElement(id: string, updater: (el: SlideElement) => SlideElement): void;
  /** Applies one transform to every selected element as a single undo step. */
  updateSelection(updater: (el: SlideElement) => SlideElement): void;
  /** Moves the whole selection by a delta, skipping locked elements. */
  nudgeSelection(dx: number, dy: number): void;
  deleteElement(id: string): void;
  deleteSelection(): void;
  reorderElement(id: string, direction: ArrangeDirection): void;
  /** Arrange (Impress: Shape ▸ Arrange) applied to the whole selection. */
  arrangeSelection(direction: ArrangeDirection): void;
  /**
   * Align, relative to the selection's own bounds or to the slide.
   *
   * Impress aligns to the selection when several things are picked and to the
   * page when only one is; that rule is applied here so a single shape can be
   * centred without a separate command.
   */
  alignSelection(mode: AlignMode, relativeTo?: "selection" | "slide"): void;
  distributeSelection(axis: "horizontal" | "vertical"): void;

  // clipboard
  copySelection(): void;
  cutSelection(): void;
  /** Pastes onto the current slide, offset so the copy is visible and selected. */
  pasteClipboard(): void;
  /** Copy + paste in one step (Impress: Ctrl+D). */
  duplicateSelection(): void;

  // view
  setZoom(zoom: number | "fit"): void;
  toggleGrid(): void;
  toggleSnap(): void;

  undo(): void;
  redo(): void;
}

function messageOf(err: unknown): string {
  if (err instanceof LibraryError || err instanceof Error) return err.message;
  return String(err);
}

export const useDeckStore = create<DeckState>((set, get) => {
  /** Apply a pure transform, recording the previous deck for undo. */
  function commit(transform: (deck: Deck) => Deck) {
    const { deck, past } = get();
    if (!deck) return;
    const next = transform(deck);
    if (next === deck) return;
    set({
      deck: next,
      past: [...past.slice(-(HISTORY_LIMIT - 1)), deck],
      future: [],
    });
  }

  /** Same, scoped to the slide at `index`. */
  function commitSlide(index: number, updater: (s: Slide) => Slide) {
    commit((deck) => {
      const slide = deck.slides[index];
      if (!slide) return deck;
      const slides = [...deck.slides];
      slides[index] = updater(slide);
      return { ...deck, slides };
    });
  }

  return {
    adapter: sharedLibraryAdapter(),
    supported: isAnyLibrarySupported(),
    usingFallbackStorage: !isBrowserLibrarySupported(),
    attached: false,
    attaching: false,
    error: null,

    decks: [],
    loadingDecks: false,

    deck: null,
    savedSnapshot: null,
    saving: false,
    audio: null,

    currentSlide: 0,
    selectedElementIds: [],
    editingElementId: null,

    clipboard: [],
    pasteCount: 0,

    zoom: "fit",
    showGrid: false,
    snapEnabled: true,

    past: [],
    future: [],

    // ── library ──────────────────────────────────────────────────────────

    async restoreOnLoad() {
      try {
        const ok = await get().adapter.restore();
        set({ attached: ok });
        if (ok) await get().refreshDecks();
      } catch (err) {
        console.warn("[deck] restore failed:", err);
      }
    },

    async attach() {
      set({ attaching: true, error: null });
      try {
        const ok = await get().adapter.attach();
        set({ attached: ok, attaching: false });
        if (ok) await get().refreshDecks();
      } catch (err) {
        set({ attaching: false, error: messageOf(err) });
      }
    },

    async detach() {
      get().closeDeck();
      await get().adapter.detach();
      set({ attached: false, decks: [] });
    },

    async refreshDecks() {
      set({ loadingDecks: true, error: null });
      try {
        set({ decks: await get().adapter.listDecks(), loadingDecks: false });
      } catch (err) {
        set({ loadingDecks: false, error: messageOf(err) });
      }
    },

    async createDeck(title) {
      set({ error: null });
      try {
        const draft = newDeck({ id: crypto.randomUUID(), title });
        // Open on a title slide rather than an empty deck — an editor that
        // starts with nothing to click gives no hint of how to begin.
        const firstSlide = Slide_(crypto.randomUUID(), "centered", title);
        const saved = await get().adapter.writeDeck({ ...draft, slides: [firstSlide] });
        await get().refreshDecks();
        await get().openDeck(saved.id);
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    async createDeckFromChords(result, audioFile, onProgress) {
      set({ error: null });
      try {
        const draft = newDeck({
          id: crypto.randomUUID(),
          title: `${result.source.title} — ${result.source.artist}`,
        });
        let slides = chordDeckSlides(result, () => crypto.randomUUID());
        const adapter = get().adapter;

        // Cue the slides to the song before anything is saved, so the deck is
        // written once, already synced. A failed analysis must not lose the
        // deck: it is created uncued and the teacher can retry from the Music
        // sync panel's "Auto-suggest cues".
        let syncError: string | null = null;
        try {
          const { times, source, note } = await cuesForAudio(audioFile, chordSectionPlan(result), { onProgress });
          slides = slides.map((slide, i) => (times[i] === undefined ? slide : { ...slide, startTime: times[i] }));
          if (source === "music" && note) {
            syncError = `Timed from the music alone — ${note}. It is rougher; check the cues by ear.`;
          }
        } catch (err) {
          syncError = `Couldn't sync the slides to the music (${messageOf(err)}). Use "Auto-suggest cues" in the Music sync panel to retry.`;
        }

        // The audio file is written before the deck, so deck.json never
        // references a file that isn't on disk yet (same order as importDeck).
        const ext = audioFile.name.includes(".") ? audioFile.name.split(".").pop()! : "mp3";
        const path = `audio.${ext}`;
        await adapter.writeDeckAsset(draft.id, path, audioFile);

        const saved = await adapter.writeDeck({
          ...draft,
          slides,
          audio: { path, originalName: audioFile.name },
        });
        await get().refreshDecks();
        await get().openDeck(saved.id);
        if (syncError) set({ error: syncError });
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    async openDeck(id) {
      set({ error: null });
      try {
        const { adapter, audio } = get();
        const deck = await adapter.readDeck(id);
        audio?.release();
        const handle = deck.audio
          ? await adapter.resolveDeckMedia(deck.id, deck.audio.path).catch(() => null)
          : null;
        set({
          deck,
          savedSnapshot: JSON.stringify(deck),
          audio: handle,
          currentSlide: 0,
          selectedElementIds: [],
          editingElementId: null,
          past: [],
          future: [],
          // Every stem starts audible. The mixer is session state, so opening
          // a deck always begins from the full mix rather than restoring
          // whatever was muted last time.
          stemMix: sortStems(deck.audio?.stems ?? []).map((s) => initialStemState(s.id)),
        });
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    closeDeck() {
      get().audio?.release();
      set({
        deck: null,
        savedSnapshot: null,
        audio: null,
        currentSlide: 0,
        selectedElementIds: [],
        editingElementId: null,
        past: [],
        future: [],
        stemMix: [],
      });
    },

    async deleteDeck(id) {
      try {
        await get().adapter.deleteDeck(id);
        if (get().deck?.id === id) get().closeDeck();
        await get().refreshDecks();
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    async saveDeck() {
      const { adapter, deck } = get();
      if (!deck) return;
      set({ saving: true, error: null });
      try {
        const saved = await adapter.writeDeck(deck);
        set({ deck: saved, savedSnapshot: JSON.stringify(saved), saving: false });
        await get().refreshDecks();
      } catch (err) {
        set({ saving: false, error: messageOf(err) });
      }
    },

    isDirty() {
      const { deck, savedSnapshot } = get();
      return deck !== null && JSON.stringify(deck) !== savedSnapshot;
    },

    // ── deck-level ───────────────────────────────────────────────────────

    setTitle(title) {
      commit((deck) => ({ ...deck, title }));
    },

    setTheme(theme) {
      commit((deck) => ({ ...deck, theme: { ...deck.theme, ...theme } }));
    },

    async uploadImage(file) {
      const { adapter, deck } = get();
      if (!deck) return null;
      try {
        // Prefix with a short random segment: two files named `photo.jpg` from
        // different folders must not overwrite each other inside one deck.
        const safeName = file.name.replace(/[^\w.\-]+/g, "_");
        const path = `assets/${crypto.randomUUID().slice(0, 8)}-${safeName}`;
        await adapter.writeDeckAsset(deck.id, path, file);
        return path;
      } catch (err) {
        set({ error: messageOf(err) });
        return null;
      }
    },

    setThemeBackground(background) {
      commit((deck) => ({
        ...deck,
        // A custom backdrop is no longer any named preset, so clear the label
        // rather than leaving the preset list showing a stale highlight.
        theme: { ...deck.theme, background, preset: "custom" },
      }));
    },

    setSlideBackground(index, background) {
      commitSlide(index, (slide) => {
        if (background === undefined) {
          const { background: _inherit, ...rest } = slide;
          return rest as Slide;
        }
        return { ...slide, background };
      });
    },

    async attachAudio(file) {
      const { adapter, deck, audio } = get();
      if (!deck) return;
      set({ error: null });
      try {
        const ext = file.name.includes(".") ? file.name.split(".").pop()! : "mp3";
        const path = `audio.${ext}`;
        await adapter.writeDeckAsset(deck.id, path, file);
        audio?.release();
        const handle = await adapter.resolveDeckMedia(deck.id, path);
        set({ audio: handle });
        commit((d) => ({ ...d, audio: { path, originalName: file.name } }));
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    async removeAudio() {
      get().audio?.release();
      set({ audio: null });
      // Cue times are left in place on purpose: swapping the backing file is
      // common (a better rip of the same song), and re-typing every cue would
      // be punishing. The stored asset is left too — deleting the deck cleans it.
      commit((deck) => {
        const { audio: _dropped, ...rest } = deck;
        return rest as Deck;
      });
    },

    async attachStems(stems) {
      const { adapter, deck } = get();
      if (!deck?.audio || stems.length === 0) return;
      set({ error: null });
      try {
        const written: Stem[] = [];
        for (const stem of stems) {
          const path = `stems/${stem.id}.${stem.ext ?? "wav"}`;
          await adapter.writeDeckAsset(deck.id, path, stem.data);
          written.push({ id: stem.id, path });
        }
        // Stems supplement the mix — `audio.path` is left intact so the deck
        // still plays if the stem files are later removed.
        commit((d) => (d.audio ? { ...d, audio: { ...d.audio, stems: written } } : d));
        set({ stemMix: sortStems(written).map((s) => initialStemState(s.id)) });
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    async removeStems() {
      // The files are left on disk; deleting the deck cleans them up. Only the
      // reference is dropped, so playback falls back to the full mix.
      commit((deck) => {
        if (!deck.audio) return deck;
        const { stems: _dropped, ...audio } = deck.audio;
        return { ...deck, audio };
      });
      set({ stemMix: [] });
    },

    stemMix: [],

    setStemMix(next) {
      set({ stemMix: next });
    },

    async exportDeck(options) {
      const { adapter, deck } = get();
      if (!deck) return;
      set({ error: null });
      try {
        const blob = await exportDeckBundle(adapter, deck, options);
        downloadBlob(blob, bundleFilename(deck));
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    async importDeck(file) {
      const { adapter } = get();
      set({ error: null });
      try {
        const { deck, assets } = await readDeckBundle(file);
        // Assets are written before the deck, so the deck record never
        // references a file that isn't on disk yet.
        for (const [path, data] of Object.entries(assets)) {
          await adapter.writeDeckAsset(deck.id, path, data as unknown as ArrayBuffer);
        }
        const saved = await adapter.writeDeck(deck);
        await get().refreshDecks();
        await get().openDeck(saved.id);
      } catch (err) {
        set({ error: messageOf(err) });
      }
    },

    setAudioDuration(seconds) {
      const { deck } = get();
      if (!deck?.audio || deck.audio.duration === seconds) return;
      // Deliberately not via commit(): this is metadata discovered by the
      // <audio> element, not a user edit, and it must not occupy an undo slot.
      set({ deck: { ...deck, audio: { ...deck.audio, duration: seconds } } });
    },

    // ── slides ───────────────────────────────────────────────────────────

    selectSlide(index) {
      set({ currentSlide: index, selectedElementIds: [], editingElementId: null });
    },

    addSlide(layout = "titleContent") {
      const { deck, currentSlide } = get();
      if (!deck) return;
      const at = Math.min(currentSlide + 1, deck.slides.length);
      commit((d) => {
        const slides = [...d.slides];
        slides.splice(at, 0, Slide_(crypto.randomUUID(), layout));
        return { ...d, slides };
      });
      set({ currentSlide: at, selectedElementIds: [], editingElementId: null });
    },

    duplicateSlide(index) {
      const { deck } = get();
      const source = deck?.slides[index];
      if (!source) return;
      commit((d) => {
        const slides = [...d.slides];
        slides.splice(index + 1, 0, {
          ...structuredClone(source),
          id: crypto.randomUUID(),
          name: `${source.name} copy`,
          // A duplicate must not inherit the cue: two slides at the same
          // timestamp make auto-advance ambiguous, and the schema requires
          // cues to move forward.
          startTime: undefined,
          elements: source.elements.map((el) => ({ ...structuredClone(el), id: crypto.randomUUID() })),
        });
        return { ...d, slides };
      });
      set({ currentSlide: index + 1, selectedElementIds: [] });
    },

    deleteSlide(index) {
      const { deck } = get();
      if (!deck || deck.slides.length === 0) return;
      commit((d) => ({ ...d, slides: d.slides.filter((_, i) => i !== index) }));
      set({
        currentSlide: Math.max(0, Math.min(index, get().deck!.slides.length - 1)),
        selectedElementIds: [],
        editingElementId: null,
      });
    },

    moveSlide(from, to) {
      commit((deck) => {
        if (from === to || from < 0 || to < 0 || from >= deck.slides.length || to >= deck.slides.length) {
          return deck;
        }
        const slides = [...deck.slides];
        const [moved] = slides.splice(from, 1);
        slides.splice(to, 0, moved!);
        return { ...deck, slides };
      });
      set({ currentSlide: to });
    },

    setSlideLayout(index, layout) {
      commitSlide(index, (slide) => ({
        ...slide,
        layout,
        elements: applyLayout(slide.elements, layout, () => crypto.randomUUID()),
      }));
      set({ selectedElementIds: [], editingElementId: null });
    },

    updateSlide(index, updater) {
      commitSlide(index, updater);
    },

    setSlideCue(index, seconds) {
      commitSlide(index, (slide) => ({ ...slide, startTime: seconds }));
    },

    setSlideCues(cues) {
      const deck = get().deck;
      if (!deck) return false;
      const byIndex = new Map(cues.map((c) => [c.index, c.seconds]));
      const slides = deck.slides.map((slide, i) =>
        byIndex.has(i) ? { ...slide, startTime: byIndex.get(i) } : slide,
      );
      // Cues must run forward (Deck.superRefine); refuse a batch that would
      // fail on save instead of committing it and finding out then.
      let last = -1;
      for (const slide of slides) {
        if (slide.startTime === undefined) continue;
        if (slide.startTime < last) return false;
        last = slide.startTime;
      }
      commit((d) => ({ ...d, slides }));
      return true;
    },

    // ── elements ─────────────────────────────────────────────────────────

    selectElement(id) {
      set({ selectedElementIds: id ? [id] : [], editingElementId: null });
    },

    toggleElementSelection(id) {
      const { selectedElementIds } = get();
      set({
        selectedElementIds: selectedElementIds.includes(id)
          ? selectedElementIds.filter((existing) => existing !== id)
          : [...selectedElementIds, id],
        editingElementId: null,
      });
    },

    selectElements(ids) {
      set({ selectedElementIds: [...ids], editingElementId: null });
    },

    selectAllElements() {
      const slide = currentSlideOf(get());
      set({
        selectedElementIds: (slide?.elements ?? []).map((el) => el.id),
        editingElementId: null,
      });
    },

    setEditingElement(id) {
      // Entering text edit collapses the selection to that one element: the
      // properties panel and every command would otherwise still be aimed at a
      // group while the user is typing into one member of it.
      set({ editingElementId: id, ...(id ? { selectedElementIds: [id] } : {}) });
    },

    addElement(element) {
      const { currentSlide } = get();
      const id = crypto.randomUUID();
      commitSlide(currentSlide, (slide) => ({
        ...slide,
        elements: [...slide.elements, { ...element, id } as SlideElement],
      }));
      set({ selectedElementIds: [id] });
    },

    updateElement(id, updater) {
      const { currentSlide } = get();
      commitSlide(currentSlide, (slide) => ({
        ...slide,
        elements: slide.elements.map((el) => (el.id === id ? updater(el) : el)),
      }));
    },

    updateSelection(updater) {
      const { currentSlide, selectedElementIds } = get();
      if (selectedElementIds.length === 0) return;
      const ids = new Set(selectedElementIds);
      commitSlide(currentSlide, (slide) => ({
        ...slide,
        elements: slide.elements.map((el) => (ids.has(el.id) ? updater(el) : el)),
      }));
    },

    nudgeSelection(dx, dy) {
      get().updateSelection((el) => (el.locked ? el : { ...el, x: el.x + dx, y: el.y + dy }));
    },

    deleteElement(id) {
      const { currentSlide, selectedElementIds } = get();
      commitSlide(currentSlide, (slide) => ({
        ...slide,
        elements: slide.elements.filter((el) => el.id !== id),
      }));
      set({
        selectedElementIds: selectedElementIds.filter((existing) => existing !== id),
        editingElementId: null,
      });
    },

    deleteSelection() {
      const { currentSlide, selectedElementIds } = get();
      if (selectedElementIds.length === 0) return;
      const ids = new Set(selectedElementIds);
      commitSlide(currentSlide, (slide) => ({
        ...slide,
        // Locked elements survive: locking exists precisely to stop a stray
        // Delete from taking out the backdrop someone pinned in place.
        elements: slide.elements.filter((el) => !ids.has(el.id) || el.locked),
      }));
      set({ selectedElementIds: [], editingElementId: null });
    },

    reorderElement(id, direction) {
      const { currentSlide } = get();
      commitSlide(currentSlide, (slide) => ({
        ...slide,
        elements: arrange(slide.elements, [id], direction),
      }));
    },

    arrangeSelection(direction) {
      const { currentSlide, selectedElementIds } = get();
      if (selectedElementIds.length === 0) return;
      commitSlide(currentSlide, (slide) => ({
        ...slide,
        elements: arrange(slide.elements, selectedElementIds, direction),
      }));
    },

    alignSelection(mode, relativeTo) {
      const { currentSlide, selectedElementIds } = get();
      const slide = currentSlideOf(get());
      if (!slide || selectedElementIds.length === 0) return;
      const ids = new Set(selectedElementIds);
      const picked = slide.elements.filter((el) => ids.has(el.id));

      // Impress's rule: several things align to each other, one aligns to the
      // page. Without it, "centre" on a single shape would be a no-op.
      const scope = relativeTo ?? (picked.length > 1 ? "selection" : "slide");
      const to = scope === "slide" ? slideBounds() : boundsOf(picked);
      if (!to) return;

      commitSlide(currentSlide, (s) => ({
        ...s,
        elements: s.elements.map((el) =>
          ids.has(el.id) && !el.locked ? { ...el, ...alignedFrame(el, to, mode) } : el,
        ),
      }));
    },

    distributeSelection(axis) {
      const { currentSlide, selectedElementIds } = get();
      const slide = currentSlideOf(get());
      if (!slide) return;
      const ids = new Set(selectedElementIds);
      const horizontal = axis === "horizontal";
      const picked = slide.elements
        .filter((el) => ids.has(el.id))
        .sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
      // Fewer than three is meaningless: the outer two define the span, so
      // there is nothing left in between to space out.
      if (picked.length < 3) return;

      const first = picked[0]!;
      const last = picked.at(-1)!;
      const start = horizontal ? first.x : first.y;
      const end = horizontal ? last.x : last.y;
      const step = (end - start) / (picked.length - 1);
      const placement = new Map(picked.map((el, i) => [el.id, start + step * i]));

      commitSlide(currentSlide, (s) => ({
        ...s,
        elements: s.elements.map((el) => {
          const at = placement.get(el.id);
          if (at === undefined || el.locked) return el;
          return horizontal ? { ...el, x: at } : { ...el, y: at };
        }),
      }));
    },

    // ── clipboard ────────────────────────────────────────────────────────

    copySelection() {
      const slide = currentSlideOf(get());
      const ids = new Set(get().selectedElementIds);
      const picked = (slide?.elements ?? []).filter((el) => ids.has(el.id));
      if (picked.length === 0) return;
      // Deep-cloned on the way in, so later edits to the originals can't
      // reach back and change what a pending paste will produce.
      set({ clipboard: picked.map((el) => structuredClone(el)), pasteCount: 0 });
    },

    cutSelection() {
      get().copySelection();
      get().deleteSelection();
    },

    pasteClipboard() {
      const { clipboard, currentSlide, pasteCount } = get();
      if (clipboard.length === 0) return;

      // Each successive paste steps further down-right, so pasting three times
      // gives three visible copies rather than one stack nobody can separate.
      const offset = PASTE_OFFSET * (pasteCount + 1);
      const copies = clipboard.map((el) => ({
        ...structuredClone(el),
        // Fresh ids, always: duplicate ids break selection and z-ordering,
        // both of which address elements by id.
        id: crypto.randomUUID(),
        x: el.x + offset,
        y: el.y + offset,
        locked: false,
      }));

      commitSlide(currentSlide, (slide) => ({ ...slide, elements: [...slide.elements, ...copies] }));
      set({
        selectedElementIds: copies.map((el) => el.id),
        editingElementId: null,
        pasteCount: pasteCount + 1,
      });
    },

    duplicateSelection() {
      const slide = currentSlideOf(get());
      const ids = new Set(get().selectedElementIds);
      const picked = (slide?.elements ?? []).filter((el) => ids.has(el.id));
      if (picked.length === 0) return;

      const copies = picked.map((el) => ({
        ...structuredClone(el),
        id: crypto.randomUUID(),
        x: el.x + PASTE_OFFSET,
        y: el.y + PASTE_OFFSET,
        locked: false,
      }));
      commitSlide(get().currentSlide, (s) => ({ ...s, elements: [...s.elements, ...copies] }));
      // Selecting the copies is what makes Ctrl+D repeatable into a row.
      set({ selectedElementIds: copies.map((el) => el.id), editingElementId: null });
    },

    // ── view ─────────────────────────────────────────────────────────────

    setZoom(zoom) {
      set({ zoom });
    },

    toggleGrid() {
      set({ showGrid: !get().showGrid });
    },

    toggleSnap() {
      set({ snapEnabled: !get().snapEnabled });
    },

    // ── history ──────────────────────────────────────────────────────────

    undo() {
      const { past, deck, future } = get();
      const previous = past.at(-1);
      if (!previous || !deck) return;
      set({
        deck: previous,
        past: past.slice(0, -1),
        future: [deck, ...future].slice(0, HISTORY_LIMIT),
        selectedElementIds: [],
        editingElementId: null,
        currentSlide: Math.min(get().currentSlide, Math.max(0, previous.slides.length - 1)),
      });
    },

    redo() {
      const { past, deck, future } = get();
      const next = future[0];
      if (!next || !deck) return;
      set({
        deck: next,
        past: [...past, deck].slice(-HISTORY_LIMIT),
        future: future.slice(1),
        selectedElementIds: [],
        editingElementId: null,
        currentSlide: Math.min(get().currentSlide, Math.max(0, next.slides.length - 1)),
      });
    },
  };
});

/** The slide being edited, or null when no deck is open. */
function currentSlideOf(state: { deck: Deck | null; currentSlide: number }): Slide | null {
  return state.deck?.slides[state.currentSlide] ?? null;
}

/**
 * Moves elements within a slide's z-order (paint order: last is on top).
 *
 * "forward"/"backward" step one position and are what a user reaches for when
 * three things overlap; "front"/"back" jump the whole way. Moved elements keep
 * their order relative to each other, so arranging a multi-selection doesn't
 * quietly reshuffle it.
 */
export function arrange(
  elements: readonly SlideElement[],
  ids: readonly string[],
  direction: ArrangeDirection,
): SlideElement[] {
  const moving = new Set(ids);
  const picked = elements.filter((el) => moving.has(el.id));
  if (picked.length === 0) return [...elements];
  const rest = elements.filter((el) => !moving.has(el.id));

  if (direction === "front") return [...rest, ...picked];
  if (direction === "back") return [...picked, ...rest];

  const next = [...elements];
  const step = direction === "forward" ? 1 : -1;
  // Walk from the edge the elements are moving towards, so a block of
  // selected elements shifts as a block instead of collapsing onto itself.
  const order =
    direction === "forward"
      ? [...next.keys()].reverse().filter((i) => moving.has(next[i]!.id))
      : [...next.keys()].filter((i) => moving.has(next[i]!.id));

  for (const index of order) {
    const to = index + step;
    if (to < 0 || to >= next.length || moving.has(next[to]!.id)) continue;
    [next[index], next[to]] = [next[to]!, next[index]!];
  }
  return next;
}

/** A fresh slide with its layout's placeholders already laid out. */
function Slide_(id: string, layout: LayoutId, titleText?: string): Slide {
  const elements = applyLayout([], layout, () => crypto.randomUUID()).map((el) =>
    el.kind === "text" && el.role === "title" && titleText ? { ...el, text: titleText } : el,
  );
  return {
    id,
    name: layoutById(layout).label,
    layout,
    elements,
  };
}

/** Default frame for a newly inserted element, centered on the slide. */
export function centeredFrame(w: number, h: number) {
  return { x: (SLIDE_W - w) / 2, y: (SLIDE_H - h) / 2, w, h, rotation: 0, locked: false };
}
