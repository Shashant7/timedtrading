// worker/test-support/d1-sqlite.js
//
// A D1-shaped binding over an in-memory SQLite, for tests that need real SQL
// semantics (upserts, aggregates, ?N parameters) rather than a mock that
// agrees with whatever the code under test expects.

import Database from "better-sqlite3";

function toSqlValue(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export function d1Sqlite() {
  const db = new Database(":memory:");
  const prepare = (sql) => {
    let args = [];
    const numbered = /\?\d/.test(sql);
    const params = () => (numbered
      ? Object.fromEntries(args.map((v, i) => [i + 1, toSqlValue(v)]))
      : args.map(toSqlValue));
    const call = (method) => {
      const stmt = db.prepare(sql);
      const p = params();
      return numbered ? stmt[method](p) : stmt[method](...p);
    };
    const api = {
      bind(...a) { args = a; return api; },
      async run() {
        const r = call("run");
        return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
      },
      async first(col) {
        const row = call("get") ?? null;
        return col && row ? row[col] : row;
      },
      async all() { return { success: true, results: call("all") }; },
    };
    return api;
  };
  return {
    prepare,
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
    _db: db,
  };
}
