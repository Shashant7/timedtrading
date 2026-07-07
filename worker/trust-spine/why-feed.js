// Trust Spine — user/operator WHY feed from decision_records.

export function formatDecisionWhyRow(row) {
  if (!row) return null;
  let inputs = null;
  try {
    inputs = row.inputs_json ? JSON.parse(row.inputs_json) : null;
  } catch { /* */ }
  return {
    decision_id: row.decision_id,
    engine: row.engine,
    ticker: row.ticker,
    event_type: row.event_type,
    ts: Number(row.ts),
    reason: row.reason,
    conviction_tier: row.conviction_tier,
    scoring_version: row.scoring_version,
    config_hash: row.config_hash,
    engine_git_sha: row.engine_git_sha,
    trade_id: row.trade_id,
    inputs,
  };
}

export function mergeWhyFeed(decisionRows = [], alertRows = []) {
  const out = [];
  for (const r of decisionRows) {
    const f = formatDecisionWhyRow(r);
    if (f) out.push({ ...f, source: "decision_record" });
  }
  for (const a of alertRows || []) {
    out.push({
      source: "alert",
      ticker: a.ticker,
      event_type: a.type || a.event_type,
      ts: Number(a.ts || a.created_at),
      reason: a.reason || a.message,
      engine: a.mode || a.engine || "trader",
    });
  }
  out.sort((a, b) => Number(b.ts) - Number(a.ts));
  return out;
}
