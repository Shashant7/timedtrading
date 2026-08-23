// Standalone paper-family tickets (Confirm-stack / Cloud Pivot / Continuation).
//
// Detectors already stamp `_sequence_queue_proposal` at 0.1×. Until this
// helper, that stamp never opened a trade — family exits had nothing to
// manage and the broker never saw a fill. When the proposal is live and
// no canonical core path is in the enter lane, open a real 0.1× sim
// ticket (same qty forwarded to the broker).
//
// Canonical core paths (tt_gap_reversal_*, tt_n_test_*, …) stay full size.

import {
  PAPER_EXPERIMENT_FAMILIES,
  PAPER_FAMILY_LABELS,
  CONFIRM_STACK_FAMILY,
  CLOUD_PIVOT_FAMILY,
  CONTINUATION_FAMILY,
} from "../paper-family-label.js";

export {
  PAPER_EXPERIMENT_FAMILIES,
  PAPER_FAMILY_LABELS,
  CONFIRM_STACK_FAMILY,
  CLOUD_PIVOT_FAMILY,
  CONTINUATION_FAMILY,
};

const FAMILY_SET = new Set(PAPER_EXPERIMENT_FAMILIES);

export function loadPaperFamilyEntryConfig(daCfg = {}) {
  const enabled = String(daCfg.deep_audit_paper_family_standalone_entry_enabled ?? "true") === "true";
  const replayEnabled = String(daCfg.deep_audit_paper_family_standalone_entry_replay ?? "false") === "true";
  return { enabled, replayEnabled };
}

/** Strip `_long` / `_short` so `tt_cloud_pivot_long` matches the family id. */
export function paperFamilyBasePath(entryPath) {
  const path = String(entryPath || "").toLowerCase().trim();
  if (!path) return "";
  return path.replace(/_short$|_long$/, "");
}

export function isPaperFamilyEntryPath(entryPath) {
  const path = String(entryPath || "").toLowerCase().trim();
  if (!path) return false;
  const base = paperFamilyBasePath(path);
  if (FAMILY_SET.has(base) || FAMILY_SET.has(path)) return true;
  return path.includes("cloud_pivot")
    || path.includes("confirm_stack")
    || path.includes("momentum_continuation");
}

export function paperFamilyEntryPath(family, direction) {
  const fam = String(family || "").trim();
  const dir = String(direction || "").toUpperCase() === "SHORT" ? "short" : "long";
  return `${fam}_${dir}`;
}

export function paperFamilySetupLabel(entryPath) {
  const base = paperFamilyBasePath(entryPath);
  const label = PAPER_FAMILY_LABELS[base] || PAPER_FAMILY_LABELS[String(entryPath || "").trim()];
  return label ? `TT ${label}` : null;
}

function inferPaperDirection(payload = {}, proposal = {}) {
  const fromProp = String(proposal.direction || "").toUpperCase();
  if (fromProp === "LONG" || fromProp === "SHORT") return fromProp;
  const detectDir = String(
    payload._cloud_pivot_detect?.direction
    || payload._continuation_detect?.direction
    || "",
  ).toUpperCase();
  if (detectDir === "LONG" || detectDir === "SHORT") return detectDir;
  const state = String(payload.state || "").toUpperCase();
  if (state.includes("BEAR")) return "SHORT";
  if (state.includes("BULL")) return "LONG";
  const flags = payload.flags || {};
  if (flags.st_flip_bear) return "SHORT";
  if (flags.st_flip_bull) return "LONG";
  return "LONG";
}

/**
 * Pure: when a paper-family proposal is live, describe the standalone ticket.
 * Returns null when the family should stay a stamp-only watch.
 */
export function resolvePaperFamilyStandaloneEntry(payload = {}, daCfg = {}, opts = {}) {
  const cfg = loadPaperFamilyEntryConfig(daCfg);
  if (!cfg.enabled) return null;
  const isReplay = opts.isReplay === true
    || payload?._env?._isReplay === true
    || payload?._env?._replay === true;
  if (isReplay && !cfg.replayEnabled) return null;

  const proposal = payload._sequence_queue_proposal;
  if (!proposal || proposal.paper !== true) return null;
  const family = String(proposal.family || "").trim();
  if (!FAMILY_SET.has(family)) return null;

  const life = String(payload._model_lifecycle?.state || payload.model_lifecycle?.state || "").toLowerCase();
  if (["bought", "held", "trimming", "exited"].includes(life)) return null;
  const stage = String(payload.kanban_stage || "").toLowerCase();
  if (["just_entered", "hold", "trim", "exit", "exited"].includes(stage)) return null;

  const direction = inferPaperDirection(payload, proposal);
  const rawMult = Number(proposal.size_mult);
  const size_mult = Number.isFinite(rawMult) && rawMult > 0 && rawMult <= 1 ? rawMult : 0.1;
  const path = paperFamilyEntryPath(family, direction);

  return {
    family,
    path,
    direction,
    size_mult,
    paper: true,
    reason: proposal.reason || `paper_family_standalone:${family}`,
    label: PAPER_FAMILY_LABELS[family] || family,
  };
}

/** Stamp family + paper flags on a freshly built trade object.
 *  Only when THIS ticket is the paper-family path — a coincident
 *  proposal on a canonical core fill must not rewrite slice_family.
 */
export function stampPaperFamilyOnTrade(trade, tickerData, entryPath) {
  if (!trade || typeof trade !== "object") return trade;
  const fromTd = tickerData && typeof tickerData === "object" ? tickerData : {};
  const path = entryPath || trade.entry_path || trade.entryPath;
  if (!fromTd.__paper_family_ticket && !isPaperFamilyEntryPath(path)) return trade;
  const family = fromTd.__entry_family
    || fromTd._sequence_queue_proposal?.family
    || paperFamilyBasePath(path);
  const resolved = FAMILY_SET.has(family) ? family : paperFamilyBasePath(path);
  if (!resolved || !FAMILY_SET.has(resolved)) return trade;
  const mult = Number(
    fromTd.__paper_queue_size_mult
    ?? fromTd._sequence_queue_proposal?.size_mult
    ?? 0.1,
  );
  trade.slice_family = resolved;
  trade.entry_family = resolved;
  trade.paper = true;
  trade.paper_mult = Number.isFinite(mult) && mult > 0 && mult < 1 ? mult : 0.1;
  if (fromTd && typeof fromTd === "object") {
    fromTd.__entry_family = resolved;
    fromTd.__paper_family_ticket = true;
    fromTd.__paper_queue_size_mult = trade.paper_mult;
  }
  return trade;
}
