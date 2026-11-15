// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.js";
import { waitFor as waitText } from "../auth/client.js";
import { useAuthStore } from "../store/authStore.js";
import { useDeckStore } from "../store/deckStore.js";
import { openDeck, stubResizeObserver } from "../test/dom.js";
import { json, stubAuthServer, type Route, type Sent } from "../test/http.js";
import { Slide } from "../schema/deck.js";
import { DeckScreen } from "./DeckScreen.js";

// The whole app mounted behind the sign-in gate, against the stub accounts API in src/test/http.ts.
let routes: Record<string, Route>;
let requests: Sent[];

const alice = { id: 1, username: "alice" };
const signedIn = () => json(200, { user: alice });
const signedOut = () => json(401, { error: "Not signed in." });

beforeAll(stubResizeObserver);
beforeEach(() => {
  ({ routes, requests } = stubAuthServer());
  useAuthStore.setState({ status: "checking", user: null });
  useDeckStore.setState({ supported: true, attached: false, usingFallbackStorage: false, restoreOnLoad: async () => {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const app = () => render(<App />);
const signInForm = () => screen.queryByRole("form", { name: /sign in|create an account/i });
const startScreen = () => screen.queryByRole("button", { name: "Open folder" });
const fill = (username: string, password: string) => {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
};
const send = () => fireEvent.submit(signInForm()!);

describe("on load the app asks the server who is signed in", () => {
  it("shows nothing of the app while it waits", async () => {
    let answer!: (r: Response) => void;
    routes["GET /api/auth/me"] = () => new Promise<Response>((r) => (answer = r)) as never;
    app();
    expect(screen.getByText("Checking your sign-in…")).toBeTruthy();
    expect(startScreen()).toBeNull();
    await act(async () => answer(signedIn()));
    expect(startScreen()).not.toBeNull();
  });

  it("signed out: only the sign-in screen, no start screen, nav or chord agent", async () => {
    routes["GET /api/auth/me"] = signedOut;
    app();
    await waitFor(() => expect(signInForm()).not.toBeNull());
    expect(startScreen()).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: /chord/i })).toBeNull();
    expect(screen.queryByText(/signed in as/i)).toBeNull();
  });

  it("signed in: the app as before, saying who is signed in", async () => {
    routes["GET /api/auth/me"] = signedIn;
    app();
    await waitFor(() => expect(startScreen()).not.toBeNull());
    expect(signInForm()).toBeNull();
    expect(screen.getByText(/signed in as/i).textContent).toBe("Signed in as alice");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(requests).toEqual([expect.objectContaining({ method: "GET", path: "/api/auth/me" })]);
  });

  it("asks with the session cookie", async () => {
    const seen: RequestInit[] = [];
    routes["GET /api/auth/me"] = signedIn;
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string, init: RequestInit) => (seen.push(init), stubbed(input, init)));
    app();
    await waitFor(() => expect(startScreen()).not.toBeNull());
    expect(seen[0]!.credentials).toBe("same-origin");
  });

  it.each([
    ["the server is down", () => "down" as const],
    ["the dev proxy can't reach it (500)", () => json(500, {})],
    ["accounts are unavailable (503)", () => json(503, { error: "Accounts are unavailable: DATABASE_URL is not set." })],
    ["the answer isn't a user", () => json(200, { nope: true })],
  ])("unreachable when %s, with a retry that works once it is back", async (_why, reply) => {
    routes["GET /api/auth/me"] = reply;
    app();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Can't reach the server" })).toBeTruthy());
    expect(startScreen()).toBeNull();
    expect(signInForm()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Can't reach the server" })).toBeTruthy());
    expect(requests.filter((r) => r.path === "/api/auth/me").length).toBeGreaterThanOrEqual(2);

    routes["GET /api/auth/me"] = signedIn;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(startScreen()).not.toBeNull());
  });

  it("retry lands on the sign-in screen when the server is back and nobody is signed in", async () => {
    routes["GET /api/auth/me"] = () => "down";
    app();
    await screen.findByRole("button", { name: "Retry" });
    routes["GET /api/auth/me"] = signedOut;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(signInForm()).not.toBeNull());
  });
});

