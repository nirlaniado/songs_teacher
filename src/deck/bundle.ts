import { unzip, zip, type Unzipped, type Zippable } from "fflate";
import { Deck, safeParseDeck } from "../schema/deck.js";
import { LAYOUT, type LibraryAdapter } from "../adapters/index.js";

/**
 * Export and import a whole presentation as a single `.zip`.
 *
 * A deck is a `deck.json` plus its audio, images and stems, spread across a
 * folder. That's fine while it lives in the app, but there's no way to hand
 * someone a presentation, move one between machines, or back one up — and for
 * an IndexedDB library (Firefox/Safari) there isn't even a folder to copy.
 *
 * The bundle is exactly the deck's own directory layout, zipped, so the format
 * needs no separate spec: unzip it and you have `deck.json`, `audio.mp3`,
 * `assets/`, `stems/`. Import validates through the same schema and migration
 * every other reader uses, so an older bundle opens like an older file.
 */

/** Marks a zip as ours, and records what produced it. */
const MANIFEST = "libre-off.json";
const BUNDLE_VERSION = 1;

export interface BundleManifest {
  bundleVersion: number;
  app: "libre-off";
  exportedAt: string;
  deckTitle: string;
}

export interface ExportOptions {
  /**
   * Stems are hundreds of megabytes and regenerable by separating again, so
   * they're excluded by default — a bundle you can actually email.
   */
  includeStems?: boolean;
}

/** Every deck-relative file path the deck references. */
function referencedPaths(deck: Deck, includeStems: boolean): string[] {
  const paths = new Set<string>();
  if (deck.audio) paths.add(deck.audio.path);
  if (includeStems) for (const stem of deck.audio?.stems ?? []) paths.add(stem.path);
  if (deck.theme.background.kind === "image") paths.add(deck.theme.background.src);
  for (const slide of deck.slides) {
    if (slide.background?.kind === "image") paths.add(slide.background.src);
    for (const el of slide.elements) if (el.kind === "image") paths.add(el.src);
  }
  return [...paths];
}

export async function exportDeckBundle(
  adapter: LibraryAdapter,
  deck: Deck,
  options: ExportOptions = {},
): Promise<Blob> {
  const includeStems = options.includeStems ?? false;

  // Stem references are stripped when the files aren't included, so the
  // imported deck never points at audio that isn't in the bundle.
  let exported: Deck = deck;
  if (deck.audio && !includeStems) {
    const { stems: _excluded, ...audio } = deck.audio;
    exported = { ...deck, audio };
  }

  const manifest: BundleManifest = {
    bundleVersion: BUNDLE_VERSION,
    app: "libre-off",
    exportedAt: new Date().toISOString(),
    deckTitle: deck.title,
  };

  const files: Zippable = {
    [MANIFEST]: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    [LAYOUT.deckFile]: new TextEncoder().encode(`${JSON.stringify(exported, null, 2)}\n`),
  };

  for (const path of referencedPaths(exported, includeStems)) {
    try {
      const blob = await adapter.readDeckAsset(deck.id, path);
      const data = new Uint8Array(await blob.arrayBuffer());
      // Stored, not deflated. MP3 and JPEG are already compressed, so
      // deflating them costs seconds for almost no saving; WAV stems do
      // compress, but they're big enough that the wait isn't worth it either.
      files[path] = [data, { level: 0 }];
    } catch {
      // A missing asset shouldn't abort the export — the deck still opens,
      // and losing one image is better than losing the whole presentation.
    }
  }

  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });

  return new Blob([zipped as unknown as ArrayBuffer], { type: "application/zip" });
}

/** Triggers a browser download. Separate so the export itself stays testable. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on a later tick: revoking immediately can cancel the download in
  // some browsers before it has started reading.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A filesystem-safe name derived from the deck title. */
export function bundleFilename(deck: Deck): string {
  const base = deck.title.trim().replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").slice(0, 60);
  return `${base || "presentation"}.libreoff.zip`;
}

export interface ImportResult {
  deck: Deck;
  /** Assets that were in the bundle, keyed by deck-relative path. */
  assets: Record<string, Uint8Array>;
}

/**
 * Reads a bundle back. The deck gets a **new id** so importing twice, or
 * importing something you already have, never overwrites the original.
 */
export async function readDeckBundle(file: Blob): Promise<ImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Unzipped>((resolve, reject) => {
    unzip(bytes, (err, data) => (err ? reject(err) : resolve(data)));
  });

  const deckFile = entries[LAYOUT.deckFile];
  if (!deckFile) {
    throw new Error(
      `That doesn't look like a libre-off presentation — no ${LAYOUT.deckFile} inside.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(deckFile));
  } catch {
    throw new Error(`The bundle's ${LAYOUT.deckFile} is not valid JSON.`);
  }

  // Same migration path as every other reader, so an older bundle opens.
  const parsed = safeParseDeck(raw);
  if (!parsed.success) {
    throw new Error(`The bundle's deck failed validation: ${parsed.error.issues[0]?.message}`);
  }

  const assets: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(entries)) {
    if (path === LAYOUT.deckFile || path === MANIFEST) continue;
    if (path.endsWith("/")) continue; // directory entry
    assets[path] = data;
  }

  return {
    deck: { ...parsed.data, id: crypto.randomUUID() },
    assets,
  };
}

/** True for a zip that carries our manifest — used to give a better error. */
export function looksLikeBundle(filename: string): boolean {
  return /\.zip$/i.test(filename);
}

export { MANIFEST as BUNDLE_MANIFEST_NAME, BUNDLE_VERSION };
