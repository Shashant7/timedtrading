/**
 * Trades Performance Overview Component
 *
 * Per user request (2026-04-30):
 *   "Trades Page needs a Monthly Performance Overview, showing how the system did,
 *    what setups worked, biggest winners, biggest losers"
 *   "Day by Day P&L Calendar that shows how much realized P&L the system locked in"
 *
 * Self-contained component that can be rendered into any container on the Trades
 * page (simulation-dashboard.html). Reads from /timed/trades and aggregates client-side.
 *
 * Usage:
 *   const TradesPerformance = window.TradesPerformanceFactory({ React, API_BASE });
 *   ReactDOM.render(<TradesPerformance />, container);
 */
(function () {
  window.TradesPerformanceFactory = function (deps) {
    const React = deps.React;
    const { useState, useEffect, useMemo } = React;
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

    // Aggregate trades by month
    function aggregateMonthly(trades) {
      const byMonth = new Map();
      for (const t of trades) {
        const status = String(t?.status || "").toUpperCase();
        if (status !== "WIN" && status !== "LOSS" && status !== "FLAT") continue;
        const exitTs = Number(t?.exit_ts || t?.exitTs);
        if (!Number.isFinite(exitTs) || exitTs <= 0) continue;
        const k = monthKey(exitTs);
        let slot = byMonth.get(k);
        if (!slot) {
          slot = { key: k, n: 0, wins: 0, losses: 0, flats: 0, pnlPct: 0, pnlUsd: 0,
                   bestPct: -Infinity, bestTicker: null, worstPct: Infinity, worstTicker: null,
                   setups: new Map() };
          byMonth.set(k, slot);
        }
        slot.n++;
        const pnlPct = Number(t?.pnl_pct ?? t?.pnlPct) || 0;
        const pnl = Number(t?.pnl) || 0;
        slot.pnlPct += pnlPct;
        slot.pnlUsd += pnl;
        if (status === "WIN") slot.wins++;
        else if (status === "LOSS") slot.losses++;
        else slot.flats++;
        if (pnlPct > slot.bestPct) { slot.bestPct = pnlPct; slot.bestTicker = t?.ticker; }
        if (pnlPct < slot.worstPct) { slot.worstPct = pnlPct; slot.worstTicker = t?.ticker; }
        // Track setups
        const setupKey = String(t?.setup_name || t?.entry_path || "unknown");
        const setupSlot = slot.setups.get(setupKey) || { n: 0, wins: 0, pnlPct: 0 };
        setupSlot.n++;
        if (status === "WIN") setupSlot.wins++;
        setupSlot.pnlPct += pnlPct;
        slot.setups.set(setupKey, setupSlot);
      }
      // Sort newest first
      return [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));
    }

    // Aggregate trades by day (for calendar)
    function aggregateDaily(trades, startDate, endDate) {
      const byDay = new Map();
      for (const t of trades) {
        const status = String(t?.status || "").toUpperCase();
        if (status !== "WIN" && status !== "LOSS" && status !== "FLAT") continue;
        const exitTs = Number(t?.exit_ts || t?.exitTs);
        if (!Number.isFinite(exitTs) || exitTs <= 0) continue;
        const k = dayKey(exitTs);
        let slot = byDay.get(k);
        if (!slot) {
          slot = { key: k, n: 0, wins: 0, losses: 0, pnlPct: 0, pnlUsd: 0 };
          byDay.set(k, slot);
        }
        slot.n++;
        slot.pnlPct += Number(t?.pnl_pct ?? t?.pnlPct) || 0;
        slot.pnlUsd += Number(t?.pnl) || 0;
        if (status === "WIN") slot.wins++;
        else if (status === "LOSS") slot.losses++;
      }
      return byDay;
    }

    function MonthlyPerformanceTable({ months }) {
      if (!months.length) {
        return React.createElement("div", { className: "text-[12px] text-[#6b7280] py-4" }, "No closed trades yet.");
      }
      return React.createElement("div", { className: "overflow-x-auto" },
        React.createElement("table", { className: "w-full text-[12px] tabular-nums" },
          React.createElement("thead", { className: "border-b border-white/[0.08]" },
            React.createElement("tr", { className: "text-left text-[10px] uppercase tracking-wide text-[#6b7280]" },
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
              const pnlCls = m.pnlPct > 0 ? "text-emerald-400" : m.pnlPct < 0 ? "text-rose-400" : "text-[#9ca3af]";
              const wrCls = wr >= 65 ? "text-emerald-400" : wr >= 50 ? "text-sky-400" : "text-amber-400";
              return React.createElement("tr", { key: m.key, className: "border-b border-white/[0.04] hover:bg-white/[0.02]" },
                React.createElement("td", { className: "py-2 pr-3 font-medium text-white" }, monthLabel(m.key)),
                React.createElement("td", { className: "py-2 pr-3 text-right text-[#9ca3af]" }, m.n),
                React.createElement("td", { className: `py-2 pr-3 text-right font-semibold ${wrCls}` }, `${wr.toFixed(0)}%`),
                React.createElement("td", { className: `py-2 pr-3 text-right font-semibold ${pnlCls}` }, fmtPnl(m.pnlPct)),
                React.createElement("td", { className: `py-2 pr-3 text-right ${pnlCls}` }, fmtUsd(m.pnlUsd)),
                React.createElement("td", { className: "py-2 pr-3 text-emerald-400/90" },
                  m.bestTicker ? `${m.bestTicker} ${fmtPnl(m.bestPct)}` : "—"),
                React.createElement("td", { className: "py-2 text-rose-400/90" },
                  m.worstTicker ? `${m.worstTicker} ${fmtPnl(m.worstPct)}` : "—")
              );
            })
          )
        )
      );
    }

    function SetupBreakdown({ months }) {
      // Roll all months into one setup table
      const setupTotals = new Map();
      for (const m of months) {
        for (const [k, s] of m.setups.entries()) {
          const t = setupTotals.get(k) || { name: k, n: 0, wins: 0, pnlPct: 0 };
          t.n += s.n;
          t.wins += s.wins;
          t.pnlPct += s.pnlPct;
          setupTotals.set(k, t);
        }
      }
      const setups = [...setupTotals.values()]
        .filter(s => s.n >= 2)
        .sort((a, b) => b.pnlPct - a.pnlPct);
      if (!setups.length) return null;
      return React.createElement("div", { className: "mt-4" },
        React.createElement("h3", { className: "text-[10px] uppercase tracking-wider text-[#6b7280] font-semibold mb-2" }, "Setup Breakdown"),
        React.createElement("table", { className: "w-full text-[12px] tabular-nums" },
          React.createElement("thead", { className: "border-b border-white/[0.06]" },
            React.createElement("tr", { className: "text-left text-[10px] text-[#6b7280]" },
              React.createElement("th", { className: "py-1.5 pr-3 font-semibold" }, "Setup"),
              React.createElement("th", { className: "py-1.5 pr-3 font-semibold text-right" }, "Trades"),
              React.createElement("th", { className: "py-1.5 pr-3 font-semibold text-right" }, "WR"),
              React.createElement("th", { className: "py-1.5 font-semibold text-right" }, "Total PnL")
            )
          ),
          React.createElement("tbody", null,
            setups.map((s) => {
              const wr = s.n > 0 ? (s.wins / s.n) * 100 : 0;
              const pnlCls = s.pnlPct > 0 ? "text-emerald-400" : s.pnlPct < 0 ? "text-rose-400" : "text-[#9ca3af]";
              const wrCls = wr >= 65 ? "text-emerald-400" : wr >= 50 ? "text-sky-400" : "text-amber-400";
              // Pretty setup name (strip "tt_" prefix)
              const display = s.name.replace(/^tt_/i, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
              return React.createElement("tr", { key: s.name, className: "border-b border-white/[0.03]" },
                React.createElement("td", { className: "py-1.5 pr-3 text-white" }, display),
                React.createElement("td", { className: "py-1.5 pr-3 text-right text-[#9ca3af]" }, s.n),
                React.createElement("td", { className: `py-1.5 pr-3 text-right font-semibold ${wrCls}` }, `${wr.toFixed(0)}%`),
                React.createElement("td", { className: `py-1.5 text-right font-semibold ${pnlCls}` }, fmtPnl(s.pnlPct))
              );
            })
          )
        )
      );
    }

    function PnlCalendar({ trades, days = 90 }) {
      // Build a heatmap: last N days, each cell colored by daily PnL
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const startDate = new Date(today.getTime() - days * 86400000);
      const byDay = aggregateDaily(trades, startDate, today);

      // Build day grid
      const cells = [];
      let maxAbs = 0;
      for (let i = 0; i < days; i++) {
        const d = new Date(startDate.getTime() + i * 86400000);
        const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        const slot = byDay.get(k);
        const dow = d.getUTCDay(); // 0=Sun, 6=Sat
        const isWeekend = dow === 0 || dow === 6;
        const pnl = slot?.pnlPct || 0;
        if (Math.abs(pnl) > maxAbs) maxAbs = Math.abs(pnl);
        cells.push({ date: d, key: k, pnl, n: slot?.n || 0, wins: slot?.wins || 0, losses: slot?.losses || 0, isWeekend });
      }

      const cellColor = (cell) => {
        if (cell.isWeekend) return "rgba(255,255,255,0.02)";
        if (cell.n === 0) return "rgba(255,255,255,0.04)";
        if (maxAbs <= 0) return "rgba(255,255,255,0.06)";
        const intensity = Math.min(1, Math.abs(cell.pnl) / maxAbs);
        const alpha = 0.15 + intensity * 0.7;
        const rgb = cell.pnl >= 0 ? "34,197,94" : "239,68,68";
        return `rgba(${rgb},${alpha.toFixed(2)})`;
      };

      // Group into weeks for grid layout
      const weeks = [];
      let currentWeek = [];
      // Pad start so first week aligns to Sunday
      const firstDow = cells[0]?.date.getUTCDay() || 0;
      for (let i = 0; i < firstDow; i++) currentWeek.push(null);
      for (const c of cells) {
        currentWeek.push(c);
        if (c.date.getUTCDay() === 6) { // Saturday — close week
          weeks.push(currentWeek);
          currentWeek = [];
        }
      }
      if (currentWeek.length > 0) weeks.push(currentWeek);

      // Compute totals
      const totalDays = cells.filter(c => c.n > 0).length;
      const greenDays = cells.filter(c => c.n > 0 && c.pnl > 0).length;
      const redDays = cells.filter(c => c.n > 0 && c.pnl < 0).length;
      const totalPnl = cells.reduce((sum, c) => sum + (c.pnl || 0), 0);

      return React.createElement("div", null,
        React.createElement("div", { className: "ds-glass__head" },
          React.createElement("div", { className: "ds-glass__title" },
            `P&L Calendar — last ${days} days`),
          React.createElement("div", {
            style: { fontSize: "var(--ds-fs-meta)", color: "var(--ds-text-muted)", fontFamily: "var(--tt-font-mono)", display: "flex", gap: "var(--ds-space-2)", alignItems: "center" },
          },
            React.createElement("span", null, `${totalDays} active`),
            React.createElement("span", { className: "ds-chip ds-chip--up ds-chip--sm" }, `${greenDays} green`),
            React.createElement("span", { className: "ds-chip ds-chip--dn ds-chip--sm" }, `${redDays} red`),
            React.createElement("span", {
              className: `ds-chip ds-chip--sm ${totalPnl >= 0 ? "ds-chip--up" : "ds-chip--dn"}`,
            }, fmtPnl(totalPnl))
          )
        ),
        React.createElement("div", { className: "flex gap-1" },
          weeks.map((week, wi) => React.createElement("div", { key: wi, className: "flex flex-col gap-1" },
            week.map((c, di) => {
              if (!c) return React.createElement("div", { key: di, className: "w-3 h-3" });
              const tip = c.n > 0
                ? `${c.key}: ${c.n} trade${c.n !== 1 ? 's' : ''} · ${c.wins}W/${c.losses}L · ${fmtPnl(c.pnl)}`
                : `${c.key}: no trades`;
              return React.createElement("div", {
                key: di,
                title: tip,
                className: "w-3 h-3 rounded-sm border border-white/[0.04]",
                style: { background: cellColor(c) }
              });
            })
          ))
        ),
        // Legend
        React.createElement("div", { className: "flex items-center gap-3 mt-2 text-[10px] text-[#6b7280]" },
          React.createElement("span", null, "Less"),
          React.createElement("div", { className: "flex gap-1" },
            React.createElement("div", { className: "w-3 h-3 rounded-sm", style: { background: "rgba(239,68,68,0.65)" }}),
            React.createElement("div", { className: "w-3 h-3 rounded-sm", style: { background: "rgba(239,68,68,0.30)" }}),
            React.createElement("div", { className: "w-3 h-3 rounded-sm", style: { background: "rgba(255,255,255,0.04)" }}),
            React.createElement("div", { className: "w-3 h-3 rounded-sm", style: { background: "rgba(34,197,94,0.30)" }}),
            React.createElement("div", { className: "w-3 h-3 rounded-sm", style: { background: "rgba(34,197,94,0.65)" }})
          ),
          React.createElement("span", null, "More")
        )
      );
    }

    // Main component
    return function TradesPerformance({ trades, loading }) {
      const months = useMemo(() => aggregateMonthly(trades || []), [trades]);

      if (loading) {
        return React.createElement("div", { className: "text-[12px] text-[#6b7280] py-4" }, "Loading performance data…");
      }
      if (!trades || trades.length === 0) {
        return React.createElement("div", { className: "text-[12px] text-[#6b7280] py-4" }, "No trades yet.");
      }

      // Compute overall summary
      const closed = trades.filter(t => {
        const s = String(t?.status || "").toUpperCase();
        return s === "WIN" || s === "LOSS" || s === "FLAT";
      });
      const totalWins = closed.filter(t => String(t?.status || "").toUpperCase() === "WIN").length;
      const totalPnlPct = closed.reduce((s, t) => s + (Number(t?.pnl_pct ?? t?.pnlPct) || 0), 0);
      const totalPnlUsd = closed.reduce((s, t) => s + (Number(t?.pnl) || 0), 0);
      const overallWr = closed.length > 0 ? (totalWins / closed.length) * 100 : 0;

      /* V2 (2026-05-01) — DS metric tile pattern. Each KPI uses
         ds-metric + delta chip (semantic up/dn/accent). */
      const wrDelta = overallWr >= 65 ? "Strong" : overallWr >= 50 ? "OK" : "Low";
      const wrDeltaClass = overallWr >= 65 ? "up" : overallWr >= 50 ? "accent" : "dn";
      const pnlDeltaClass = totalPnlPct >= 0 ? "up" : "dn";

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "var(--ds-space-5)" } },
        // Top-line summary — ds-metric grid in a ds-card
        React.createElement("div", { className: "ds-card",
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
        ),

        // Monthly performance table inside ds-glass panel
        React.createElement("div", { className: "ds-glass" },
          React.createElement("div", { className: "ds-glass__head" },
            React.createElement("div", { className: "ds-glass__title" }, "Monthly Performance")
          ),
          React.createElement(MonthlyPerformanceTable, { months }),
          React.createElement(SetupBreakdown, { months })
        ),

        // P&L Calendar inside ds-glass panel
        React.createElement("div", { className: "ds-glass" },
          React.createElement(PnlCalendar, { trades: closed, days: 90 })
        )
      );
    };
  };
})();
