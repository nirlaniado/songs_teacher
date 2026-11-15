// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.js";
import { Slide } from "../schema/deck.js";
import { useAuthStore } from "../store/authStore.js";
import { useDeckStore } from "../store/deckStore.js";
import { openDeck, stubResizeObserver } from "../test/dom.js";
import { json, stubAuthServer, type Route, type Sent } from "../test/http.js";
import { AdminPage } from "./AdminPage.js";
import { DeckScreen } from "./DeckScreen.js";

// The admin panel and the forced password change, with the whole app mounted where it matters. The accounts API is
// the stub in src/test/http.ts, here backed by a small model of the admin endpoints so a reload shows each change.
let routes: Record<string, Route>;
let requests: Sent[];
const OWNER = { id: 1, username: "owner", admin: true };
const UNREACHABLE = "Can't reach the server. Check your connection and try again.";
const T = "2026-11-15T10:00:00.000Z";
const when = (iso: string) => new Date(iso).toLocaleString();

type Row = { id: number; username: string; createdAt: string; lastSignInAt: string | null; disabled: boolean; mustChangePassword: boolean; admin: boolean };
function fakeAdmin(extra: string[] = []) {
  const users: Row[] = [
    { id: 1, username: "owner", createdAt: T, lastSignInAt: T, disabled: false, mustChangePassword: false, admin: true },
    { id: 2, username: "alice", createdAt: T, lastSignInAt: null, disabled: false, mustChangePassword: false, admin: false },
    ...extra.map((username, i) => ({ id: 3 + i, username, createdAt: T, lastSignInAt: T, disabled: false, mustChangePassword: false, admin: false })),
  ];
  const audit: Array<{ id: number; at: string; action: string; targetUserId: number; targetUsername: string }> = [];
  let temporary = 0;
  const log = (action: string, user: Row) => audit.push({ id: audit.length + 1, at: T, action, targetUserId: user.id, targetUsername: user.username });
  const target = (url: URL) => users.find((u) => u.id === Number(url.pathname.split("/")[4]));
  routes["GET /api/admin/users"] = (_b, url) => {
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    const page = Number(url.searchParams.get("page")), perPage = Number(url.searchParams.get("perPage"));
    const matching = users.filter((u) => u.username.toLowerCase().includes(search));
    return json(200, { users: matching.slice((page - 1) * perPage, page * perPage), total: matching.length, page, perPage });
  };
  routes["GET /api/admin/audit"] = (_b, url) => {
    const page = Number(url.searchParams.get("page")), perPage = Number(url.searchParams.get("perPage"));
    return json(200, { entries: [...audit].reverse().slice((page - 1) * perPage, page * perPage), total: audit.length, page, perPage });
  };
  for (const action of ["disable", "enable"]) {
    for (const u of users) routes[`POST /api/admin/users/${u.id}/${action}`] = (_b, url) => {
      const user = target(url)!;
      user.disabled = action === "disable";
      log(action, user);
      return json(200, { ok: true });
    };
  }
  for (const u of users) {
    routes[`POST /api/admin/users/${u.id}/reset-password`] = (_b, url) => {
      const user = target(url)!;
      user.mustChangePassword = true;
      log("reset-password", user);
      return json(200, { temporaryPassword: `Temp-${++temporary}-xYz` });
    };
    routes[`DELETE /api/admin/users/${u.id}`] = (_b, url) => {
      const user = target(url)!;
      users.splice(users.indexOf(user), 1);
      log("delete", user);
      return json(200, { ok: true });
    };
  }
  return { users, audit };
}

