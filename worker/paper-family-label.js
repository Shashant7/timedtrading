// Paper thin-slice labels — Discord, email, activity, Model Performance.
// Confirm-stack / Cloud Pivot / Continuation fill at 0.1× until family
// attribution says widen. Labels must make that obvious; they do not
// change size or Discord channel.

export const CONFIRM_STACK_FAMILY = "confirm_stack_ema21";
export const CLOUD_PIVOT_FAMILY = "tt_cloud_pivot";
export const CONTINUATION_FAMILY = "momentum_continuation";

export const PAPER_FAMILY_LABELS = Object.freeze({
  [CONFIRM_STACK_FAMILY]: "Confirm-stack",
  [CLOUD_PIVOT_FAMILY]: "Cloud Pivot",
  [CONTINUATION_FAMILY]: "Continuation",
});

export const PAPER_EXPERIMENT_FAMILIES = Object.freeze([
  CONFIRM_STACK_FAMILY,
  CLOUD_PIVOT_FAMILY,
  CONTINUATION_FAMILY,
]);

function asObj(src) {
  return src && typeof src === "object" ? src : {};
}

function readFamilyKey(raw) {
  const key = String(raw || "").trim();
  if (!key) return null;
  if (PAPER_FAMILY_LABELS[key]) return key;
  const lower = key.toLowerCase();
  if (lower === "cloud_pivot" || lower === "cloud pivot") return CLOUD_PIVOT_FAMILY;
  if (lower === "confirm_stack" || lower === "confirm-stack") return CONFIRM_STACK_FAMILY;
  if (lower === "continuation" || lower === "momentum") return CONTINUATION_FAMILY;
  return null;
}

/**
 * Resolve a thin-slice family from tickerData / trade / extra / signal.meta.
 */
export function resolveSliceFamily(src = {}) {
  const root = asObj(src);
  const td = asObj(root.tickerData || (root.__paper_queue_size_mult != null || root._sequence_queue_proposal || root.tt_cloud_pivot || root.confirm_stack || root.momentum_continuation || root.slice_family ? root : null));
  const extra = asObj(root.extra || root.trade || root.meta);
  return readFamilyKey(
    extra.family
    || extra.slice_family
    || td._sequence_queue_proposal?.family
    || td.__entry_family
    || td.slice_family
    || td.__model_play?.family
    || extra.entry_family
    || (td.tt_cloud_pivot ? CLOUD_PIVOT_FAMILY : null)
    || (td.confirm_stack || td.__confirm_stack || td.confirm_stack_ema21 ? CONFIRM_STACK_FAMILY : null)
    || (td.momentum_continuation ? CONTINUATION_FAMILY : null),
  );
}

export function isPaperSized(src = {}) {
  const root = asObj(src);
  const td = asObj(root.tickerData || root);
  const extra = asObj(root.extra || root.trade || root.meta);
  const mult = Number(
    td.__paper_queue_size_mult
    ?? extra.paper_mult
    ?? extra.paperMult
    ?? extra.__paper_queue_size_mult,
  );
  if (Number.isFinite(mult) && mult > 0 && mult < 1) return true;
  if (td._sequence_queue_proposal?.paper === true) return true;
  if (td.__model_play?.paper === true) return true;
  if (extra.paper === true || extra.paper === 1 || extra.paper === "true") return true;
  if (root.paper === true) return true;
  return false;
}

function formatPaperMult(mult) {
  if (!Number.isFinite(mult) || mult <= 0 || mult >= 1) return "0.1×";
  const rounded = Math.round(mult * 1000) / 1000;
  return `${rounded}×`;
}

/**
 * @returns {{
 *   family: string|null,
 *   familyLabel: string|null,
 *   paper: boolean,
 *   paperMult: number|null,
 *   sizeNote: string|null,
 *   titlePrefix: string,
 *   discordFieldName: string|null,
 *   discordFieldValue: string,
 * }}
 */
export function resolvePaperFamily(src = {}) {
  const root = asObj(src);
  const td = asObj(root.tickerData || root);
  const extra = asObj(root.extra || root.trade || root.meta);
  const family = resolveSliceFamily(src);
  const paper = isPaperSized(src);
  const familyLabel = family ? (PAPER_FAMILY_LABELS[family] || family) : null;
  const mult = Number(
    td.__paper_queue_size_mult
    ?? extra.paper_mult
    ?? extra.paperMult
    ?? (paper ? 0.1 : null),
  );
  const paperMult = paper && Number.isFinite(mult) && mult > 0 && mult < 1 ? mult : (paper ? 0.1 : null);
  const sizeNote = paper
    ? `Paper ${formatPaperMult(paperMult)} — experiment, not capital scale`
    : null;
  const bits = [];
  if (paper) bits.push("PAPER");
  if (familyLabel) bits.push(familyLabel);
  const titlePrefix = bits.join(" · ");
  return {
    family,
    familyLabel,
    paper,
    paperMult,
    sizeNote,
    titlePrefix,
    discordFieldName: paper ? "Paper experiment" : (familyLabel ? "Slice family" : null),
    discordFieldValue: [titlePrefix, sizeNote].filter(Boolean).join("\n"),
  };
}

/** Fields to stamp on TRADE_ENTRY activity / email payloads. */
export function paperAlertFields(src = {}) {
  const r = resolvePaperFamily(src);
  if (!r.paper && !r.family) return {};
  return {
    paper: r.paper,
    slice_family: r.family,
    slice_family_label: r.familyLabel,
    paper_mult: r.paperMult,
  };
}

/** `signal.meta` for Discord/email subject prefixes. */
export function paperSignalMeta(src = {}) {
  const r = resolvePaperFamily(src);
  if (!r.paper && !r.family) return {};
  return {
    paper: r.paper,
    family: r.family,
    family_label: r.familyLabel,
    paper_mult: r.paperMult,
  };
}

/** `"PAPER · Cloud Pivot · "` or empty. */
export function paperFamilyTitlePrefix(src = {}) {
  const r = resolvePaperFamily(src);
  return r.titlePrefix ? `${r.titlePrefix} · ` : "";
}
