#!/usr/bin/env node
/**
 * Flip preprod model_config for a mojo weekend ablation arm.
 *
 * Usage:
 *   TIMED_API_KEY=$TIMED_TRADING_API_KEY node scripts/mojo-ablation-arm.mjs A0-tech
 *   TIMED_API_KEY=$TIMED_TRADING_API_KEY node scripts/mojo-ablation-arm.mjs A1-tt
 *   TIMED_API_KEY=$TIMED_TRADING_API_KEY node scripts/mojo-ablation-arm.mjs A4-full --dry-run
 *
 * Arms: A0-tech | A1-tt | A2-lists | A3-theme | A4-full
 * See tasks/2026-09-26-mojo-ablation-weekend.md
 */
const ARM = process.argv.find((a) => /^A[0-4]-/.test(a)) || process.argv[2];
const DRY = process.argv.includes("--dry-run");
const API_KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY;
const PREPROD = process.env.PREPROD_BASE || "https://timed-trading-ingest-preprod.shashant.workers.dev";

if (!API_KEY) {
  console.error("Set TIMED_API_KEY or TIMED_TRADING_API_KEY");
  process.exit(1);
}

const ARMS = {
  "A0-tech": {
    deep_audit_focus_bonus_tt_selected: "false",
    deep_audit_focus_bonus_upticks: "false",
    deep_audit_focus_bonus_granny: "false",
    deep_audit_focus_bonus_context: "false",
    deep_audit_focus_bonus_recent_winner: "false",
    cro_theme_rank_boost_enabled: "false",
  },
  "A1-tt": {
    deep_audit_focus_bonus_tt_selected: "true",
    deep_audit_focus_bonus_upticks: "false",
    deep_audit_focus_bonus_granny: "false",
    deep_audit_focus_bonus_context: "false",
    deep_audit_focus_bonus_recent_winner: "false",
    cro_theme_rank_boost_enabled: "false",
  },
  "A2-lists": {
    deep_audit_focus_bonus_tt_selected: "true",
    deep_audit_focus_bonus_upticks: "true",
    deep_audit_focus_bonus_granny: "true",
    deep_audit_focus_bonus_context: "false",
    deep_audit_focus_bonus_recent_winner: "false",
    cro_theme_rank_boost_enabled: "false",
  },
  "A3-theme": {
    deep_audit_focus_bonus_tt_selected: "true",
    deep_audit_focus_bonus_upticks: "false",
    deep_audit_focus_bonus_granny: "false",
    deep_audit_focus_bonus_context: "false",
    deep_audit_focus_bonus_recent_winner: "false",
    cro_theme_rank_boost_enabled: "true",
  },
  "A4-full": {
    deep_audit_focus_bonus_tt_selected: "true",
    deep_audit_focus_bonus_upticks: "true",
    deep_audit_focus_bonus_granny: "true",
    deep_audit_focus_bonus_context: "true",
    deep_audit_focus_bonus_recent_winner: "true",
    cro_theme_rank_boost_enabled: "true",
  },
};

async function main() {
  const cfg = ARMS[ARM];
  if (!cfg) {
    console.error(`Unknown arm ${ARM}. Known: ${Object.keys(ARMS).join(", ")}`);
    process.exit(1);
  }
  // Always keep focus tier ON so arms match live admit path.
  const updates = {
    deep_audit_focus_tier_enabled: "true",
    deep_audit_focus_tier_a_floor: "110",
    deep_audit_focus_tier_b_floor: "80",
    deep_audit_focus_tier_c_floor: "75",
    deep_audit_focus_min_entry_conviction: "70",
    ...cfg,
  };
  console.log(`Arm ${ARM} → ${PREPROD}`);
  for (const [k, v] of Object.entries(updates)) console.log(`  ${k}=${v}`);
  if (DRY) {
    console.log("(dry-run)");
    return;
  }
  const body = {
    updates: Object.entries(updates).map(([key, value]) => ({
      key,
      value,
      description: `mojo ablation ${ARM} ${new Date().toISOString()}`,
    })),
  };
  const res = await fetch(`${PREPROD}/timed/admin/model-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(data);
    process.exit(1);
  }
  console.log(`OK written=${data.written ?? body.updates.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
