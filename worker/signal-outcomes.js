// worker/signal-outcomes.js
// ─────────────────────────────────────────────────────────────────────────────
//  Signal Outcome Ledger (2026-06-11) — "nothing we publish goes unassessed."
//
//  Every call the system publishes — options plays attached to entries,
//  investor accumulate/reduce actions, FSD tactical signals (wired in the
//  fusion pass), future day-trade desk calls — lands here as a row with a
//  thesis, a target/stop or horizon, and gets RESOLVED + GRADED by the
//  nightly resolver against D1 candles. The Edge Scorecard, the CIO, and
//  the (internal) Scrimmage Room all read this one table.
//
//  Design notes:
//   • signal_id is caller-supplied and idempotent (INSERT OR IGNORE) so
//     writers can fire-and-forget from hot paths without dedup bookkeeping.
//   • Resolution is an UNDERLYING-PROXY for options plays: we do not store
//     historical option marks, so a play is graded on whether the underlying
//     did what the play needed (cleared breakeven / hit target before stop)
//     by expiry. resolve_note records the method so future deepening (real
//     option marks via Alpaca snapshots) can re-grade honestly.
//   • Pure classification logic is exported (classifyDirectionalOutcome)
//     and pinned by worker/signal-outcomes.test.js — the D1 plumbing stays
//     thin around it.
// ─────────────────────────────────────────────────────────────────────────────

const TABLE = "signal_outcomes";
const DAY_MS = 86400000;

let _schemaReady = false;

