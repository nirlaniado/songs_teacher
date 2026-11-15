// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.js";
import { Slide } from "../schema/deck.js";
import { useAuthStore } from "../store/authStore.js";
import { useDeckStore } from "../store/deckStore.js";
import { openDeck, stubResizeObserver } from "../test/dom.js";
import { json, stubAuthServer, type Route, type Sent } from "../test/http.js";
import { DeckScreen } from "./DeckScreen.js";

// The account page, reached the way a person reaches it: the whole app mounted, signed in, then "Account" in the
// signed-in indicator. The accounts API is the stub in src/test/http.ts.
let routes: Record<string, Route>;
let requests: Sent[];
const alice = { id: 1, username: "alice" };
const notSignedIn = () => json(401, { error: "Not signed in." });
const ok = () => json(200, { ok: true });
const UNREACHABLE = "Can't reach the server. Check your connection and try again.";

beforeAll(stubResizeObserver);
beforeEach(() => {
  ({ routes, requests } = stubAuthServer());
  useAuthStore.setState({ status: "checking", user: null });
  useDeckStore.setState({ supported: true, attached: false, usingFallbackStorage: false, restoreOnLoad: async () => {} });
  // The delete confirmation is typed in the page; a browser dialog would fail these tests.
  vi.stubGlobal("confirm", () => { throw new Error("confirm() called"); });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function accountPage(user: object = alice) {
  routes["GET /api/auth/me"] = () => json(200, { user });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Account" }));
  await screen.findByRole("heading", { name: "Your account" });
}
const section = (name: string) => within(screen.getByRole("region", { name }));
const type = (scope: ReturnType<typeof section>, label: string, value: string) =>
  fireEvent.change(scope.getByLabelText(label), { target: { value } });
const signInScreen = () => screen.findByRole("heading", { name: "Sign in" });
const sent = (path: string) => requests.filter((r) => r.path === path);
/** The editor on its own, signed in, with or without unsaved changes. */
const editor = (dirty: boolean) => {
  useAuthStore.setState({ status: "signedIn", user: alice });
  const deck = openDeck([Slide.parse({ id: "00000000-0000-4000-8000-0000000000e0", elements: [] })]);
  useDeckStore.setState({ savedSnapshot: JSON.stringify(dirty ? { ...deck, title: "Older" } : deck) });
  const onAccount = vi.fn();
  render(<DeckScreen onBack={() => {}} onAccount={onAccount} />);
  return onAccount;
};

describe("reaching the account page", () => {
  it("opens from the signed-in indicator and goes back to the app", async () => {
    await accountPage();
    expect(screen.getByText(/signed in as/i).textContent).toBe("Signed in as alice");
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(await screen.findByRole("button", { name: "Open folder" })).toBeTruthy();
  });

  it("opens from the presentations library", async () => {
    routes["GET /api/auth/me"] = () => json(200, { user: alice });
    useDeckStore.setState({ attached: true, decks: [], refreshDecks: async () => {} });
    render(<App />);
    await screen.findByRole("button", { name: /close library/i });
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(await screen.findByRole("heading", { name: "Your account" })).toBeTruthy();
  });

  describe("from the editor, through the editor's unsaved-changes check", () => {
    it("goes straight there with nothing unsaved", () => {
      const onAccount = editor(false);
      fireEvent.click(screen.getByRole("button", { name: "Account" }));
      expect(onAccount).toHaveBeenCalledTimes(1);
    });

    it.each([[false, 0], [true, 1]])("asks first with unsaved changes; leaving when answered %s", (answer, calls) => {
      const onAccount = editor(true);
      const asked = vi.fn(() => answer);
      vi.stubGlobal("confirm", asked);
      fireEvent.click(screen.getByRole("button", { name: "Account" }));
      expect(asked).toHaveBeenCalledWith("You have unsaved changes. Leave anyway?");
      expect(onAccount).toHaveBeenCalledTimes(calls);
    });
  });

  describe("and Sign out in the editor goes through the same check", () => {
    const signOut = () => fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    it("signs out straight away with nothing unsaved", async () => {
      routes["POST /api/auth/logout"] = ok;
      editor(false);
      signOut();
      await waitFor(() => expect(useAuthStore.getState().status).toBe("signedOut"));
      expect(useDeckStore.getState().deck).toBeNull();
    });

    it("cancelled: no request, still signed in, still in the editor with the edits", async () => {
      editor(true);
      const asked = vi.fn(() => false);
      vi.stubGlobal("confirm", asked);
      signOut();
      expect(asked).toHaveBeenCalledWith("You have unsaved changes. Leave anyway?");
      expect(sent("/api/auth/logout")).toEqual([]);
      expect(useAuthStore.getState().status).toBe("signedIn");
      expect(useDeckStore.getState().isDirty()).toBe(true);
      expect(screen.getByRole("button", { name: "← Presentations" })).toBeTruthy();
    });

    it("confirmed: signs out and closes the deck", async () => {
      routes["POST /api/auth/logout"] = ok;
      editor(true);
      vi.stubGlobal("confirm", () => true);
      signOut();
      await waitFor(() => expect(useAuthStore.getState().status).toBe("signedOut"));
      expect(sent("/api/auth/logout")).toHaveLength(1);
      expect(useDeckStore.getState().deck).toBeNull();
    });

    it("confirmed but the server doesn't answer: still signed in, the deck and its edits still open", async () => {
      routes["POST /api/auth/logout"] = () => "down";
      editor(true);
      vi.stubGlobal("confirm", () => true);
      signOut();
      expect((await screen.findByRole("alert")).textContent).toMatch(/^Couldn't sign out/);
      expect(useAuthStore.getState().status).toBe("signedIn");
      expect(useDeckStore.getState().isDirty()).toBe(true);
    });
  });
});

describe("change password", () => {
  const fill = (current: string, next: string, repeat = next) => {
    const form = section("Change password");
    type(form, "Current password", current);
    type(form, "New password", next);
    type(form, "Repeat new password", repeat);
    fireEvent.click(form.getByRole("button", { name: "Change password" }));
    return form;
  };

  it("sends the current and new password, says so, clears the fields and stays signed in", async () => {
    routes["POST /api/auth/password"] = ok;
    await accountPage();
    const form = fill("old password", "a new password");
    expect((await form.findByRole("status")).textContent).toMatch(/^Password changed\. Every other browser and device/);
    expect(sent("/api/auth/password")).toEqual([
      { method: "POST", path: "/api/auth/password", body: { currentPassword: "old password", newPassword: "a new password" } },
    ]);
    for (const label of ["Current password", "New password", "Repeat new password"])
      expect((form.getByLabelText(label) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("heading", { name: "Your account" })).toBeTruthy();
  });

  it("catches a mistyped repeat without asking the server", async () => {
    await accountPage();
    const form = fill("old password", "a new password", "a new pasword");
    expect(form.getByRole("alert").textContent).toBe("The new passwords don't match.");
    expect(sent("/api/auth/password")).toEqual([]);
  });

  it.each([
    ["a wrong current password", () => json(403, { error: "Wrong password." }), "Wrong password."],
    ["a too-short new password", () => json(400, { error: "Password must be at least 10 characters." }), "Password must be at least 10 characters."],
    ["a locked account", () => json(429, { error: "Too many failed attempts for this account. Try again later." }, { "Retry-After": "600" }), "Too many attempts. Try again in 10 minutes."],
    ["a server that is down", () => "down" as const, UNREACHABLE],
  ])("shows %s inline and keeps what was typed", async (_what, reply, message) => {
    routes["POST /api/auth/password"] = reply;
    await accountPage();
    const form = fill("old password", "a new password");
    expect((await form.findByRole("alert")).textContent).toBe(message);
    expect(form.queryByRole("status")).toBeNull();
    expect((form.getByLabelText("Current password") as HTMLInputElement).value).toBe("old password");
  });

  it("goes to the sign-in screen when the session has already been ended elsewhere", async () => {
    routes["POST /api/auth/password"] = notSignedIn;
    await accountPage();
    fill("old password", "a new password");
    expect(await signInScreen()).toBeTruthy();
  });
});

describe("sign out everywhere", () => {
  const press = () => fireEvent.click(section("Sign out everywhere").getByRole("button", { name: "Sign out everywhere" }));

  it("ends every session and lands on the sign-in screen", async () => {
    routes["POST /api/auth/logout-all"] = ok;
    await accountPage();
    press();
    expect(await signInScreen()).toBeTruthy();
    expect(sent("/api/auth/logout-all")).toEqual([{ method: "POST", path: "/api/auth/logout-all", body: undefined }]);
  });

  it("stays signed in and says so when the server doesn't answer", async () => {
    routes["POST /api/auth/logout-all"] = () => "down";
    await accountPage();
    press();
    expect((await section("Sign out everywhere").findByRole("alert")).textContent).toBe(UNREACHABLE);
    expect(screen.getByRole("heading", { name: "Your account" })).toBeTruthy();
  });

  it("lands on the sign-in screen when the session was already ended", async () => {
    routes["POST /api/auth/logout-all"] = notSignedIn;
    await accountPage();
    press();
    expect(await signInScreen()).toBeTruthy();
  });
});

describe("delete account", () => {
  const button = () => section("Delete account").getByRole("button", { name: "Delete my account" }) as HTMLButtonElement;

  it("stays disabled until the password is given and the username typed exactly", async () => {
    await accountPage();
    const form = section("Delete account");
    expect(button().disabled).toBe(true);
    type(form, "Password", "my password");
    expect(button().disabled).toBe(true);
    for (const wrong of ["alic", "Alice", "alice "]) {
      type(form, "Type alice to confirm", wrong);
      expect(button().disabled).toBe(true);
    }
    type(form, "Type alice to confirm", "alice");
    expect(button().disabled).toBe(false);
    type(form, "Password", "");
    expect(button().disabled).toBe(true);
    fireEvent.submit(button().form!);
    expect(sent("/api/auth/account")).toEqual([]);
  });

  it("sends the password and lands on the sign-in screen", async () => {
    routes["DELETE /api/auth/account"] = ok;
    await accountPage();
    const form = section("Delete account");
    type(form, "Password", "my password");
    type(form, "Type alice to confirm", "alice");
    fireEvent.click(button());
    expect(await signInScreen()).toBeTruthy();
    expect(sent("/api/auth/account")).toEqual([{ method: "DELETE", path: "/api/auth/account", body: { password: "my password" } }]);
  });

  it.each([
    ["a wrong password", () => json(403, { error: "Wrong password." }), "Wrong password."],
    ["a locked account", () => json(429, {}, { "Retry-After": "45" }), "Too many attempts. Try again in 45 seconds."],
    ["a server that is down", () => json(502, {}), UNREACHABLE],
  ])("shows %s inline and keeps the account open", async (_what, reply, message) => {
    routes["DELETE /api/auth/account"] = reply;
    await accountPage();
    const form = section("Delete account");
    type(form, "Password", "my password");
    type(form, "Type alice to confirm", "alice");
    fireEvent.click(button());
    expect((await form.findByRole("alert")).textContent).toBe(message);
    expect(useAuthStore.getState().status).toBe("signedIn");
  });

  it("is not offered to the admin account", async () => {
    await accountPage({ id: 1, username: "owner", admin: true });
    expect(screen.queryByRole("region", { name: "Delete account" })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(screen.getByText("This is the admin account, so it can't be deleted.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Change password" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Sign out everywhere" })).toBeTruthy();
  });
});

describe("an admin flag the page can't see", () => {
  it("treats a missing admin flag as not admin, and the server still refuses", async () => {
    routes["DELETE /api/auth/account"] = () => json(403, { error: "The admin account can't be deleted." });
    await accountPage({ id: 1, username: "owner" });
    const form = section("Delete account");
    type(form, "Password", "my password");
    type(form, "Type owner to confirm", "owner");
    fireEvent.click(button());
    await waitFor(() => expect(form.getByRole("alert").textContent).toBe("The admin account can't be deleted."));
  });
  const button = () => section("Delete account").getByRole("button", { name: "Delete my account" });
});
