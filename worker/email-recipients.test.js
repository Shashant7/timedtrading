import { describe, it, expect } from "vitest";
import { getEmailOptedInUsers, findSuppressedRecipients } from "./email.js";

/** Minimal D1 stub that records the SQL it was handed and replays fixed rows. */
function makeDb(rows, captured = {}) {
  return {
    prepare(sql) {
      captured.sql = sql;
      return {
        bind(...args) { captured.args = args; return this; },
        all: async () => ({ results: rows }),
      };
    },
  };
}

const prefs = JSON.stringify({ investor_alerts: true, trade_alerts: true });

describe("getEmailOptedInUsers", () => {
  it("asks D1 to exclude anything that is not an active account", async () => {
    const captured = {};
    await getEmailOptedInUsers({ DB: makeDb([], captured) }, "trade_alerts");
    expect(captured.sql.replace(/\s+/g, " ")).toContain("COALESCE(status, 'active') = 'active'");
  });

  it("still filters on the per-user preference", async () => {
    const db = makeDb([
      { email: "a@x.com", tier: "pro", email_preferences: prefs, status: "active" },
      { email: "b@x.com", tier: "pro", email_preferences: JSON.stringify({ trade_alerts: false }), status: "active" },
    ]);
    const out = await getEmailOptedInUsers({ DB: db }, "trade_alerts");
    expect(out.map((u) => u.email)).toEqual(["a@x.com"]);
  });

  it("returns an empty list when D1 is unavailable", async () => {
    expect(await getEmailOptedInUsers({}, "trade_alerts")).toEqual([]);
  });
});

describe("findSuppressedRecipients", () => {
  it("reports removed and blocked addresses", async () => {
    const db = makeDb([
      { email: "gone@x.com", status: "removed" },
      { email: "banned@x.com", status: "blocked" },
    ]);
    const out = await findSuppressedRecipients({ DB: db }, ["gone@x.com", "ok@x.com", "banned@x.com"]);
    expect(out.has("gone@x.com")).toBe(true);
    expect(out.has("banned@x.com")).toBe(true);
    expect(out.has("ok@x.com")).toBe(false);
  });

  it("does not suppress addresses with no users row", async () => {
    const out = await findSuppressedRecipients({ DB: makeDb([]) }, ["operator@x.com"]);
    expect(out.size).toBe(0);
  });

  it("ignores blanks and de-duplicates before querying", async () => {
    const captured = {};
    await findSuppressedRecipients({ DB: makeDb([], captured) }, ["A@x.com", "a@x.com", "", null, "nope"]);
    expect(captured.args).toEqual(["a@x.com"]);
  });

  it("returns an empty set when there is nothing to check", async () => {
    expect((await findSuppressedRecipients({ DB: makeDb([]) }, [])).size).toBe(0);
  });
});