beforeAll(stubResizeObserver);
beforeEach(() => {
  ({ routes, requests } = stubAuthServer());
  useAuthStore.setState({ status: "checking", user: null });
  useDeckStore.setState({ supported: true, attached: false, usingFallbackStorage: false, restoreOnLoad: async () => {} });
  vi.stubGlobal("confirm", () => { throw new Error("confirm() called"); });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function app(user: object = OWNER) {
  routes["GET /api/auth/me"] = () => json(200, { user });
  render(<App />);
  await screen.findByText(/signed in as/i);
}
async function adminPage(extra?: string[]) {
  const model = fakeAdmin(extra);
  await app();
  fireEvent.click(screen.getByRole("button", { name: "Admin" }));
  await screen.findByRole("heading", { name: "Admin" });
  await screen.findByRole("cell", { name: "alice" });
  return model;
}
const rowOf = (username: string) => within(screen.getByRole("cell", { name: username }).closest("tr")!);
const sent = (method: string, path: string) => requests.filter((r) => r.method === method && r.path.split("?")[0] === path);
const lastQuery = () => new URL(requests.filter((r) => r.path.startsWith("/api/admin/users?")).at(-1)!.path, "http://x").searchParams;

describe("who sees the panel", () => {
  it("offers Admin only to the admin account", async () => {
    await app({ id: 2, username: "alice" });
    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    cleanup();
    await app();
    expect(screen.getByRole("button", { name: "Admin" })).toBeTruthy();
  });

  it("refuses a non-admin who reaches the page anyway, on the server's word, showing no users", async () => {
    useAuthStore.setState({ status: "signedIn", user: { id: 2, username: "alice" } });
    routes["GET /api/admin/users"] = () => json(403, { error: "Only the admin can do that." });
    render(<AdminPage onBack={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Only the admin can do that. This page is for the admin account only.");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Audit log" })).toBeNull();
  });

  it("goes to the sign-in screen when the server says the session is over", async () => {
    await app();
    routes["GET /api/admin/users"] = () => json(401, { error: "Not signed in." });
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("goes to the forced password change when the server says so, whatever /me said", async () => {
    await app();
    routes["GET /api/admin/users"] = () => json(403, { error: "Change your password before doing anything else.", code: "must_change_password" });
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeTruthy();
  });

  it("from the editor, goes through the unsaved-changes check", () => {
    useAuthStore.setState({ status: "signedIn", user: OWNER });
    const deck = openDeck([Slide.parse({ id: "00000000-0000-4000-8000-0000000000e0", elements: [] })]);
    useDeckStore.setState({ savedSnapshot: JSON.stringify({ ...deck, title: "Older" }) });
    const onAdmin = vi.fn();
    render(<DeckScreen onBack={() => {}} onAdmin={onAdmin} />);
    const asked = vi.fn(() => false);
    vi.stubGlobal("confirm", asked);
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(asked).toHaveBeenCalledWith("You have unsaved changes. Leave anyway?");
    expect(onAdmin).not.toHaveBeenCalled();
    vi.stubGlobal("confirm", () => true);
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(onAdmin).toHaveBeenCalledTimes(1);
  });
});

describe("the user table", () => {
  it("shows username, created, last sign-in and status, and the admin's own row has no actions", async () => {
    await adminPage();
    const owner = rowOf("owner");
    expect(owner.getByText("Your account")).toBeTruthy();
    expect(owner.queryAllByRole("button")).toEqual([]);
    const alice = rowOf("alice");
    expect(alice.getAllByRole("cell").map((c) => c.textContent)).toEqual(["alice", when(T), "Never", "Active", "DisableReset password…Delete…"]);
  });

  it("disables and enables a user, and shows the change", async () => {
    await adminPage();
    fireEvent.click(rowOf("alice").getByRole("button", { name: "Disable alice" }));
    await waitFor(() => expect(rowOf("alice").getByText("Disabled")).toBeTruthy());
    expect(sent("POST", "/api/admin/users/2/disable")).toHaveLength(1);
    fireEvent.click(rowOf("alice").getByRole("button", { name: "Enable alice" }));
    await waitFor(() => expect(rowOf("alice").getByText("Active")).toBeTruthy());
    expect(sent("POST", "/api/admin/users/2/enable")).toHaveLength(1);
  });

  it("deletes only after a confirmation in the page that names the user", async () => {
    await adminPage();
    fireEvent.click(rowOf("alice").getByRole("button", { name: "Delete alice…" }));
    const confirm = within(screen.getByRole("group", { name: "Confirm: Delete alice" }));
    expect(confirm.getByText(/permanently/).textContent).toMatch(/^Delete alice permanently\?/);
    fireEvent.click(confirm.getByRole("button", { name: "Cancel" }));
    expect(sent("DELETE", "/api/admin/users/2")).toEqual([]);
    fireEvent.click(rowOf("alice").getByRole("button", { name: "Delete alice…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete alice" }));
    await waitFor(() => expect(screen.queryByRole("cell", { name: "alice" })).toBeNull());
    expect(sent("DELETE", "/api/admin/users/2")).toHaveLength(1);
  });

  it("searches by username from page 1, and pages", async () => {
    await adminPage(Array.from({ length: 30 }, (_, i) => `user${String(i).padStart(2, "0")}`));
    const nav = within(screen.getByRole("navigation", { name: "Pages" }));
    expect(nav.getByText(/Page 1 of 2 · 32 users/)).toBeTruthy();
    expect((nav.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(nav.getByRole("button", { name: "Next" }));
    await screen.findByRole("cell", { name: "user29" });
    expect(lastQuery().get("page")).toBe("2");
    expect((within(screen.getByRole("navigation", { name: "Pages" })).getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search by username" }), { target: { value: " ALI " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("cell", { name: "alice" });
    expect([lastQuery().get("search"), lastQuery().get("page")]).toEqual(["ALI", "1"]);
    expect(screen.queryByRole("cell", { name: "owner" })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search by username" }), { target: { value: "zzz" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText('No username contains "zzz".')).toBeTruthy();
  });
});

describe("resetting a password", () => {
  async function reset() {
    await adminPage();
    fireEvent.click(rowOf("alice").getByRole("button", { name: "Reset alice's password…" }));
    const confirm = within(screen.getByRole("group", { name: "Confirm: Reset alice's password" }));
    expect(confirm.getByText(/must choose a new password/).textContent).toMatch(/^Reset the password of alice\?/);
    fireEvent.click(confirm.getByRole("button", { name: "Reset alice's password" }));
    return screen.findByRole("dialog", { name: "Temporary password for alice" });
  }

  it("needs the named confirmation; Cancel sends nothing", async () => {
    await adminPage();
    fireEvent.click(rowOf("alice").getByRole("button", { name: "Reset alice's password…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: /^Confirm/ })).toBeNull();
    expect(sent("POST", "/api/admin/users/2/reset-password")).toEqual([]);
  });

  it("shows the temporary password once, with a copy button and a note, and forgets it on Done", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const dialog = within(await reset());
    expect((dialog.getByRole("textbox", { name: "Temporary password" }) as HTMLInputElement).value).toBe("Temp-1-xYz");
    expect(dialog.getByText(/only time it is shown/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Copy" }));
    await dialog.findByText("Copied.");
    expect(writeText).toHaveBeenCalledWith("Temp-1-xYz");
    await waitFor(() => expect(rowOf("alice").getByText("Must change password")).toBeTruthy());

    expect(JSON.stringify(useAuthStore.getState())).not.toContain("Temp-1-xYz");
    expect(JSON.stringify(useDeckStore.getState())).not.toContain("Temp-1-xYz");
    expect(location.href).not.toContain("Temp-1-xYz");
    expect(JSON.stringify({ ...localStorage })).not.toContain("Temp-1-xYz");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("Temp-1-xYz");

    fireEvent.click(dialog.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.innerHTML).not.toContain("Temp-1-xYz");
  });

  it("closes with Escape too, and says so when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => { throw new Error("denied"); } } });
    const dialog = within(await reset());
    fireEvent.click(dialog.getByRole("button", { name: "Copy" }));
    expect((await dialog.findByRole("status")).textContent).toBe("Couldn't copy. Select it and copy it by hand.");
    fireEvent.keyDown(dialog.getByRole("button", { name: "Done" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.innerHTML).not.toContain("Temp-1-xYz");
  });
});

describe("the audit view", () => {
  it("lists admin actions newest first, and pages", async () => {
    const model = await adminPage();
    for (let i = 0; i < 26; i++) model.audit.push({ id: i + 1, at: T, action: "enable", targetUserId: 2, targetUsername: "alice" });
    model.audit.push({ id: 27, at: "2026-11-15T11:00:00.000Z", action: "reset-password", targetUserId: 2, targetUsername: "alice" });
    fireEvent.click(screen.getByRole("button", { name: "Audit log" }));
    const table = await screen.findByRole("table");
    const first = within(within(table).getAllByRole("row")[1]!).getAllByRole("cell").map((c) => c.textContent);
    expect(first).toEqual([when("2026-11-15T11:00:00.000Z"), "Reset password", "alice #2"]);
    expect(screen.getByText(/Page 1 of 2 · 27 entries/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 2 of 2/);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
  });

  it("records the panel's own actions", async () => {
    await adminPage();
    fireEvent.click(rowOf("alice").getByRole("button", { name: "Disable alice" }));
    await waitFor(() => expect(rowOf("alice").getByText("Disabled")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Audit log" }));
    expect(await screen.findByRole("cell", { name: "Disabled" })).toBeTruthy();
  });
});

describe("error answers", () => {
  it("shows a refused action inline and keeps the page", async () => {
    await adminPage();
    routes["POST /api/admin/users/2/disable"] = () => json(404, { error: "No such user." });
    fireEvent.click(rowOf("alice").getByRole("button", { name: "Disable alice" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No such user.");
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("offers Retry when the list can't be loaded, which works once the server is back", async () => {
    fakeAdmin();
    const working = routes["GET /api/admin/users"]!;
    routes["GET /api/admin/users"] = () => "down";
    await app();
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect((await screen.findByRole("alert")).textContent).toBe(UNREACHABLE);
    routes["GET /api/admin/users"] = working;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("cell", { name: "alice" })).toBeTruthy();
  });

  it("goes to the sign-in screen when an action answers 401", async () => {
    await adminPage();
    routes["POST /api/admin/users/2/disable"] = () => json(401, { error: "Not signed in." });
    fireEvent.click(rowOf("alice").getByRole("button", { name: "Disable alice" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });
});

describe("the forced password change", () => {
  const RESET = { id: 2, username: "alice", mustChangePassword: true };
  const fill = (temporary: string, next: string, repeat = next) => {
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: temporary } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: repeat } });
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
  };
  async function forced() {
    routes["GET /api/auth/me"] = () => json(200, { user: RESET });
    render(<App />);
    await screen.findByRole("heading", { name: "Choose a new password" });
  }

  it("replaces the whole app while the flag is set: no start screen, no badge, no account page", async () => {
    await forced();
    expect(screen.queryByRole("button", { name: "Open folder" })).toBeNull();
    expect(screen.queryByText(/signed in as/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
    expect(screen.getByText(/reset the password for/).textContent).toMatch(/alice/);
  });

  it("uses the password-change endpoint, then opens the app", async () => {
    routes["POST /api/auth/password"] = () => json(200, { ok: true });
    await forced();
    fill("Temp-1-xYz", "alice new password");
    expect(await screen.findByRole("button", { name: "Open folder" })).toBeTruthy();
    expect(sent("POST", "/api/auth/password")).toEqual([
      { method: "POST", path: "/api/auth/password", body: { currentPassword: "Temp-1-xYz", newPassword: "alice new password" } },
    ]);
    expect(useAuthStore.getState().user).toEqual({ id: 2, username: "alice", mustChangePassword: false });
  });

  it.each([
    ["a mistyped repeat", null, "The new passwords don't match."],
    ["a wrong temporary password", () => json(403, { error: "Wrong password." }), "Wrong password."],
    ["a too-short new password", () => json(400, { error: "Password must be at least 10 characters." }), "Password must be at least 10 characters."],
    ["a server that is down", () => "down" as const, UNREACHABLE],
  ])("shows %s inline and stays", async (_what, reply, message) => {
    if (reply) routes["POST /api/auth/password"] = reply;
    await forced();
    fill("Temp-1-xYz", "alice new password", reply ? "alice new password" : "alice new pasword");
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeTruthy();
    if (!reply) expect(sent("POST", "/api/auth/password")).toEqual([]);
  });

  it("goes to the sign-in screen when the session is already over", async () => {
    routes["POST /api/auth/password"] = () => json(401, { error: "Not signed in." });
    await forced();
    fill("Temp-1-xYz", "alice new password");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("offers sign-out", async () => {
    routes["POST /api/auth/logout"] = () => json(200, { ok: true });
    await forced();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("appears mid-session when any answer says must_change_password, here from the account page", async () => {
    routes["DELETE /api/auth/account"] = () => json(403, { error: "Change your password before doing anything else.", code: "must_change_password" });
    await app({ id: 2, username: "alice" });
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    const remove = within(await screen.findByRole("region", { name: "Delete account" }));
    fireEvent.change(remove.getByLabelText("Password"), { target: { value: "alice password" } });
    fireEvent.change(remove.getByLabelText("Type alice to confirm"), { target: { value: "alice" } });
    fireEvent.click(remove.getByRole("button", { name: "Delete my account" }));
    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Your account" })).toBeNull();
  });
});
