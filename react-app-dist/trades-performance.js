/**
 * Trades Performance Overview Component
 *
 * Per user request (2026-04-30):
 *   "Trades Page needs a Monthly Performance Overview, showing how the system did,
 *    what setups worked, biggest winners, biggest losers"
 *   "Day by Day P&L Calendar that shows how much realized P&L the system locked in"
 *
 * V15 P0.7.71 (2026-05-06): math + design overhaul per user feedback
 *   - Total PnL %: was sum(pnl_pct) which produced absurd 429% on 587 trades.
 *     Now uses portfolio return: sumPnlUsd / startCash * 100. (Matches the
 *     +40.09% on the equity curve.)
 *   - Setup Breakdown PnL %: same fix — now portfolio-return-attributed.
 *   - Setup names: strip the "TT Tt " double prefix produced by "TT " prefix
 *     on already-display-friendly names.
 *   - PnL Calendar: now an actual 90-day, month-grouped 3-column layout with
 *     realized $ visible in each day cell, not a tiny GitHub-style heatmap.
 *   - Style aligned to ds-card / ds-glass / ds-metric tokens for visual
 *     consistency with the rest of the Trades page.
 *
 * Self-contained component that can be rendered into any container on the Trades
 * page (simulation-dashboard.html). Reads from /timed/trades and aggregates client-side.
 *
 * Usage:
 *   const TradesPerformance = window.TradesPerformanceFactory({ React, API_BASE });
 *   ReactDOM.render(<TradesPerformance trades={...} loading={false} accountStartCash={100000} />, container);
 */
