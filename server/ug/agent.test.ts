import { describe, expect, it, vi } from "vitest";
import { GuitarAgent } from "./agent.js";
import { AgentError } from "./core.js";
import type { ChordResult, TabCandidate } from "../../src/ug/types.js";

const community: TabCandidate = { id: "1", title: "Test", artist: "Artist", url: "https://tabs.ultimate-guitar.com/tab/test-chords-1", official: false, version: 1, views: 100 };
const official: TabCandidate = { ...community, id: "2", official: true };
function harness(candidates: TabCandidate[]) {
  const browser = { setProgress: vi.fn(), login: vi.fn(async () => {}), search: vi.fn(async () => candidates),
    inspect: vi.fn(async (c: TabCandidate) => c), close: vi.fn(async () => {}),
    extract: vi.fn(async (source: TabCandidate, selection: ChordResult["selection"]): Promise<ChordResult> => ({ source, selection, retrievedAt: new Date().toISOString(), warning: source.official ? null : "זו גרסת משתמשים ולא גרסה רשמית; ייתכנו אי־דיוקים.", capo: null, tuning: null, key: null, lines: [], uniqueChords: ["C"], chart: "C" })) };
  const save = vi.fn(async () => {});
  const agent = new GuitarAgent(browser, async () => ({ title: "Test", artist: "Artist" }), save);
  return { agent, browser, save };
}
describe("agent workflow", () => {
  it("extracts Official and does not inspect or fall back to community versions", async () => {
    const { agent, browser } = harness([community, official]); const job = agent.start("Test - Artist");
    await vi.waitFor(() => expect(job.status).toBe("done"));
    expect(browser.inspect).not.toHaveBeenCalled(); expect(browser.extract).toHaveBeenCalledWith(official, "official");
  });
  it("never substitutes community content when Official extraction fails", async () => {
    const { agent, browser, save } = harness([official, community]);
    browser.extract.mockRejectedValue(new AgentError("unsupported_content", "Official unavailable"));
    const job = agent.start("Test - Artist"); await vi.waitFor(() => expect(job.status).toBe("error"));
    expect(browser.extract).toHaveBeenCalledTimes(1); expect(job.result).toBeUndefined(); expect(save).not.toHaveBeenCalled();
  });
  it("pauses for login and resumes without another model call or concurrent navigation", async () => {
    const { agent, browser } = harness([official]);
    browser.login.mockRejectedValueOnce(new AgentError("needs_login", "Login required"));
    const job = agent.start("Test - Artist"); await vi.waitFor(() => expect(job.status).toBe("needs_login"));
    expect(browser.search).not.toHaveBeenCalled(); expect(() => agent.start("Another song")).toThrow();
    agent.resume(job.id); await vi.waitFor(() => expect(job.status).toBe("done"));
  });
  it("requires explicit choice for missing views and labels the chosen community version", async () => {
    const unknown = { ...community, views: null }; const { agent } = harness([unknown]);
    const job = agent.start("Test - Artist"); await vi.waitFor(() => expect(job.status).toBe("needs_choice"));
    expect(() => agent.resume(job.id, "false:999")).toThrow();
    agent.resume(job.id, "false:1"); await vi.waitFor(() => expect(job.status).toBe("done"));
    expect(job.result?.selection).toBe("user_selected"); expect(job.result?.warning).toContain("לא גרסה רשמית");
  });
  it("does not treat an incomplete search as no Official version", async () => {
    const { agent, browser } = harness([community]);
    browser.search.mockRejectedValue(new AgentError("incomplete_search", "Incomplete"));
    const job = agent.start("Test - Artist"); await vi.waitFor(() => expect(job.status).toBe("error"));
    expect(browser.extract).not.toHaveBeenCalled();
  });
});
