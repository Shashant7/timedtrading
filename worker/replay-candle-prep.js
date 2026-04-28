export async function prepareCandleReplayRuntime(args = {}) {
  const {
    db,
    KV,
    replayEnv,
    replayRunConfig,
    replayCtx,
    candleCache,
    dateParam,
    marketCloseMs,
    deps = {},
  } = args;
  const {
    loadReplayConfigValue,
    d1GetCandlesAllTfs,
    kvGetJSON,
    CARTER_OFFENSE_SECTORS,
    CARTER_DEFENSE_SECTORS,
  } = deps;

  if (!db || !KV || !replayEnv || !replayCtx || !candleCache || !loadReplayConfigValue || !d1GetCandlesAllTfs || !kvGetJSON) {
    throw new Error("prepareCandleReplayRuntime missing required dependencies");
  }

  let replayCurrentVix = null;
  let replayVixCandles = [];
  const replaySectorCandles = {};
  let replayMarketInternals = null;

  const cioReplayEnabled = String(replayEnv._deepAuditConfig?.ai_cio_enabled ?? "false") === "true" &&
    String(replayEnv._deepAuditConfig?.ai_cio_replay_enabled ?? "false") === "true";
  if (cioReplayEnabled) {
    try {
      const [ppRows, snapRows, eventRows, tickerSummaryRows, franchiseRow, cioRefRow] = await Promise.all([
        db.prepare(`SELECT * FROM path_performance WHERE total_trades >= 3`).all(),
        db.prepare(`SELECT * FROM daily_market_snapshots ORDER BY date`).all(),
        db.prepare(`SELECT * FROM market_events ORDER BY date`).all(),
        db.prepare(`SELECT ticker, COUNT(*) as total,
          SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
          AVG(pnl_pct) as avg_pnl_pct
          FROM direction_accuracy WHERE status IN ('WIN','LOSS','FLAT') GROUP BY ticker`).all(),
        loadReplayConfigValue(db, replayRunConfig, "cio_franchise_blacklist", {
          allowLiveFallback: false,
          warnPrefix: "[REPLAY]",
        }).then((config_value) => ({ config_value })),
        loadReplayConfigValue(db, replayRunConfig, "cio_reference_features", {
          allowLiveFallback: false,
          warnPrefix: "[REPLAY]",
        }).then((config_value) => ({ config_value })),
      ]);
      const pathPerf = new Map();
      for (const row of (ppRows?.results || [])) pathPerf.set(row.entry_path, row);
      const tickerProfiles = {};
      try {
        const tpRows = await db.prepare(`SELECT * FROM ticker_profiles`).all();
        for (const row of (tpRows?.results || [])) tickerProfiles[row.ticker] = row;
      } catch {}
      let franchise = null;
      if (franchiseRow?.config_value) {
        try { franchise = JSON.parse(franchiseRow.config_value); } catch {}
      }
      let referenceFeatures = null;
      if (String(replayEnv._deepAuditConfig?.ai_cio_reference_enabled ?? "false") === "true" && cioRefRow?.config_value) {
        try { referenceFeatures = JSON.parse(cioRefRow.config_value); } catch {}
      }
      replayCtx.cioMemoryCache = {
        pathPerf,
        marketSnapshots: (snapRows?.results || []),
        marketEvents: (eventRows?.results || []),
        tickerProfiles,
        franchise,
        referenceFeatures,
        cioDecisions: [],
      };
      console.log(`[REPLAY] CIO memory loaded: ${pathPerf.size} paths, ${(snapRows?.results || []).length} snapshots, ${(eventRows?.results || []).length} events, ${Object.keys(tickerProfiles).length} profiles${referenceFeatures ? ", ref_priors=on" : ""}`);
    } catch (e) {
      console.warn("[REPLAY] CIO memory pre-load failed:", String(e).slice(0, 200));
      replayCtx.cioMemoryCache = { pathPerf: new Map(), marketSnapshots: [], marketEvents: [], tickerProfiles: {}, franchise: null, referenceFeatures: null, cioDecisions: [] };
    }
  }

  try {
    const vixRes = await d1GetCandlesAllTfs(replayEnv, "VIX", [{ tf: "D", limit: 600 }], {});
    const vixCandles = vixRes?.D?.ok ? (vixRes.D.candles || []) : [];
    if (vixCandles.length > 10) {
      replayVixCandles = vixCandles;
      console.log(`[REPLAY] Loaded ${vixCandles.length} VIX daily candles for historical VIX injection`);
    }
  } catch {}

  try {
    // V16 (2026-04-28): Extended sector universe to include
    // cross-asset reference symbols so we can capture their daily
    // pct change in market_internals.cross_asset:
    //   GLD (Gold), SLV (Silver), USO (Oil), UUP (Dollar),
    //   XLE (Energy), BTCUSD (Bitcoin)
    // These are then exposed on every trade snapshot for
    // context-aware setup selection.
    const CROSS_ASSET_SYMS = ["GLD", "SLV", "USO", "UUP", "XLE", "BTCUSD"];
    const sectorSyms = [...new Set([
      ...CARTER_OFFENSE_SECTORS,
      ...CARTER_DEFENSE_SECTORS,
      ...CROSS_ASSET_SYMS,
    ])];
    await Promise.all(sectorSyms.map(async (sym) => {
      try {
        const res = await d1GetCandlesAllTfs(replayEnv, sym, [{ tf: "D", limit: 600 }], {});
        const candles = res?.D?.ok ? (res.D.candles || []) : [];
        if (candles.length > 10) replaySectorCandles[sym] = candles;
      } catch {}
    }));
    console.log(`[REPLAY] Loaded sector ETF D1 candles: ${Object.entries(replaySectorCandles).map(([sym, candles]) => `${sym}=${candles.length}`).join(", ")}`);
  } catch {}

  if (replayVixCandles.length === 0) {
    try {
      const vixData = await kvGetJSON(KV, "timed:latest:VIX");
      if (vixData?.price) replayCurrentVix = Number(vixData.price);
      console.log(`[REPLAY] No VIX candles — using static KV VIX: ${replayCurrentVix}`);
    } catch {}
  }

  {
    const avg = (arr) => arr.length ? arr.reduce((sum, n) => sum + n, 0) / arr.length : null;
    const getSectorPctChange = (sym) => {
      const dCandles = replaySectorCandles[sym] || candleCache[sym]?.D;
      if (!dCandles || dCandles.length < 2) return null;
      let lastIdx = dCandles.length - 1;
      while (lastIdx >= 0 && dCandles[lastIdx].ts > marketCloseMs) lastIdx--;
      if (lastIdx < 1) return null;
      const curr = dCandles[lastIdx];
      const prev = dCandles[lastIdx - 1];
      if (!prev?.c || !curr?.c || prev.c === 0) return null;
      return ((curr.c - prev.c) / prev.c) * 100;
    };
    const offenseVals = CARTER_OFFENSE_SECTORS.map(getSectorPctChange).filter(Number.isFinite);
    const defenseVals = CARTER_DEFENSE_SECTORS.map(getSectorPctChange).filter(Number.isFinite);
    const offenseAvg = avg(offenseVals);
    const defenseAvg = avg(defenseVals);

    let miScore = 0;
    const miEvidence = [];
    let vixState = null;

    if (replayVixCandles.length > 0) {
      let lo = 0, hi = replayVixCandles.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (replayVixCandles[mid].ts <= marketCloseMs) lo = mid + 1;
        else hi = mid - 1;
      }
      const vixCandle = replayVixCandles[Math.max(0, lo - 1)];
      const vixPrice = vixCandle?.c ? Number(vixCandle.c) : null;
      if (Number.isFinite(vixPrice)) {
        if (vixPrice < 15) { vixState = "low_fear"; miScore += 1; miEvidence.push(`VIX ${vixPrice.toFixed(1)} is low-fear`); }
        else if (vixPrice >= 25) { vixState = "fear"; miScore -= 2; miEvidence.push(`VIX ${vixPrice.toFixed(1)} is in fear mode`); }
        else if (vixPrice >= 20) { vixState = "elevated"; miScore -= 1; miEvidence.push(`VIX ${vixPrice.toFixed(1)} is elevated`); }
        else { vixState = "normal"; miEvidence.push(`VIX ${vixPrice.toFixed(1)} is neutral`); }
      }
    } else if (replayCurrentVix != null) {
      const vp = replayCurrentVix;
      if (vp < 15) { vixState = "low_fear"; miScore += 1; }
      else if (vp >= 25) { vixState = "fear"; miScore -= 2; }
      else if (vp >= 20) { vixState = "elevated"; miScore -= 1; }
      else { vixState = "normal"; }
    }

    let sectorRotation = "unknown";
    if (Number.isFinite(offenseAvg) && Number.isFinite(defenseAvg)) {
      const spread = offenseAvg - defenseAvg;
      if (spread >= 0.25) {
        sectorRotation = "risk_on";
        miScore += 1;
        miEvidence.push(`Offense sectors lead defense by ${spread.toFixed(2)}%`);
      } else if (spread <= -0.25) {
        sectorRotation = "risk_off";
        miScore -= 1;
        miEvidence.push(`Defense sectors lead offense by ${Math.abs(spread).toFixed(2)}%`);
      } else {
        sectorRotation = "balanced";
        miEvidence.push("Sector rotation is balanced");
      }
    }

    const miOverall = miScore >= 2 ? "risk_on" : miScore <= -2 ? "risk_off" : "balanced";
    let miVixPrice = replayCurrentVix;
    if (!miVixPrice && replayVixCandles.length > 0) {
      let vlo = 0, vhi = replayVixCandles.length - 1;
      while (vlo <= vhi) {
        const mid = (vlo + vhi) >> 1;
        if (replayVixCandles[mid].ts <= marketCloseMs) vlo = mid + 1;
        else vhi = mid - 1;
      }
      const vc = replayVixCandles[Math.max(0, vlo - 1)];
      if (vc?.c) miVixPrice = Number(vc.c);
    }

    // V16 (2026-04-28): Capture cross-asset daily % changes for
    // context-aware setup selection. User explicitly listed these:
    // Oil, Gold, Silver, Crypto, Dollar, Commodities.
    const crossAsset = {
      gold_pct: getSectorPctChange("GLD"),
      silver_pct: getSectorPctChange("SLV"),
      oil_pct: getSectorPctChange("USO"),
      dollar_pct: getSectorPctChange("UUP"),
      energy_pct: getSectorPctChange("XLE"),
      btc_pct: getSectorPctChange("BTCUSD"),
    };

    replayMarketInternals = {
      overall: miOverall,
      score: miScore,
      vix: { state: vixState, price: miVixPrice },
      tick: null,
      fx_barometer: null,
      sector_rotation: {
        state: sectorRotation,
        offense_avg_pct: offenseAvg,
        defense_avg_pct: defenseAvg,
        offense_symbols: CARTER_OFFENSE_SECTORS,
        defense_symbols: CARTER_DEFENSE_SECTORS,
      },
      cross_asset: crossAsset,
      squeeze: {},
      evidence: miEvidence,
    };
    console.log(`[REPLAY_INTERNALS] ${dateParam}: overall=${miOverall} score=${miScore} vix=${vixState} rotation=${sectorRotation}`);
  }

  return {
    replayCurrentVix,
    replayVixCandles,
    replaySectorCandles,
    replayMarketInternals,
  };
}