(function () {
  window.TradesPerformanceFactory = function (deps) {
    const React = deps.React;
    const { useMemo } = React;
    const API_BASE = deps.API_BASE || "";

    // ── Helpers ──────────────────────────────────────────────────────
    const fmtPnl = (v) => {
      if (!Number.isFinite(v)) return "—";
      const sign = v >= 0 ? "+" : "";
      return `${sign}${v.toFixed(2)}%`;
    };
    const fmtUsd = (v) => {
      if (!Number.isFinite(v)) return "—";
      const sign = v >= 0 ? "+" : "−";
      return `${sign}$${Math.abs(v).toFixed(0)}`;
    };
    const fmtUsdShort = (v) => {
      if (!Number.isFinite(v) || v === 0) return "";
      const sign = v >= 0 ? "+" : "−";
      const abs = Math.abs(v);
      if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
      return `${sign}$${abs.toFixed(0)}`;
    };
    const monthKey = (ts) => {
      const d = new Date(Number(ts));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    const monthLabel = (key) => {
      const [y, m] = key.split("-");
      const d = new Date(Number(y), Number(m) - 1, 1);
      return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    };
    const dayKey = (ts) => {
      const d = new Date(Number(ts));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    };

    // Pretty setup name. Engine emits things like "TT Tt Gap Reversal Long"
    // (where the first "TT " is a brand prefix and "Tt " is the legacy
    // Tt_ engine namespace). Strip both, then title-case.
    function prettySetupName(name) {
      if (!name) return "Unknown";
      let s = String(name);
      // Strip leading "TT " (brand) once
      s = s.replace(/^TT\s+/i, "");
      // Strip leading "Tt " or "tt_" (engine namespace) once
      s = s.replace(/^Tt[\s_]/i, "");
      s = s.replace(/^tt_/i, "");
      // Strip the "Tt" between brand and setup ("Gap Reversal Long" already)
      s = s.replace(/_/g, " ").trim();
      // Title-case any remaining words
      s = s.replace(/\b\w/g, c => c.toUpperCase());
      return s || "Unknown";
    }

    /* V15 P0.7.109 (2026-05-08) — realized PnL from trims on still-open
       trades. The Performance Overview / Calendar / Monthly tables used
       to count ONLY closed trades (status WIN/LOSS/FLAT), so the moment
       a position got partially trimmed (status TP_HIT_TRIM) the realized
       portion of that trim was invisible here even though it WAS in the
       account_ledger and showed up in the top widget's totalRealized.
       That was the source of the user-reported gap between the headline
       "Total PnL $" widget ($40,057.85) and the calendar sum ($39,834.65)
       — exactly the SNDK trim's -$28.59 realized.

       Helper computes the realized $ from a TP_HIT_TRIM trade:
         shares_trimmed = shares * trimmed_pct
         realized = sign * (trim_price - entry_price) * shares_trimmed
       Returns { realized, ts } so the caller can bucket on trim_ts. */
    function realizedFromTrim(t) {
      const status = String(t?.status || "").toUpperCase();
      if (status !== "TP_HIT_TRIM") return null;
      const trimmedPct = Number(t?.trimmed_pct ?? t?.trimmedPct) || 0;
      if (trimmedPct <= 0) return null;
      const shares = Number(t?.shares) || 0;
      const entry = Number(t?.entry_price ?? t?.entryPrice) || 0;
      const trim = Number(t?.trim_price ?? t?.trimPrice) || 0;
      const trimTs = Number(t?.trim_ts ?? t?.trimTs);
      if (shares <= 0 || entry <= 0 || trim <= 0 || !Number.isFinite(trimTs) || trimTs <= 0) return null;
      const dir = String(t?.direction || "LONG").toUpperCase();
      const sign = dir === "SHORT" ? -1 : 1;
      const realized = sign * (trim - entry) * (shares * trimmedPct);
      return { realized, ts: trimTs };
    }

    // Aggregate trades by month
    function aggregateMonthly(trades) {
      const byMonth = new Map();
      const ensureSlot = (k) => {
        let slot = byMonth.get(k);
        if (!slot) {
          slot = { key: k, n: 0, wins: 0, losses: 0, flats: 0, trims: 0, pnlUsd: 0,
                   bestPnlUsd: -Infinity, bestTicker: null, bestPnlPct: 0,
                   worstPnlUsd: Infinity, worstTicker: null, worstPnlPct: 0,
                   setups: new Map() };
          byMonth.set(k, slot);
        }
        return slot;
      };
      for (const t of trades) {
        const status = String(t?.status || "").toUpperCase();
        // Closed trades — credit on exit day
        if (status === "WIN" || status === "LOSS" || status === "FLAT") {
          const exitTs = Number(t?.exit_ts || t?.exitTs);
          if (!Number.isFinite(exitTs) || exitTs <= 0) continue;
          const slot = ensureSlot(monthKey(exitTs));
          slot.n++;
          const pnlPct = Number(t?.pnl_pct ?? t?.pnlPct) || 0;
          const pnl = Number(t?.pnl) || 0;
          slot.pnlUsd += pnl;
          if (status === "WIN") slot.wins++;
          else if (status === "LOSS") slot.losses++;
          else slot.flats++;
          if (pnl > slot.bestPnlUsd) { slot.bestPnlUsd = pnl; slot.bestTicker = t?.ticker; slot.bestPnlPct = pnlPct; }
          if (pnl < slot.worstPnlUsd) { slot.worstPnlUsd = pnl; slot.worstTicker = t?.ticker; slot.worstPnlPct = pnlPct; }
          const setupKey = String(t?.setup_name || t?.entry_path || "unknown");
          const setupSlot = slot.setups.get(setupKey) || { n: 0, wins: 0, pnlUsd: 0 };
          setupSlot.n++;
          if (status === "WIN") setupSlot.wins++;
          setupSlot.pnlUsd += pnl;
          slot.setups.set(setupKey, setupSlot);
          continue;
        }
        // Open + trimmed — credit realized portion on trim day
        const tr = realizedFromTrim(t);
        if (tr) {
          const slot = ensureSlot(monthKey(tr.ts));
          slot.trims++;
          slot.pnlUsd += tr.realized;
        }
      }
      return [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));
    }

    // Aggregate trades by day (for calendar)
    function aggregateDaily(trades) {
      const byDay = new Map();
      const ensureSlot = (k) => {
        let slot = byDay.get(k);
        if (!slot) {
          slot = { key: k, n: 0, wins: 0, losses: 0, trims: 0, pnlUsd: 0 };
          byDay.set(k, slot);
        }
        return slot;
      };
      for (const t of trades) {
        const status = String(t?.status || "").toUpperCase();
        if (status === "WIN" || status === "LOSS" || status === "FLAT") {
          const exitTs = Number(t?.exit_ts || t?.exitTs);
          if (!Number.isFinite(exitTs) || exitTs <= 0) continue;
          const slot = ensureSlot(dayKey(exitTs));
          slot.n++;
          slot.pnlUsd += Number(t?.pnl) || 0;
          if (status === "WIN") slot.wins++;
          else if (status === "LOSS") slot.losses++;
          continue;
        }
        const tr = realizedFromTrim(t);
        if (tr) {
          const slot = ensureSlot(dayKey(tr.ts));
          slot.trims++;
          slot.pnlUsd += tr.realized;
        }
      }
      return byDay;
    }

    function MonthlyPerformanceTable({ months, startCash }) {
      if (!months.length) {
        return React.createElement("div", { className: "text-[12px] text-[#6E867D] py-4" }, "No closed trades yet.");
      }
      return React.createElement("div", { className: "overflow-x-auto" },
        React.createElement("table", { className: "w-full text-[12px] tabular-nums" },
          React.createElement("thead", { className: "border-b border-white/[0.08]" },
            React.createElement("tr", { className: "text-left text-[10px] uppercase tracking-wide text-[#6E867D]" },
              React.createElement("th", { className: "py-2 pr-3 font-semibold" }, "Month"),
              React.createElement("th", { className: "py-2 pr-3 font-semibold text-right" }, "Trades"),
              React.createElement("th", { className: "py-2 pr-3 font-semibold text-right" }, "WR"),
              React.createElement("th", { className: "py-2 pr-3 font-semibold text-right" }, "PnL %"),
              React.createElement("th", { className: "py-2 pr-3 font-semibold text-right" }, "PnL $"),
              React.createElement("th", { className: "py-2 pr-3 font-semibold" }, "Best"),
              React.createElement("th", { className: "py-2 font-semibold" }, "Worst")
            )
          ),
          React.createElement("tbody", null,
            months.map((m) => {
              const wr = m.n > 0 ? (m.wins / m.n) * 100 : 0;
              // V15 P0.7.71: monthly PnL % is the portfolio return for that
              // month — pnlUsd / startCash * 100 — not the sum of per-trade
              // pct returns (which double-counts because each trade is sized
              // as a fraction of the portfolio).
              const pnlPct = startCash > 0 ? (m.pnlUsd / startCash) * 100 : 0;
              const pnlCls = pnlPct > 0 ? "text-emerald-400" : pnlPct < 0 ? "text-rose-400" : "text-[#8AA39A]";
              const wrCls = wr >= 65 ? "text-emerald-400" : wr >= 50 ? "text-sky-400" : "text-amber-400";
              return React.createElement("tr", { key: m.key, className: "border-b border-white/[0.04] hover:bg-white/[0.02]" },
                React.createElement("td", { className: "py-2 pr-3 font-medium text-white" }, monthLabel(m.key)),
                React.createElement("td", { className: "py-2 pr-3 text-right text-[#8AA39A]" }, m.n),
                React.createElement("td", { className: `py-2 pr-3 text-right font-semibold ${wrCls}` }, `${wr.toFixed(0)}%`),
                React.createElement("td", { className: `py-2 pr-3 text-right font-semibold ${pnlCls}` }, fmtPnl(pnlPct)),
                React.createElement("td", { className: `py-2 pr-3 text-right ${pnlCls}` }, fmtUsd(m.pnlUsd)),
                React.createElement("td", { className: "py-2 pr-3 text-emerald-400/90" },
                  m.bestTicker ? `${m.bestTicker} ${fmtPnl(m.bestPnlPct)}` : "—"),
                React.createElement("td", { className: "py-2 text-rose-400/90" },
                  m.worstTicker ? `${m.worstTicker} ${fmtPnl(m.worstPnlPct)}` : "—")
              );
            })
          )
        )
      );
    }

    function SetupBreakdown({ months, startCash }) {
      // Roll all months into one setup table — aggregate USD then convert to %
      const setupTotals = new Map();
      for (const m of months) {
        for (const [k, s] of m.setups.entries()) {
          const t = setupTotals.get(k) || { name: k, n: 0, wins: 0, pnlUsd: 0 };
          t.n += s.n;
          t.wins += s.wins;
          t.pnlUsd += s.pnlUsd;
          setupTotals.set(k, t);
        }
      }
      const setups = [...setupTotals.values()]
        .filter(s => s.n >= 2)
        .sort((a, b) => b.pnlUsd - a.pnlUsd);
      if (!setups.length) return null;
      return React.createElement("div", { className: "mt-4" },
        React.createElement("h3", { className: "text-[10px] uppercase tracking-wider text-[#6E867D] font-semibold mb-2" }, "Setup Breakdown"),
        React.createElement("table", { className: "w-full text-[12px] tabular-nums" },
          React.createElement("thead", { className: "border-b border-white/[0.06]" },
            React.createElement("tr", { className: "text-left text-[10px] text-[#6E867D]" },
              React.createElement("th", { className: "py-1.5 pr-3 font-semibold" }, "Setup"),
              React.createElement("th", { className: "py-1.5 pr-3 font-semibold text-right" }, "Trades"),
              React.createElement("th", { className: "py-1.5 pr-3 font-semibold text-right" }, "WR"),
              React.createElement("th", { className: "py-1.5 pr-3 font-semibold text-right" }, "PnL %"),
              React.createElement("th", { className: "py-1.5 font-semibold text-right" }, "PnL $")
            )
          ),
          React.createElement("tbody", null,
            setups.map((s) => {
              const wr = s.n > 0 ? (s.wins / s.n) * 100 : 0;
              const pnlPct = startCash > 0 ? (s.pnlUsd / startCash) * 100 : 0;
              const pnlCls = pnlPct > 0 ? "text-emerald-400" : pnlPct < 0 ? "text-rose-400" : "text-[#8AA39A]";
              const wrCls = wr >= 65 ? "text-emerald-400" : wr >= 50 ? "text-sky-400" : "text-amber-400";
              return React.createElement("tr", { key: s.name, className: "border-b border-white/[0.03]" },
                React.createElement("td", { className: "py-1.5 pr-3 text-white" }, prettySetupName(s.name)),
                React.createElement("td", { className: "py-1.5 pr-3 text-right text-[#8AA39A]" }, s.n),
                React.createElement("td", { className: `py-1.5 pr-3 text-right font-semibold ${wrCls}` }, `${wr.toFixed(0)}%`),
                React.createElement("td", { className: `py-1.5 pr-3 text-right font-semibold ${pnlCls}` }, fmtPnl(pnlPct)),
                React.createElement("td", { className: `py-1.5 text-right ${pnlCls}` }, fmtUsd(s.pnlUsd))
              );
            })
          )
        )
      );
    }

    /**
     * V15 P0.7.71: real 3-month calendar view.
     *
     * Replaces the GitHub-style heatmap (tiny 12px cells with no dollar
     * amounts visible) with an actual 3-month-by-3-month grid. Each cell
     * shows the day number + realized $ amount when there were trades.
     * Background tint encodes magnitude (green = win, red = loss). Weekends
     * stay muted but visible for orientation.
     */
    function PnlCalendar({ trades }) {
      // Build day map for the last ~93 days (covers 3 calendar months)
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const byDay = aggregateDaily(trades);

      // Compute the 3 calendar months ending today: [today-2mo, today-1mo, today]
      const monthsToShow = [];
      const baseY = today.getUTCFullYear();
      const baseM = today.getUTCMonth();
      for (let off = 2; off >= 0; off--) {
        const dt = new Date(Date.UTC(baseY, baseM - off, 1));
        monthsToShow.push({ year: dt.getUTCFullYear(), month: dt.getUTCMonth() });
      }

      // Find max abs $ across the visible window to scale color intensity
      let maxAbs = 0;
      for (const m of monthsToShow) {
        const daysInMonth = new Date(Date.UTC(m.year, m.month + 1, 0)).getUTCDate();
        for (let d = 1; d <= daysInMonth; d++) {
          const k = `${m.year}-${String(m.month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const slot = byDay.get(k);
          if (slot && Math.abs(slot.pnlUsd) > maxAbs) maxAbs = Math.abs(slot.pnlUsd);
        }
      }

      const cellBg = (pnlUsd) => {
        if (!Number.isFinite(pnlUsd) || pnlUsd === 0 || maxAbs === 0) return "rgba(255,255,255,0.02)";
        const intensity = Math.min(1, Math.abs(pnlUsd) / maxAbs);
        const alpha = 0.10 + intensity * 0.45;
        const rgb = pnlUsd >= 0 ? "34,197,94" : "239,68,68";
        return `rgba(${rgb},${alpha.toFixed(2)})`;
      };

      const dayLabels = ["S", "M", "T", "W", "T", "F", "S"];

      // Aggregate window totals
      let totalDays = 0, greenDays = 0, redDays = 0, totalPnlUsd = 0;
      for (const m of monthsToShow) {
        const daysInMonth = new Date(Date.UTC(m.year, m.month + 1, 0)).getUTCDate();
        for (let d = 1; d <= daysInMonth; d++) {
          const k = `${m.year}-${String(m.month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const slot = byDay.get(k);
          if (!slot || slot.n === 0) continue;
          totalDays++;
          totalPnlUsd += slot.pnlUsd;
          if (slot.pnlUsd > 0) greenDays++;
          else if (slot.pnlUsd < 0) redDays++;
        }
      }

      function MonthGrid({ year, month }) {
        const firstOfMonth = new Date(Date.UTC(year, month, 1));
        const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        const firstDow = firstOfMonth.getUTCDay();
        const cells = [];
        for (let i = 0; i < firstDow; i++) cells.push(null); // pad
        for (let d = 1; d <= daysInMonth; d++) {
          const k = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const slot = byDay.get(k);
          const dow = (firstDow + d - 1) % 7;
          const isWeekend = dow === 0 || dow === 6;
          cells.push({ day: d, k, slot, isWeekend });
        }
        const monthName = firstOfMonth.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
        return React.createElement("div", { className: "flex-1" },
          React.createElement("div", {
            className: "text-[11px] font-semibold text-white mb-1.5 px-1",
          }, monthName),
          // Day-of-week header
          React.createElement("div", {
            style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "2px", marginBottom: "4px" },
          },
            dayLabels.map((lbl, i) => React.createElement("div", {
              key: i,
              className: "text-[9px] text-[#6E867D] uppercase tracking-wider text-center font-semibold py-0.5",
            }, lbl))
          ),
          // Day cells
          React.createElement("div", {
            style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "2px" },
          },
            cells.map((c, i) => {
              if (!c) return React.createElement("div", { key: i, style: { minHeight: "44px" } });
              const pnl = c.slot?.pnlUsd || 0;
              const n = c.slot?.n || 0;
              const w = c.slot?.wins || 0;
              const l = c.slot?.losses || 0;
              const tip = n > 0
                ? `${c.k}: ${n} trade${n !== 1 ? 's' : ''} · ${w}W/${l}L · ${fmtUsd(pnl)}`
                : `${c.k}: no trades`;
              return React.createElement("div", {
                key: i,
                title: tip,
                className: "rounded-md border border-white/[0.04] flex flex-col items-start justify-between p-1.5 transition-colors hover:border-white/[0.12]",
                style: {
                  background: c.slot ? cellBg(pnl) : (c.isWeekend ? "rgba(255,255,255,0.015)" : "rgba(255,255,255,0.025)"),
                  minHeight: "44px",
                },
              },
                React.createElement("div", {
                  className: `text-[10px] font-semibold tabular-nums ${c.isWeekend && !c.slot ? "text-[#51635A]" : "text-[#CFDED6]"}`,
                }, c.day),
                n > 0
                  ? React.createElement("div", {
                      className: `text-[9.5px] font-bold tabular-nums leading-none ${pnl > 0 ? "text-emerald-300" : pnl < 0 ? "text-rose-300" : "text-[#8AA39A]"}`,
                    }, fmtUsdShort(pnl))
                  : null
              );
            })
          )
        );
      }

      return React.createElement("div", null,
        React.createElement("div", { className: "ds-glass__head", style: { marginBottom: "var(--ds-space-3)" } },
          React.createElement("div", { className: "ds-glass__title" }, "P&L Calendar — last 3 months"),
          React.createElement("div", {
            style: { fontSize: "var(--ds-fs-meta)", color: "var(--ds-text-muted)", fontFamily: "var(--tt-font-mono)", display: "flex", gap: "var(--ds-space-2)", alignItems: "center" },
          },
            React.createElement("span", null, `${totalDays} active`),
            React.createElement("span", { className: "ds-chip ds-chip--up ds-chip--sm" }, `${greenDays} green`),
            React.createElement("span", { className: "ds-chip ds-chip--dn ds-chip--sm" }, `${redDays} red`),
            React.createElement("span", {
              className: `ds-chip ds-chip--sm ${totalPnlUsd >= 0 ? "ds-chip--up" : "ds-chip--dn"}`,
            }, fmtUsd(totalPnlUsd))
          )
        ),
        // 3-up grid: each month is its own column on desktop, stacks on mobile
        React.createElement("div", {
          className: "grid grid-cols-1 md:grid-cols-3 gap-4",
        },
          monthsToShow.map((m, i) => React.createElement(MonthGrid, { key: i, year: m.year, month: m.month }))
        )
      );
    }

    /* P0.7.122 — Normalize investor lots into trader-shape so the
       existing aggregators (which key off status WIN/LOSS/FLAT and
       exit_ts) work without forking the aggregation code. Each
       investor SELL becomes a synthetic closed-trade row with:
         status = WIN if pnl > 0 else (LOSS if pnl < 0 else FLAT)
         exit_ts = entry_ts (the SELL timestamp)
       BUY rows are dropped (entries don't realize PnL on their own). */
    function normalizeInvestorTrades(trades) {
      const out = [];
      for (const t of trades || []) {
        const act = String(t?.action || "").toUpperCase();
        if (act === "BUY") continue;
        if (act !== "SELL") {
          out.push(t);
          continue;
        }
        const pnl = Number(t?.pnl) || 0;
        const status = pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "FLAT";
        const sellTs = Number(t?.entry_ts || t?.ts || 0);
        out.push({
          ...t,
          status,
          exit_ts: sellTs,
          exit_price: Number(t?.entry_price) || undefined,
          setup_name: t?.setup_name || t?.entry_path || (t?.reason ? `Investor: ${t.reason}` : "Investor Hold"),
        });
      }
      return out;
    }

    /* P0.7.128 — exposed as a static helper so the parent can compute
       the same headline summary numbers without re-implementing
       `realizedFromTrim` / `normalizeInvestorTrades` logic. Used by
       the new CombinedPerformanceOverview tab strip in
       simulation-dashboard.html so the trader / investor segment
       buttons share the SAME numbers the detail panel will show. */
    function computeSummary(trades, { mode, accountStartCash } = {}) {
      const startCash = Number.isFinite(Number(accountStartCash)) && Number(accountStartCash) > 0
        ? Number(accountStartCash)
        : 100000;
      const isInvestor = String(mode || "").toLowerCase() === "investor";
      const normalized = isInvestor ? normalizeInvestorTrades(trades || []) : (trades || []);
      const closed = normalized.filter(t => {
        const s = String(t?.status || "").toUpperCase();
        return s === "WIN" || s === "LOSS" || s === "FLAT";
      });
      const totalWins = closed.filter(t => String(t?.status || "").toUpperCase() === "WIN").length;
      const totalLosses = closed.filter(t => String(t?.status || "").toUpperCase() === "LOSS").length;
      const closedPnlUsd = closed.reduce((s, t) => s + (Number(t?.pnl) || 0), 0);
      const trimPnlUsd = isInvestor ? 0 : normalized.reduce((s, t) => {
        const tr = realizedFromTrim(t);
        return s + (tr ? tr.realized : 0);
      }, 0);
      const totalPnlUsd = closedPnlUsd + trimPnlUsd;
      const totalPnlPct = startCash > 0 ? (totalPnlUsd / startCash) * 100 : 0;
      const decisive = totalWins + totalLosses;
      const overallWr = decisive > 0 ? (totalWins / decisive) * 100 : 0;
      return {
        startCash,
        closedCount: closed.length,
        wins: totalWins,
        losses: totalLosses,
        totalPnlUsd,
        totalPnlPct,
        winRatePct: overallWr,
      };
    }

    // Main component
    function TradesPerformance({ trades, loading, accountStartCash, mode, hideHeadline }) {
      const startCash = Number.isFinite(Number(accountStartCash)) && Number(accountStartCash) > 0
        ? Number(accountStartCash)
        : 100000;
      const isInvestor = String(mode || "").toLowerCase() === "investor";
      const normalized = useMemo(
        () => isInvestor ? normalizeInvestorTrades(trades || []) : (trades || []),
        [trades, isInvestor]
      );
      const months = useMemo(() => aggregateMonthly(normalized), [normalized]);

      if (loading) {
        return React.createElement("div", { className: "text-[12px] text-[#6E867D] py-4" }, "Loading performance data…");
      }
      if (!normalized || normalized.length === 0) {
        return React.createElement("div", { className: "text-[12px] text-[#6E867D] py-4" },
          isInvestor ? "No investor lots yet." : "No trades yet.");
      }

      // Compute overall summary (same logic as computeSummary above; kept
      // inline so the body section can color/label per local thresholds).
      const closed = normalized.filter(t => {
        const s = String(t?.status || "").toUpperCase();
        return s === "WIN" || s === "LOSS" || s === "FLAT";
      });
      const totalWins = closed.filter(t => String(t?.status || "").toUpperCase() === "WIN").length;
      const totalLosses = closed.filter(t => String(t?.status || "").toUpperCase() === "LOSS").length;
      // V15 P0.7.109 (2026-05-08): include realized PnL from trims on still-
      // open trades (TP_HIT_TRIM). Without this, the headline Total PnL $
      // disagrees with the account-summary widget by exactly the trim's
      // realized portion. See realizedFromTrim() comment for the SNDK case.
      const closedPnlUsd = closed.reduce((s, t) => s + (Number(t?.pnl) || 0), 0);
      // Trim-realized only applies to trader trades (TP_HIT_TRIM status);
      // investor lots realize entirely on SELL.
      const trimPnlUsd = isInvestor ? 0 : normalized.reduce((s, t) => {
        const tr = realizedFromTrim(t);
        return s + (tr ? tr.realized : 0);
      }, 0);
      const totalPnlUsd = closedPnlUsd + trimPnlUsd;
      // V15 P0.7.71: Total PnL % is portfolio return — sumPnlUsd / startCash *
      // 100 — not sum of per-trade %s (which over-counts because each trade
      // is a fraction of the account).
      const totalPnlPct = startCash > 0 ? (totalPnlUsd / startCash) * 100 : 0;
      // Win rate is a true ratio (excludes flats from the denominator)
      const decisive = totalWins + totalLosses;
      const overallWr = decisive > 0 ? (totalWins / decisive) * 100 : 0;

      const wrDelta = overallWr >= 65 ? "Strong" : overallWr >= 50 ? "OK" : "Low";
      const wrDeltaClass = overallWr >= 65 ? "up" : overallWr >= 50 ? "accent" : "dn";
      const pnlDeltaClass = totalPnlPct >= 0 ? "up" : "dn";

      /* P0.7.128 — `hideHeadline` lets the parent skip the top-line
         ds-metric grid (Closed/WR/PnL%/PnL$) when those numbers are
         already shown elsewhere — e.g. in the new dual-tab segment
         selector that drives the mode switch. Calendar + Monthly +
         Setup sections still render below. */
      const headline = hideHeadline ? null : React.createElement("div", { className: "ds-card",
        style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--ds-space-3)" }
      },
        React.createElement("div", { className: "ds-metric" },
          React.createElement("div", { className: "ds-metric__label" }, "Closed Trades"),
          React.createElement("div", { className: "ds-metric__row" },
            React.createElement("div", { className: "ds-metric__value" }, closed.length)
          )
        ),
        React.createElement("div", { className: "ds-metric" },
          React.createElement("div", { className: "ds-metric__label" }, "Win Rate"),
          React.createElement("div", { className: "ds-metric__row" },
            React.createElement("div", { className: "ds-metric__value" }, `${overallWr.toFixed(1)}%`),
            React.createElement("div", { className: `ds-metric__delta ds-metric__delta--${wrDeltaClass}` }, wrDelta)
          )
        ),
        React.createElement("div", { className: "ds-metric" },
          React.createElement("div", { className: "ds-metric__label" }, "Total PnL %"),
          React.createElement("div", { className: "ds-metric__row" },
            React.createElement("div", {
              className: "ds-metric__value",
              style: { color: totalPnlPct >= 0 ? "var(--ds-up)" : "var(--ds-dn)" },
            }, fmtPnl(totalPnlPct))
          )
        ),
        React.createElement("div", { className: "ds-metric" },
          React.createElement("div", { className: "ds-metric__label" }, "Total PnL $"),
          React.createElement("div", { className: "ds-metric__row" },
            React.createElement("div", {
              className: "ds-metric__value",
              style: { color: totalPnlUsd >= 0 ? "var(--ds-up)" : "var(--ds-dn)" },
            }, fmtUsd(totalPnlUsd))
          )
        )
      );

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "var(--ds-space-5)" } },
        headline,
        // P&L Calendar FIRST (per user reorder V15 P0.7.81 — Calendar
        // before Monthly Performance for at-a-glance day-by-day rhythm).
        React.createElement("div", { className: "ds-glass" },
          React.createElement(PnlCalendar, { trades: normalized })
        ),
        // Monthly performance + setup breakdown — single ds-glass panel
        React.createElement("div", { className: "ds-glass" },
          React.createElement("div", { className: "ds-glass__head" },
            React.createElement("div", { className: "ds-glass__title" }, "Monthly Performance")
          ),
          React.createElement(MonthlyPerformanceTable, { months, startCash }),
          React.createElement(SetupBreakdown, { months, startCash })
        )
      );
    }

    /* P0.7.128 — Attach static helpers to the component constructor so
       the parent can compute summary numbers without re-implementing
       trim-realized math. The factory itself still returns the
       component (backward compatible with all existing callers). */
    TradesPerformance.computeSummary = computeSummary;
    TradesPerformance.normalizeInvestorTrades = normalizeInvestorTrades;
    return TradesPerformance;
  };
})();

// cache-bust:1782654301699:375125748