export async function ensureSignalOutcomesSchema(env) {
  if (_schemaReady) return;
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        signal_id     TEXT PRIMARY KEY,
        source        TEXT NOT NULL,
        desk          TEXT,
        ticker        TEXT NOT NULL,
        direction     TEXT,
        vehicle       TEXT,
        published_at  INTEGER NOT NULL,
        thesis        TEXT,
        ref_id        TEXT,
        entry_price   REAL,
        target_price  REAL,
        stop_price    REAL,
        breakeven     REAL,
        expiry_ts     INTEGER,
        horizon_days  INTEGER,
        payload_json  TEXT,
        status        TEXT NOT NULL DEFAULT 'open',
        resolved_at   INTEGER,
        outcome       TEXT,
        outcome_pct   REAL,
        grade         TEXT,
        resolve_note  TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER
      )
    `).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_signal_outcomes_status ON ${TABLE}(status, published_at)`
    ).run().catch(() => {});
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_signal_outcomes_ticker ON ${TABLE}(ticker, published_at)`
    ).run().catch(() => {});
    _schemaReady = true;
  } catch (e) {
    console.warn("[SIGNAL_OUTCOMES] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

/**
 * Record a published signal. Idempotent on signal_id — safe to call from
 * notification hot paths (never throws; returns {ok} best-effort).
 */
export async function recordSignal(env, sig) {
  try {
    const db = env?.DB;
    if (!db || !sig?.signal_id || !sig?.ticker || !sig?.source) {
      return { ok: false, error_kind: "bad_params" };
    }
    await ensureSignalOutcomesSchema(env);
    const now = Date.now();
    await db.prepare(`
      INSERT OR IGNORE INTO ${TABLE}
        (signal_id, source, desk, ticker, direction, vehicle, published_at,
         thesis, ref_id, entry_price, target_price, stop_price, breakeven,
         expiry_ts, horizon_days, payload_json, status, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'open', ?17)
    `).bind(
      String(sig.signal_id),
      String(sig.source),
      sig.desk != null ? String(sig.desk) : null,
      String(sig.ticker).toUpperCase(),
      sig.direction != null ? String(sig.direction).toUpperCase() : null,
      sig.vehicle != null ? String(sig.vehicle) : null,
      Number(sig.published_at) || now,
      sig.thesis != null ? String(sig.thesis).slice(0, 500) : null,
      sig.ref_id != null ? String(sig.ref_id) : null,
      Number.isFinite(Number(sig.entry_price)) ? Number(sig.entry_price) : null,
      Number.isFinite(Number(sig.target_price)) ? Number(sig.target_price) : null,
      Number.isFinite(Number(sig.stop_price)) ? Number(sig.stop_price) : null,
      Number.isFinite(Number(sig.breakeven)) ? Number(sig.breakeven) : null,
      Number.isFinite(Number(sig.expiry_ts)) ? Number(sig.expiry_ts) : null,
      Number.isFinite(Number(sig.horizon_days)) ? Number(sig.horizon_days) : null,
      sig.payload ? JSON.stringify(sig.payload).slice(0, 8000) : null,
      now,
    ).run();
    return { ok: true };
  } catch (e) {
    console.warn("[SIGNAL_OUTCOMES] recordSignal failed:", String(e?.message || e).slice(0, 200));
    return { ok: false, error_kind: "db_error" };
  }
}

/**
 * Convenience writer for a compact options play (compactOptionsPlay shape)
 * attached to an equity entry. Derives vehicle + breakeven + expiry.
 */
export function optionsPlayToSignal(play, meta = {}) {
  if (!play || typeof play !== "object") return null;
  const ticker = String(meta.ticker || play.ticker || "").toUpperCase();
  if (!ticker) return null;
  const archetype = String(play.archetype || "").toLowerCase();
  const firstOptLeg = (play.legs || []).find((l) => l?.kind === "option") || null;
  const vehicle =
    archetype.includes("spread") ? "spread"
    : archetype.includes("leap") ? "leap"
    : firstOptLeg?.type === "PUT" ? "put"
    : firstOptLeg?.type === "CALL" ? "call"
    : "option";
  let expiryTs = null;
  const expIso = play.expiration?.iso || firstOptLeg?.expiration || null;
  if (expIso) {
    // Expiry = 4 PM ET on expiration day ≈ 21:00 UTC (20:00 during DST —
    // close enough for a nightly resolver that runs at 22:00 UTC).
    const t = Date.parse(`${expIso}T21:00:00Z`);
    if (Number.isFinite(t)) expiryTs = t;
  }
  return {
    signal_id: String(meta.signal_id || `optplay:${meta.ref_id || ticker}:${meta.published_at || Date.now()}`),
    source: "options_play",
    desk: meta.desk || (String(play.mode || meta.mode || "") === "investor" ? "investor" : "swing"),
    ticker,
    direction: meta.direction || null,
    vehicle,
    published_at: Number(meta.published_at) || Date.now(),
    thesis: play.headline || play.label || null,
    ref_id: meta.ref_id || null,
    entry_price: Number(meta.underlying_price) || null,
    target_price: Number(meta.target_price) || null,
    stop_price: Number(meta.stop_price) || null,
    breakeven: Number(play.breakeven) || null,
    expiry_ts: expiryTs,
    // Fallback horizon when the play has no parseable expiration.
    horizon_days: expiryTs ? null : 30,
    payload: {
      archetype: play.archetype || null,
      label: play.label || null,
      net_cost_usd: play.net_cost_usd ?? null,
      net_side: play.net_side || null,
      max_loss_usd: play.max_loss_usd ?? null,
      max_gain_usd: play.max_gain_usd ?? null,
      legs: (play.legs || []).slice(0, 4),
    },
  };
}

/**
 * B3 (2026-06-11) — Map FSD tactical signals (the CRO-applied overlay shape
 * from worker/strategy-context.js / cro:tactical_overrides) into ledger
 * rows so FSD's calls get GRADED like everything else we act on.
 *
 * Pair semantics: "RSP/SPY" = a RELATIVE call (numerator vs denominator) —
 * graded on the ratio at horizon (payload.relative_to). Single symbols
 * ("MAGS") grade as absolute directional calls.
 * Direction inference from the freeform `direction` string: caution/short/
 * avoid/de-risk/trim/under(weight)/bear → SHORT the first leg; everything
 * else (favor/prefer/lean/bull/overweight) → LONG the first leg.
 */
export function fsdTacticalToSignals(signals, meta = {}) {
  const out = [];
  const publishedAt = Number(meta.publishedAt) || Date.now();
  const refId = String(meta.proposalId || meta.vintage || "incode");
  for (const sig of signals || []) {
    if (!sig || typeof sig !== "object") continue;
    const pairRaw = String(sig.pair || "").toUpperCase().trim();
    if (!pairRaw) continue;
    const legs = pairRaw.split("/").map((s) => s.trim()).filter(Boolean);
    const ticker = legs[0];
    if (!ticker || !/^[A-Z0-9.]{1,6}$/.test(ticker)) continue;
    const relativeTo = legs.length > 1 && /^[A-Z0-9.]{1,6}$/.test(legs[1]) ? legs[1] : null;

    const dirStr = String(sig.direction || "").toLowerCase();
    const bearish = /(caution|short|avoid|de-?risk|trim|under|bear|fade|reduce)/.test(dirStr);
    const direction = bearish ? "SHORT" : "LONG";

    const horizonLabel = String(sig.horizon || "").toLowerCase();
    const horizonDays =
      horizonLabel === "tactical" ? 14
      : horizonLabel === "intermediate" ? 30
      : horizonLabel === "structural" ? 60
      : 21;

    out.push({
      signal_id: `fsd:${refId}:${String(sig.signal || pairRaw).slice(0, 60)}`,
      source: "fsd_tactical",
      desk: "research",
      ticker,
      direction,
      vehicle: "thesis",
      published_at: publishedAt,
      thesis: String(sig.evidence || sig.playbook_action || sig.signal || "").slice(0, 280),
      ref_id: refId,
      horizon_days: horizonDays,
      payload: {
        signal: sig.signal || null,
        pair: pairRaw,
        relative_to: relativeTo,
        direction_raw: sig.direction || null,
        horizon_label: sig.horizon || null,
      },
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pure resolution core (pinned by tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a directional signal against daily bars.
 *
 * @param {Object} sig - { direction, entry_price, target_price, stop_price,
 *                         breakeven, published_at, due_ts, source }
 * @param {Array}  bars - daily bars { ts, h, l, c } ascending, covering
 *                        (published_at, due_ts]. Bars after due_ts ignored.
 * @returns {Object|null} { outcome, outcome_pct, grade, resolve_note,
 *                          resolved_ts } or null when no bars to judge.
 *
 * Rules (first-touch wins, judged on bar high/low):
 *   target hit before stop  → win  (grade A)
 *   stop hit before target  → loss (grade F)
 *   neither by due date:
 *     options (breakeven set): beyond breakeven in direction at due close
 *       → win (B, "expired beyond breakeven"); else loss (D, premium decay).
 *     directional: final move >= +1% in direction → win (B);
 *                  <= -1% against → loss (D); else flat (C).
 */
export function classifyDirectionalOutcome(sig, bars) {
  const dir = String(sig?.direction || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const entry = Number(sig?.entry_price) || 0;
  const target = Number(sig?.target_price) || 0;
  const stop = Number(sig?.stop_price) || 0;
  const breakeven = Number(sig?.breakeven) || 0;
  const publishedAt = Number(sig?.published_at) || 0;
  const dueTs = Number(sig?.due_ts) || 0;

  const judged = (bars || []).filter(
    (b) => Number(b?.ts) > publishedAt && (!dueTs || Number(b?.ts) <= dueTs),
  );
  if (judged.length === 0 || !(entry > 0)) return null;

  const sgn = dir === "LONG" ? 1 : -1;
  const movePct = (px) => ((Number(px) - entry) / entry) * 100 * sgn;

  for (const b of judged) {
    const hi = Number(b.h);
    const lo = Number(b.l);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    const hitTarget = target > 0 && (dir === "LONG" ? hi >= target : lo <= target);
    const hitStop = stop > 0 && (dir === "LONG" ? lo <= stop : hi >= stop);
    if (hitTarget && hitStop) {
      // Same bar touched both — unknowable intrabar order from D candles.
      // Be conservative: count it as a stop (the loss case).
      return {
        outcome: "loss", grade: "F",
        outcome_pct: movePct(stop),
        resolve_note: "target_and_stop_same_bar_conservative_stop",
        resolved_ts: Number(b.ts),
      };
    }
    if (hitTarget) {
      return {
        outcome: "win", grade: "A",
        outcome_pct: movePct(target),
        resolve_note: "target_hit",
        resolved_ts: Number(b.ts),
      };
    }
    if (hitStop) {
      return {
        outcome: "loss", grade: "F",
        outcome_pct: movePct(stop),
        resolve_note: "stop_hit",
        resolved_ts: Number(b.ts),
      };
    }
  }

  // Horizon reached without target/stop — judge the final close.
  const last = judged[judged.length - 1];
  const finalPct = movePct(last.c);
  if (!Number.isFinite(finalPct)) return null;

  if (breakeven > 0) {
    // Options underlying-proxy: did the underlying clear breakeven?
    const cleared = dir === "LONG" ? Number(last.c) > breakeven : Number(last.c) < breakeven;
    return cleared
      ? { outcome: "win", grade: "B", outcome_pct: finalPct, resolve_note: "expired_beyond_breakeven_underlying_proxy", resolved_ts: Number(last.ts) }
      : { outcome: "loss", grade: "D", outcome_pct: finalPct, resolve_note: "expired_inside_breakeven_underlying_proxy", resolved_ts: Number(last.ts) };
  }

  if (finalPct >= 1) {
    return { outcome: "win", grade: "B", outcome_pct: finalPct, resolve_note: "horizon_direction_right", resolved_ts: Number(last.ts) };
  }
  if (finalPct <= -1) {
    return { outcome: "loss", grade: "D", outcome_pct: finalPct, resolve_note: "horizon_direction_wrong", resolved_ts: Number(last.ts) };
  }
  return { outcome: "flat", grade: "C", outcome_pct: finalPct, resolve_note: "horizon_flat", resolved_ts: Number(last.ts) };
}

/**
 * B3 — classify a RELATIVE call (ticker vs reference, e.g. RSP/SPY) at
 * horizon. Judged on the close-ratio change from the first judged bar pair
 * to the due-date pair; ±1% bands like absolute horizon verdicts. No
 * target/stop touch logic — relative calls are horizon theses.
 */
export function classifyRelativeOutcome(sig, bars, refBars) {
  const dir = String(sig?.direction || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const publishedAt = Number(sig?.published_at) || 0;
  const dueTs = Number(sig?.due_ts) || 0;
  const inWindow = (b) => Number(b?.ts) > publishedAt && (!dueTs || Number(b?.ts) <= dueTs);

  const a = (bars || []).filter(inWindow);
  const refByTs = new Map((refBars || []).filter(inWindow).map((b) => [Number(b.ts), Number(b.c)]));
  // Align by exact bar ts (daily bars share timestamps).
  const aligned = a
    .map((b) => ({ ts: Number(b.ts), ratio: refByTs.has(Number(b.ts)) ? Number(b.c) / refByTs.get(Number(b.ts)) : null }))
    .filter((r) => Number.isFinite(r.ratio) && r.ratio > 0);
  if (aligned.length < 2) return null;

  const first = aligned[0];
  const last = aligned[aligned.length - 1];
  const sgn = dir === "LONG" ? 1 : -1;
  const ratioPct = ((last.ratio - first.ratio) / first.ratio) * 100 * sgn;
  if (!Number.isFinite(ratioPct)) return null;

  if (ratioPct >= 1) {
    return { outcome: "win", grade: "B", outcome_pct: ratioPct, resolve_note: "relative_horizon_right", resolved_ts: last.ts };
  }
  if (ratioPct <= -1) {
    return { outcome: "loss", grade: "D", outcome_pct: ratioPct, resolve_note: "relative_horizon_wrong", resolved_ts: last.ts };
  }
  return { outcome: "flat", grade: "C", outcome_pct: ratioPct, resolve_note: "relative_horizon_flat", resolved_ts: last.ts };
}

/** Due predicate: a signal is resolvable when its horizon has elapsed. */
export function isSignalDue(sig, nowMs = Date.now()) {
  const expiry = Number(sig?.expiry_ts) || 0;
  if (expiry > 0) return nowMs >= expiry;
  const horizonDays = Number(sig?.horizon_days) || 0;
  const publishedAt = Number(sig?.published_at) || 0;
  if (horizonDays > 0 && publishedAt > 0) return nowMs >= publishedAt + horizonDays * DAY_MS;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Nightly resolver + summary (D1 plumbing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve all due open signals against D1 daily candles. Also EARLY-resolves
 * open signals whose target/stop already got touched (first-touch), so wins
 * and losses show up the night they happen rather than at horizon end.
 * Called from the 22:00 UTC nightly chain. Budget-bounded.
 */
export async function resolveDueSignals(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error_kind: "no_db" };
  await ensureSignalOutcomesSchema(env);
  const now = Number(opts.now) || Date.now();
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 100));

  let rows = [];
  try {
    rows = (await db.prepare(
      `SELECT * FROM ${TABLE} WHERE status = 'open' ORDER BY published_at ASC LIMIT ?1`
    ).bind(limit).all())?.results || [];
  } catch (e) {
    return { ok: false, error_kind: "read_failed", hint: String(e?.message || e).slice(0, 200) };
  }
  if (rows.length === 0) return { ok: true, scanned: 0, resolved: 0 };

  let resolved = 0;
  let invalid = 0;
  const resolvedRows = []; // compact — for activity-feed grading events
  const stmts = [];
  // One candle read per distinct ticker (signals cluster on actives).
  const barsCache = new Map();
  const loadBars = async (ticker, sinceTs) => {
    const key = ticker;
    if (barsCache.has(key)) return barsCache.get(key);
    let bars = [];
    try {
      bars = (await db.prepare(
        `SELECT ts, h, l, c FROM ticker_candles
          WHERE ticker = ?1 AND tf = 'D' AND ts > ?2 AND ts <= ?3
          ORDER BY ts ASC LIMIT 400`
      ).bind(ticker, sinceTs, now + DAY_MS).all())?.results || [];
    } catch { /* missing candles → unresolvable this pass */ }
    barsCache.set(key, bars);
    return bars;
  };

  for (const row of rows) {
    const due = isSignalDue(row, now);
    const ticker = String(row.ticker || "").toUpperCase();
    const bars = await loadBars(ticker, Number(row.published_at) || 0);
    const dueTs = Number(row.expiry_ts) > 0
      ? Number(row.expiry_ts)
      : (Number(row.published_at) || 0) + (Number(row.horizon_days) || 0) * DAY_MS;

    // B3 — relative-pair calls (payload.relative_to, e.g. RSP vs SPY) are
    // horizon theses judged on the close ratio; only when due.
    let relativeTo = null;
    try {
      const payload = row.payload_json ? JSON.parse(row.payload_json) : null;
      relativeTo = payload?.relative_to ? String(payload.relative_to).toUpperCase() : null;
    } catch { /* malformed payload → treat as absolute */ }

    let verdict;
    if (relativeTo) {
      verdict = due
        ? classifyRelativeOutcome({ ...row, due_ts: dueTs }, bars, await loadBars(relativeTo, Number(row.published_at) || 0))
        : null;
    } else {
      verdict = classifyDirectionalOutcome({ ...row, due_ts: dueTs }, bars);
    }

    if (verdict) {
      // Early-resolve only on target/stop touch; horizon verdicts wait
      // until the signal is actually due.
      const isTouch = verdict.resolve_note === "target_hit"
        || verdict.resolve_note === "stop_hit"
        || verdict.resolve_note === "target_and_stop_same_bar_conservative_stop";
      if (due || isTouch) {
        stmts.push(db.prepare(
          `UPDATE ${TABLE}
              SET status = 'resolved', resolved_at = ?2, outcome = ?3,
                  outcome_pct = ?4, grade = ?5, resolve_note = ?6, updated_at = ?7
            WHERE signal_id = ?1`
        ).bind(
          row.signal_id, verdict.resolved_ts, verdict.outcome,
          Math.round(verdict.outcome_pct * 100) / 100, verdict.grade,
          verdict.resolve_note, now,
        ));
        resolved++;
        resolvedRows.push({
          signal_id: row.signal_id,
          ticker,
          source: row.source,
          desk: row.desk,
          vehicle: row.vehicle,
          direction: row.direction,
          outcome: verdict.outcome,
          grade: verdict.grade,
          outcome_pct: Math.round(verdict.outcome_pct * 100) / 100,
          resolve_note: verdict.resolve_note,
        });
      }
      continue;
    }

    if (due) {
      // Due but no bars to judge (delisted / missing candles after 7 extra
      // days of grace) → mark invalid so it doesn't poll forever.
      const graceTs = dueTs + 7 * DAY_MS;
      if (now >= graceTs) {
        stmts.push(db.prepare(
          `UPDATE ${TABLE}
              SET status = 'invalid', resolved_at = ?2, outcome = 'invalid',
                  resolve_note = 'no_candles_to_judge', updated_at = ?2
            WHERE signal_id = ?1`
        ).bind(row.signal_id, now));
        invalid++;
      }
    }
  }

  try {
    for (let i = 0; i < stmts.length; i += 100) {
      await db.batch(stmts.slice(i, i + 100));
    }
  } catch (e) {
    return { ok: false, error_kind: "write_failed", hint: String(e?.message || e).slice(0, 200), scanned: rows.length, resolved, invalid };
  }
  return { ok: true, scanned: rows.length, resolved, invalid, resolved_rows: resolvedRows };
}

/**
 * Aggregate summary for the admin endpoint / Edge Scorecard / Scrimmage Room.
 * Grouped per source + desk + vehicle over a trailing window.
 */
export async function summarizeSignalOutcomes(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error_kind: "no_db" };
  await ensureSignalOutcomesSchema(env);
  const days = Math.max(1, Math.min(365, Number(opts.days) || 90));
  const since = Date.now() - days * DAY_MS;
  try {
    const rows = (await db.prepare(
      `SELECT source, desk, vehicle,
              COUNT(*) AS n,
              SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
              SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN outcome = 'loss' THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN outcome = 'flat' THEN 1 ELSE 0 END) AS flats,
              AVG(CASE WHEN status = 'resolved' THEN outcome_pct END) AS avg_pct
         FROM ${TABLE}
        WHERE published_at >= ?1
        GROUP BY source, desk, vehicle
        ORDER BY n DESC`
    ).bind(since).all())?.results || [];
    const groups = rows.map((r) => ({
      source: r.source, desk: r.desk, vehicle: r.vehicle,
      n: Number(r.n) || 0,
      resolved: Number(r.resolved) || 0,
      open: (Number(r.n) || 0) - (Number(r.resolved) || 0),
      wins: Number(r.wins) || 0,
      losses: Number(r.losses) || 0,
      flats: Number(r.flats) || 0,
      win_rate: (Number(r.wins) + Number(r.losses)) > 0
        ? Math.round((Number(r.wins) / (Number(r.wins) + Number(r.losses))) * 1000) / 10
        : null,
      avg_pct: r.avg_pct != null ? Math.round(Number(r.avg_pct) * 100) / 100 : null,
    }));
    return { ok: true, days, groups };
  } catch (e) {
    return { ok: false, error_kind: "read_failed", hint: String(e?.message || e).slice(0, 200) };
  }
}

/** Recent rows for the admin endpoint / UI tape. */
export async function listRecentSignalOutcomes(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error_kind: "no_db", rows: [] };
  await ensureSignalOutcomesSchema(env);
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  const status = opts.status ? String(opts.status) : null;
  try {
    const sql = status
      ? `SELECT * FROM ${TABLE} WHERE status = ?2 ORDER BY published_at DESC LIMIT ?1`
      : `SELECT * FROM ${TABLE} ORDER BY published_at DESC LIMIT ?1`;
    const stmt = status ? env.DB.prepare(sql).bind(limit, status) : env.DB.prepare(sql).bind(limit);
    const rows = (await stmt.all())?.results || [];
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error_kind: "read_failed", hint: String(e?.message || e).slice(0, 200), rows: [] };
  }
}
