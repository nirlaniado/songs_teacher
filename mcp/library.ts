import { readdir, readFile, writeFile, mkdir, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  Deck,
  newDeck,
  safeParseDeck,
  summarizeDeck,
  type DeckSummary,
} from "../src/schema/deck.js";
import { LAYOUT } from "../src/adapters/types.js";

/**
 * Node-side deck storage for the MCP server.
 *
 * The browser adapters keep decks at `<root>/decks/<uuid>/deck.json`; this
 * reads and writes that exact layout with `fs`, so a deck built from the CLI
 * and a deck built in the editor are the same file. `LAYOUT` is imported
 * rather than re-declared precisely so the two can't drift apart.
 *
 * Deliberately NOT a `LibraryAdapter` implementation and deliberately outside
 * `src/`: half that interface (`attach`, `resolveAudio` returning object URLs)
 * is meaningless in Node, and importing `node:fs` anywhere `src/` can reach
 * would break the browser bundle. `src/` stays platform-free; this is the
 * Node counterpart, and it is the groundwork the Electron phase will reuse.
 *
 * IndexedDB libraries (the Firefox/Safari fallback) are unreachable from
 * here — that data lives inside the browser. Only real-folder libraries work
 * over MCP, which is stated plainly in the server's errors.
 */

export class DeckLibrary {
  constructor(private readonly root: string) {}

  /**
   * One promise chain per deck id, so read-modify-write sequences can't
   * interleave.
   *
   * MCP clients may issue tool calls concurrently, and without this two
   * overlapping edits both read the old deck, both write, and the second
   * silently discards the first. Worse, because `writeFile` overwrites in
   * place rather than atomically, a shorter write landing on a longer one
   * leaves the previous file's tail behind and corrupts the JSON outright.
   * Observed, not theoretical — it happened on the first concurrent test.
   */
  readonly #locks = new Map<string, Promise<unknown>>();

  /**
   * Serialized read-modify-write. `transform` sees the deck as it is at the
   * moment its turn comes up, never a stale snapshot.
   */
  async mutate(id: string, transform: (deck: Deck) => Deck | Promise<Deck>): Promise<Deck> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => this.write(await transform(await this.read(id))));
    // Held even on failure so a rejected edit still orders the ones behind it.
    this.#locks.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  private decksDir(): string {
    return join(this.root, LAYOUT.decksDir);
  }

  private deckDir(id: string): string {
    // `id` always comes from our own listing or `crypto.randomUUID()`, but a
    // tool argument could carry anything, so reject separators outright
    // rather than letting a crafted id walk out of the library.
    if (!/^[\w-]{1,64}$/.test(id)) throw new Error(`invalid deck id: "${id}"`);
    return join(this.decksDir(), id);
  }

  async list(): Promise<DeckSummary[]> {
    let entries: string[];
    try {
      entries = (await readdir(this.decksDir(), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return []; // a library with no decks yet is not an error
    }

    const out: DeckSummary[] = [];
    for (const id of entries) {
      try {
        out.push(summarizeDeck(await this.read(id)));
      } catch {
        // One malformed deck must not hide the rest of the library.
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async read(id: string): Promise<Deck> {
    const file = join(this.deckDir(id), LAYOUT.deckFile);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      throw new Error(
        `couldn't read deck "${id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Runs the same migration the browser does, so an older deck.json opens
    // identically from either side.
    const parsed = safeParseDeck(raw);
    if (!parsed.success) {
      throw new Error(`deck "${id}" failed validation: ${parsed.error.issues[0]?.message}`);
    }
    return parsed.data;
  }

  async write(deck: Deck): Promise<Deck> {
    const validated = Deck.parse({ ...deck, updatedAt: new Date().toISOString() });
    const dir = this.deckDir(validated.id);
    await mkdir(dir, { recursive: true });

    // Same 2-space formatting the browser adapter writes, so a deck edited
    // from both sides doesn't churn its whole file on every save.
    const body = `${JSON.stringify(validated, null, 2)}\n`;
    const target = join(dir, LAYOUT.deckFile);
    const temp = `${target}.${process.pid}.tmp`;

    // Write-then-rename rather than overwrite in place. `writeFile` truncates
    // and refills, so a shorter document landing on a longer one leaves the
    // old tail behind — which produced genuinely corrupt JSON in testing.
    // `rename` is atomic within a filesystem: readers see either the old file
    // or the new one, never a partial. This also survives a crash mid-write.
    await writeFile(temp, body, "utf8");
    try {
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return validated;
  }

  async create(title: string): Promise<Deck> {
    return this.write(newDeck({ id: crypto.randomUUID(), title }));
  }

  /**
   * Stores a binary asset inside a deck and returns the deck-relative path
   * that an `ImageElement.src` expects. Written under `assets/` to match the
   * layout the browser adapter uses, so the editor finds it unchanged.
   */
  async writeAsset(deckId: string, name: string, data: Uint8Array): Promise<string> {
    const safe = name.replace(/[^\w.\-]+/g, "_").slice(0, 80);
    if (safe === "" || safe.startsWith(".")) throw new Error(`invalid asset name: "${name}"`);
    const rel = `${LAYOUT.assetsDir}/${safe}`;
    const dir = join(this.deckDir(deckId), LAYOUT.assetsDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, safe), data);
    return rel;
  }

  async remove(id: string): Promise<void> {
    await rm(this.deckDir(id), { recursive: true, force: true });
  }
}

/**
 * Where the library lives: `--library <path>` beats `LIBRE_OFF_LIBRARY`.
 * Fails loudly rather than defaulting, because silently writing decks into
 * some unrelated directory is worse than refusing to start.
 */
export function resolveLibraryRoot(argv: readonly string[]): string {
  const flag = argv.indexOf("--library");
  const fromFlag = flag !== -1 ? argv[flag + 1] : undefined;
  const root = fromFlag ?? process.env.LIBRE_OFF_LIBRARY;
  if (!root) {
    throw new Error(
      "No library folder given. Pass --library <path> or set LIBRE_OFF_LIBRARY. " +
        "This is the folder you opened in libre-off — the one containing a `decks/` directory.",
    );
  }
  return root;
}
