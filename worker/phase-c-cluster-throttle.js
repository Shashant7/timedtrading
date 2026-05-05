/**
 * worker/phase-c-cluster-throttle.js
 *
 * Phase C — Stage 1 (2026-05-05) — Same-Hour Entry Cluster Throttle.
 *
 * On news-catalyzed regime-shock days (e.g. Mar-02 2026), the system
 * fires many entries within a short window — all in the same direction,
 * many with marginal-quality scoring. When the regime then inverts
 * later that day or overnight, the cluster takes correlated losses.
 *
 * Mar-02 evidence:
 *   8 long entries fired between 15:30 and 20:00 UTC on a single day.
 *   ALB (rank 58, Speculative grade) entered at 18:00 — would have been
 *   the WORST of the cluster by rank — and lost -8.44% via overnight gap.
 *   The other 7 trades lost -1 to -4% each.
 *   Total Mar-02 damage: -22.48%.
 *
 *   If we had kept only TOP-3 by rank (GE/UNP/XLRE @ rank 100):
 *     -1.54 + -1.16 + -1.40 = -4.10%  (5× improvement)
 *
 * This module exposes:
 *   admitCluster({ ticker, rank, conviction, entryTs, recentEntries }) →
 *     { allow: boolean, reason: string }
 *
 * Caller maintains a small ring of recent admitted entries (passed in as
 * `recentEntries`). When a new candidate fires AND the cluster window
 * already has N entries with rank ≥ this candidate's rank, this candidate
 * is throttled.
 *
 * Disabled via daCfg.deep_audit_cluster_throttle_enabled = "false".
 */

const DEFAULT_CONFIG = {
  // Cluster window: how far back to look (60 min default)
  window_minutes: 60,
  // Trigger threshold: cluster size at which throttle activates
  cluster_min_size: 5,
  // Top-N: when throttle fires, keep only this many entries (the best
  // by rank). New candidates that don't break into the top-N are
  // throttled.
  top_n_keep: 3,
  // Optional secondary scoring (ties broken by composite rank*rr)
  composite_score: true,
};

/**
 * Decide whether to admit a candidate entry given the recent cluster.
 *
 * @param {object} args
 * @param {string} args.ticker
 * @param {number} args.rank          finalScore from rank_trace
 * @param {number} args.rr            rr from rank_trace
 * @param {number} args.entryTs       candidate's entry timestamp (ms)
 * @param {Array}  args.recentEntries [{ticker, rank, rr, entryTs}, ...]
 *                                    All entries in the LAST cluster window
 *                                    (caller filters by entryTs).
 * @param {object} cfg                merged with DEFAULT_CONFIG
 * @returns {{allow: boolean, reason: string, cluster_size?: number, candidate_rank?: number}}
 */
export function admitCluster(args, cfg) {
  cfg = { ...DEFAULT_CONFIG, ...(cfg || {}) };
  const { ticker, rank, rr, entryTs, recentEntries } = args || {};
  const _candidateRank = Number(rank) || 0;
  const _candidateRr = Number(rr) || 0;
  const _candidateScore = cfg.composite_score
    ? _candidateRank * Math.max(_candidateRr, 0.1)  // floor rr at 0.1 to avoid 0-multiplication
    : _candidateRank;

  const _ts = Number(entryTs) || 0;
  if (!_ts) {
    return { allow: true, reason: "cluster_throttle_no_ts" };
  }
  const windowMs = cfg.window_minutes * 60 * 1000;
  const recent = (Array.isArray(recentEntries) ? recentEntries : [])
    .filter((r) => {
      const rTs = Number(r?.entryTs) || 0;
      return rTs > 0 && (_ts - rTs) <= windowMs && (_ts - rTs) >= 0;
    });

  const clusterSize = recent.length + 1; // include candidate
  if (clusterSize < cfg.cluster_min_size) {
    return {
      allow: true,
      reason: `cluster_below_threshold(${clusterSize}<${cfg.cluster_min_size})`,
      cluster_size: clusterSize,
      candidate_rank: _candidateRank,
    };
  }

  // Score everyone in the cluster
  const scored = recent.map((r) => {
    const rk = Number(r?.rank) || 0;
    const rrR = Number(r?.rr) || 0;
    return {
      ticker: r?.ticker,
      rank: rk,
      rr: rrR,
      score: cfg.composite_score ? rk * Math.max(rrR, 0.1) : rk,
    };
  });
  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Find candidate's position in the sorted cluster
  // (we count how many existing entries have HIGHER score than candidate)
  const higherCount = scored.filter((e) => e.score > _candidateScore).length;
  const candidatePosition = higherCount + 1; // 1-indexed

  if (candidatePosition <= cfg.top_n_keep) {
    return {
      allow: true,
      reason: `cluster_top_${candidatePosition}_of_${clusterSize} (kept top ${cfg.top_n_keep})`,
      cluster_size: clusterSize,
      candidate_rank: _candidateRank,
      candidate_position: candidatePosition,
    };
  }
  return {
    allow: false,
    reason: `cluster_throttled: ${ticker} ranked #${candidatePosition} of ${clusterSize} cluster (window ${cfg.window_minutes}min, keeping top ${cfg.top_n_keep}). Cluster ranks: ${scored.slice(0, 6).map(s => `${s.ticker}:${s.score.toFixed(0)}`).join(", ")}`,
    cluster_size: clusterSize,
    candidate_rank: _candidateRank,
    candidate_position: candidatePosition,
  };
}

export default { admitCluster };
