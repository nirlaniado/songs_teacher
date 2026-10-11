import { config, localDir } from "./config.js";
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { ChordResult, TabCandidate, SongIdentity } from "../../src/ug/types.js";
import { AgentError, count, pageData, parseChordContent, readTab, record, searchPage, siteUrl, text } from "./core.js";

export class GuitarBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private loginAttempted = false;
  // Accepts a progress callback. The browser opens only when site access is needed.
  constructor(private progress: (message: string) => void = () => {}) {}
  // Updates the callback that receives browser progress messages for the current request.
  setProgress(progress: (message: string) => void) { this.progress = progress; }

  // Reuses an existing page or opens Chromium with a local profile that preserves login state between runs.
  private async getPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    await mkdir(localDir, { recursive: true, mode: 0o700 });
    await chmod(localDir, 0o700);
    const { chromium } = await import("playwright");
    try {
      this.context = await chromium.launchPersistentContext(join(localDir, "profile"), {
        headless: config.headless, viewport: { width: 1280, height: 900 },
        acceptDownloads: false,
      });
    } catch {
      throw new AgentError("browser_start", "לא ניתן להפעיל Chromium. הרץ npm run ug:install-browser וסגור מופע אחר של הסוכן אם קיים.");
    }
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.page.setDefaultTimeout(12_000);
    return this.page;
  }

  // Closes the browser and clears its in-memory references; the login profile remains on disk.
  async close() { await this.context?.close(); this.context = undefined; this.page = undefined; }

  // Extracts site state from the original HTML, falling back to the live page. Distinguishes verification prompts from unrecognized page structure.
  private async state(page: Page, html?: string): Promise<unknown> {
    try {
      // UG removes the hydration node during React startup. Read the actual
      // navigation response before falling back to the live DOM.
      if (html) {
        // Runs inside the browser to locate embedded data in the received HTML, even if the site has already removed it from the live page.
        const embedded = await page.evaluate(source => {
          const doc = new DOMParser().parseFromString(source, "text/html");
          return doc.querySelector(".js-store[data-content]")?.getAttribute("data-content") ?? null;
        }, html);
        if (embedded) return JSON.parse(embedded);
      }
      await page.locator(".js-store[data-content]").waitFor({ state: "attached", timeout: 15_000 });
      const raw = await page.locator(".js-store[data-content]").first().getAttribute("data-content");
      return JSON.parse(raw || "{}");
    } catch {
      const challenge = await page.getByText(/verify you are human|checking your browser|just a moment|captcha/i).count();
      throw new AgentError(challenge ? "needs_login" : "site_changed", challenge
        ? "נדרש אימות בדפדפן של הסוכן. השלם אותו ולחץ המשך."
        : "מבנה העמוד לא זוהה או שהטעינה נכשלה. לא בוצע חילוץ.");
    }
  }

  // Opens an allowed URL, validates the final URL and response status, and returns the page with its extracted state.
  private async open(url: string) {
    const page = await this.getPage();
    let response;
    try { response = await page.goto(siteUrl(url), { waitUntil: "domcontentloaded", timeout: 45_000 }); }
    catch { throw new AgentError("network", "לא ניתן לטעון את Ultimate Guitar. בדוק את החיבור ונסה שוב."); }
    siteUrl(page.url());
    if (response?.status() === 429) throw new AgentError("rate_limit", "האתר מגביל כעת בקשות. נסה שוב מאוחר יותר.");
    if (response && response.status() >= 400) throw new AgentError("access_denied", `האתר החזיר שגיאת גישה (${response.status()}).`);
    const html = await response?.text().catch(() => undefined);
    return { page, state: await this.state(page, html) };
  }

  // Checks whether the account is logged in. Otherwise tries the ENV credentials once; additional verification or failure requires manual completion.
  async login() {
    this.progress("בודק התחברות לחשבון Ultimate Guitar…");
    const { page, state } = await this.open("https://www.ultimate-guitar.com/");
    if ((count(record(record(record(state).store).user).id) ?? 0) > 0) return;
    if (!this.loginAttempted && config.username && config.password) {
      this.loginAttempted = true;
      try {
        await page.getByRole("button", { name: /^Log in$/i }).first().click();
        siteUrl(page.url());
        await page.locator('input[name="username"]').fill(config.username);
        await page.locator('input[name="password"]').fill(config.password);
        await page.getByRole("button", { name: /^Log in$/i }).last().click();
        await page.locator('input[name="password"]').waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
        // Some login flows update cookies but not the embedded state until navigation.
        const after = await this.open("https://www.ultimate-guitar.com/");
        if ((count(record(record(record(after.state).store).user).id) ?? 0) > 0) return;
      } catch (error) {
        if (error instanceof AgentError && error.code !== "needs_login") throw error;
      }
    }
    throw new AgentError("needs_login", config.headless
      ? "נדרשת התחברות או השלמת אימות. הפעל את השירות עם UG_HEADLESS=false במחשב עם תצוגה, התחבר בדפדפן ולחץ המשך."
      : "השלם התחברות או אימות בחלון Ultimate Guitar של הסוכן, ואז לחץ המשך. בדוק גם את פרטי ההתחברות ב־ENV.");
  }

  // Scans search pages for the song and artist and merges duplicate results. Stops explicitly if the search exceeds ten pages or loads incompletely.
  async search(song: SongIdentity) {
    this.progress(`מחפש באתר: ${song.title} — ${song.artist}`);
    const candidates = new Map<string, TabCandidate>();
    let total = 1;
    for (let current = 1; current <= total; current++) {
      const url = new URL("https://www.ultimate-guitar.com/search.php");
      url.search = new URLSearchParams({ search_type: "title", value: `${song.title} ${song.artist}`, page: String(current) }).toString();
      const { state } = await this.open(url.href);
      const result = searchPage(state);
      if (result.current !== current || result.total > 10) throw new AgentError("incomplete_search", "החיפוש רחב מדי או שהעמודים לא נטענו במלואם. ציין שם שיר ואמן מדויקים.");
      total = result.total;
      result.candidates.forEach(c => candidates.set(`${c.official}:${c.id}`, c));
      if (current < total) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return [...candidates.values()];
  }

  // Opens a specific version, follows a site-provided Official link when needed, and verifies that the page matches the selected source.
  private async tab(candidate: TabCandidate) {
    let opened = await this.open(candidate.url);
    // Follow the Official URL supplied by UG's own marketing page, never invent it.
    if (candidate.official && !record(pageData(opened.state)).tab) {
      const official = record(record(pageData(opened.state)).official_version);
      const target = text(official[candidate.id]);
      if (target) opened = await this.open(siteUrl(target));
    }
    return { ...opened, ...readTab(opened.state, candidate) };
  }

  // Reads a version’s view count. If its page reveals an Official version, returns that version so it takes precedence.
  async inspect(candidate: TabCandidate) {
    this.progress(`בודק צפיות: ${candidate.title}, גרסה ${candidate.version ?? candidate.id}`);
    const result = await this.tab(candidate);
    await new Promise(resolve => setTimeout(resolve, 1000));
    // A community page can reveal an Official link absent from search results.
    if (result.view.has_official_version) {
      const url = text(result.view.official_tab_url);
      const id = url.match(/-official-(\d+)$/)?.[1];
      if (!id) throw new AgentError("incomplete_search", "האתר מציין שקיימת גרסה רשמית, אך הקישור אליה לא זוהה. לא נבחרה גרסת משתמשים.");
      const official = await this.tab({ ...candidate, id, url: siteUrl(url), official: true });
      return official.candidate;
    }
    return result.candidate;
  }

  // Reads chord text or opens the Official Chords view, then returns chords with source details, capo, tuning, and an unofficial-version warning when applicable.
  async extract(candidate: TabCandidate, selection: ChordResult["selection"]): Promise<ChordResult> {
    this.progress(candidate.official ? "מחלץ אקורדים מהגרסה הרשמית…" : "מחלץ אקורדים מגרסת המשתמשים…");
    const tab = await this.tab(candidate);
    let content = text(record(tab.view.wiki_tab).content);
    // Authenticated Official pages expose a Chords toggle. Chord names live in
    // pre span[data-name]; diagrams elsewhere on the page are deliberately ignored.
    if (!content && candidate.official) {
      const chordView = tab.page.locator("pre").filter({ has: tab.page.locator("span[data-name]") });
      try {
        if (!await chordView.count()) await tab.page.getByRole("button", { name: "Chords", exact: true }).click();
        await chordView.first().waitFor({ state: "visible", timeout: 20_000 });
        if (new URL(siteUrl(tab.page.url())).pathname !== new URL(tab.candidate.url).pathname)
          throw new AgentError("source_mismatch", "תצוגת האקורדים עברה לגרסה אחרת. החילוץ נעצר.");
        if (await chordView.count() !== 1) throw new AgentError("site_changed", "נמצאו כמה תצוגות אקורדים ולא ניתן לזהות את המקור בוודאות.");
        // Runs inside the browser on a copy of the chart, marking chord elements for parsing without changing the displayed page.
        content = await chordView.first().evaluate(root => {
          const clone = root.cloneNode(true) as HTMLElement;
          for (const chord of clone.querySelectorAll("span[data-name]")) {
            chord.replaceWith(document.createTextNode(`[ch]${chord.textContent ?? ""}[/ch]`));
          }
          for (const br of clone.querySelectorAll("br")) br.replaceWith(document.createTextNode("\n"));
          return clone.textContent ?? "";
        });
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new AgentError("unsupported_content", "הגרסה הרשמית נפתחה אך תצוגת האקורדים לא נטענה. נסה שוב; לא נבחרה גרסת משתמשים במקומה.");
      }
    }
    if (!content) throw new AgentError("unsupported_content", "הגרסה קיימת, אך לא נמצא בה טקסט אקורדים שניתן לחלץ. ייתכן שהיא מוצגת בנגן תווים בלבד. לא הוחלפה בגרסה לא רשמית.");
    const parsed = parseChordContent(content);
    const meta = record(tab.view.meta);
    return { source: tab.candidate, selection, retrievedAt: new Date().toISOString(),
      warning: candidate.official ? null : "זו גרסת משתמשים ולא גרסה רשמית; ייתכנו אי־דיוקים.",
      capo: count(meta.capo), tuning: text(record(meta.tuning).value) || null,
      key: text(meta.tonality) || text(tab.tab.tonality_name) || null, ...parsed };
  }
}