describe("signing in and up", () => {
  beforeEach(() => {
    routes["GET /api/auth/me"] = signedOut;
  });

  it("signs in and opens the app", async () => {
    routes["POST /api/auth/login"] = () => signedIn();
    app();
    await waitFor(() => expect(signInForm()).not.toBeNull());
    fill("alice", "correct horse");
    send();
    await waitFor(() => expect(startScreen()).not.toBeNull());
    expect(requests.at(-1)).toEqual({ method: "POST", path: "/api/auth/login", body: { username: "alice", password: "correct horse" } });
    expect(screen.getByText(/signed in as/i).textContent).toBe("Signed in as alice");
  });

  it("signs up and opens the app", async () => {
    routes["POST /api/auth/signup"] = () => json(201, { user: { id: 2, username: "bob" } });
    app();
    await waitFor(() => expect(signInForm()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    expect(screen.getByRole("heading", { name: "Create an account" })).toBeTruthy();
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
    fill("bob", "long enough pw");
    send();
    await waitFor(() => expect(startScreen()).not.toBeNull());
    expect(requests.at(-1)).toEqual({ method: "POST", path: "/api/auth/signup", body: { username: "bob", password: "long enough pw" } });
    expect(screen.getByText(/signed in as/i).textContent).toBe("Signed in as bob");
  });

  it.each([
    ["signup", "a taken username", json(409, { error: "That username is taken." }), "That username is taken."],
    ["signup", "a short password", json(400, { error: "Password must be at least 10 characters." }), "Password must be at least 10 characters."],
    ["signup", "a bad username", json(400, { error: "Username must be 3–32 letters, digits, _ or -." }), "Username must be 3–32 letters, digits, _ or -."],
    ["login", "wrong credentials", json(401, { error: "Wrong username or password." }), "Wrong username or password."],
    ["login", "a disabled account", json(403, { error: "This account is disabled." }), "This account is disabled."],
    ["login", "a locked account", json(429, { error: "Too many failed attempts for this account. Try again later." }, { "Retry-After": "900" }), "Too many attempts. Try again in 15 minutes."],
    ["login", "too many attempts from here", json(429, { error: "Rate limit exceeded" }, { "Retry-After": "30" }), "Too many attempts. Try again in 30 seconds."],
    ["login", "429 with no Retry-After", json(429, {}), "Too many attempts. Try again later."],
    ["login", "an error with no message", new Response("", { status: 418 }), "The server refused that (418)."],
    ["login", "the server going down mid-form", "down" as const, "Can't reach the server. Check your connection and try again."],
    ["login", "a 502 from the proxy", json(502, {}), "Can't reach the server. Check your connection and try again."],
  ])("%s: %s is shown inline and the form stays", async (mode, _what, reply, message) => {
    routes[`POST /api/auth/${mode}`] = () => reply;
    app();
    await waitFor(() => expect(signInForm()).not.toBeNull());
    if (mode === "signup") fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    fill("alice", "some password");
    send();
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(signInForm()).not.toBeNull();
    expect(startScreen()).toBeNull();
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("alice");
    expect(screen.getByLabelText("Username").getAttribute("aria-invalid")).toBe("true");
  });

  it("clears the error when switching between sign in and sign up", async () => {
    routes["POST /api/auth/login"] = () => json(401, { error: "Wrong username or password." });
    app();
    await waitFor(() => expect(signInForm()).not.toBeNull());
    fill("alice", "some password");
    send();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a second try after an error can succeed", async () => {
    let attempts = 0;
    routes["POST /api/auth/login"] = () => (++attempts === 1 ? json(401, { error: "Wrong username or password." }) : signedIn());
    app();
    await waitFor(() => expect(signInForm()).not.toBeNull());
    fill("alice", "wrong password");
    send();
    await screen.findByRole("alert");
    fill("alice", "correct horse");
    send();
    await waitFor(() => expect(startScreen()).not.toBeNull());
  });
});

describe("signing out", () => {
  it("returns to the sign-in screen, and the app is no longer reachable", async () => {
    routes["GET /api/auth/me"] = signedIn;
    routes["POST /api/auth/logout"] = () => json(200, { ok: true });
    app();
    await waitFor(() => expect(startScreen()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signInForm()).not.toBeNull());
    expect(requests.at(-1)).toEqual(expect.objectContaining({ method: "POST", path: "/api/auth/logout" }));
    expect(startScreen()).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it.each([["down", () => "down" as const], ["500", () => json(500, {})]])(
    "stays signed in and says so when the server is %s, since the session cookie still stands",
    async (_why, reply) => {
      routes["GET /api/auth/me"] = signedIn;
      routes["POST /api/auth/logout"] = reply;
      app();
      await waitFor(() => expect(startScreen()).not.toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      expect((await screen.findByRole("alert")).textContent).toBe("Couldn't sign out: the server didn't answer. Try again.");
      expect(startScreen()).not.toBeNull();
    },
  );
});

describe("the signed-in indicator", () => {
  it("is in the editor, and signs out from there", async () => {
    useAuthStore.setState({ status: "signedIn", user: alice });
    routes["POST /api/auth/logout"] = () => json(200, { ok: true });
    const deck = openDeck([Slide.parse({ id: "00000000-0000-4000-8000-0000000000e0", elements: [] })]);
    useDeckStore.setState({ savedSnapshot: JSON.stringify(deck) });
    render(<DeckScreen onBack={() => {}} />);
    expect(screen.getByText(/signed in as/i).textContent).toBe("Signed in as alice");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(useAuthStore.getState().status).toBe("signedOut"));
  });

  it("is on the presentations library once a folder is open", async () => {
    routes["GET /api/auth/me"] = signedIn;
    useDeckStore.setState({ attached: true, decks: [], refreshDecks: async () => {} });
    app();
    await waitFor(() => expect(screen.getByRole("button", { name: /close library/i })).toBeTruthy());
    expect(screen.getByText(/signed in as/i).textContent).toBe("Signed in as alice");
  });
});

describe("Retry-After", () => {
  it.each([
    ["1", "now"],
    ["59", "in 59 seconds"],
    ["60", "in 1 minute"],
    ["61", "in 2 minutes"],
    ["garbage", "later"],
  ])("%s seconds reads %s", (header, text) => {
    expect(waitText(header)).toBe(text);
  });

  it("accepts an HTTP date", () => {
    const now = Date.parse("2026-11-15T10:00:00Z");
    expect(waitText("Sun, 15 Nov 2026 10:05:00 GMT", now)).toBe("in 5 minutes");
  });
});
