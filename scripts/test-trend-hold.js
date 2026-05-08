#!/usr/bin/env node
/**
 * Phase 2 — Trend-Hold module smoke test.
 *
 * Pure-function tests for `worker/trend-hold.js`. Exercises:
 *   - shouldPromoteToTrendHold:  positive case + 9 negative cases
 *   - shouldDemoteFromTrendHold: 5 demotion paths + intact case
 *   - shouldDcaTrendHold:        cloud-reclaim positive + 5 reject paths
 *   - evaluateExitSuppression:   5 banned reasons + passthroughs
 *   - extractTrendSnapshot:      tickerData -> snapshot normalization
 *
 * Run: `node scripts/test-trend-hold.js`
 * Exit code 0 = all pass, 1 = any fail. No external test framework.
 */

import {
  DEFAULT_TREND_HOLD_CONFIG,
  loadTrendHoldConfig,
  isTrendHoldEnabled,
  extractTrendSnapshot,
  shouldPromoteToTrendHold,
  shouldDemoteFromTrendHold,
  shouldDcaTrendHold,
  evaluateExitSuppression,
  isTrendHoldActive,
} from '../worker/trend-hold.js';

let pass = 0, fail = 0;
const log = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    log.push(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    log.push(`  FAIL  ${name}\n         ${e.message}`);
  }
}

function expect(actual, op, expected, label) {
  const cmp = {
    '==': () => actual === expected,
    '!=': () => actual !== expected,
    '>=': () => actual >= expected,
    '<=': () => actual <= expected,
    'truthy': () => !!actual,
    'falsy': () => !actual,
    'matches': () => new RegExp(expected).test(String(actual)),
  }[op];
  if (!cmp || !cmp()) {
    throw new Error(`${label}: expected ${op} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Snapshot fixture: a textbook RESILIENT_TREND mid-run state for SNDK.
// All trend filters above their EMAs, weekly+monthly ST bull.
// ─────────────────────────────────────────────────────────────────────
function fxIdealPromotionSnap() {
  return {
    ticker: 'SNDK',
    close: 200.0,
    direction: 'LONG',
    mfePct: 18.5,        // proves it worked
    trimmedPct: 0.0,
    daily: {
      ema21: 180, ema21_above: true,
      ema5: 195, ema12: 188,
      cloud_status: 'above',
      stDir: 1,
      rsi: 72,
    },
    weekly: {
      ema21: 165, ema21_above: true,
      stDir: 1,
      rsi: 70,
      td9_sell_count: 4,
      consecutive_below_ema21: 0,
    },
    fourH: { ema21: 192, ema21_above: true, rsi: 68 },
    monthly: { stDir: 1 },
    macro: { spy_day_change_pct: 0.4, vix: 16 },
    sector_rating: 'DOUBLE_OW',
    days_to_earnings: 25,
  };
}

function fxOpenTrade(overrides = {}) {
  return {
    trade_id: 'TST-1',
    ticker: 'SNDK',
    direction: 'LONG',
    avgEntry: 170.0,
    entryPrice: 170.0,
    maxFavorableExcursion: 18.5,
    trimmed_pct: 0.0,
    trend_hold_state: null,
    trend_hold_demoted_at: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// shouldPromoteToTrendHold — positive case
// ─────────────────────────────────────────────────────────────────────
t('promote: ideal snapshot returns promote=true with flavor', () => {
  const snap = fxIdealPromotionSnap();
  const trade = fxOpenTrade();
  const r = shouldPromoteToTrendHold(snap, trade, DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', true, 'promote');
  expect(r.flavor, 'matches', '^(CLEAN|RESILIENT)_TREND$', 'flavor');
});

// ─────────────────────────────────────────────────────────────────────
// shouldPromoteToTrendHold — negative cases (one per gate)
// ─────────────────────────────────────────────────────────────────────
t('promote: rejects SHORT direction', () => {
  const snap = fxIdealPromotionSnap(); snap.direction = 'SHORT';
  const r = shouldPromoteToTrendHold(snap, fxOpenTrade({ direction: 'SHORT' }), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', 'not_long', 'reason');
});

t('promote: rejects when MFE < 5%', () => {
  const snap = fxIdealPromotionSnap(); snap.mfePct = 3.0;
  const r = shouldPromoteToTrendHold(snap, fxOpenTrade({ maxFavorableExcursion: 3.0 }), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', '^mfe=', 'reason');
});

t('promote: rejects when weekly close below EMA-21', () => {
  const snap = fxIdealPromotionSnap(); snap.weekly.ema21_above = false;
  const r = shouldPromoteToTrendHold(snap, fxOpenTrade(), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', 'weekly_ema21_below', 'reason');
});

t('promote: rejects when daily close below EMA-21', () => {
  const snap = fxIdealPromotionSnap(); snap.daily.ema21_above = false;
  const r = shouldPromoteToTrendHold(snap, fxOpenTrade(), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', 'daily_ema21_below', 'reason');
});

t('promote: rejects when 4H close below EMA-21', () => {
  const snap = fxIdealPromotionSnap(); snap.fourH.ema21_above = false;
  const r = shouldPromoteToTrendHold(snap, fxOpenTrade(), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', '4h_ema21_below', 'reason');
});

t('promote: rejects when monthly SuperTrend not bull', () => {
  const snap = fxIdealPromotionSnap(); snap.monthly.stDir = -1;
  const r = shouldPromoteToTrendHold(snap, fxOpenTrade(), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', 'monthly_st_not_bull', 'reason');
});

t('promote: rejects when weekly TD9 sell-setup at 9', () => {
  const snap = fxIdealPromotionSnap(); snap.weekly.td9_sell_count = 9;
  const r = shouldPromoteToTrendHold(snap, fxOpenTrade(), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', 'weekly_td9_sell', 'reason');
});

t('promote: rejects when sector underweight', () => {
  const snap = fxIdealPromotionSnap(); snap.sector_rating = 'UW';
  const r = shouldPromoteToTrendHold(snap, fxOpenTrade(), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', 'sector_rating', 'reason');
});

t('promote: rejects pre-earnings (< 3 days)', () => {
  const snap = fxIdealPromotionSnap(); snap.days_to_earnings = 1;
  const r = shouldPromoteToTrendHold(snap, fxOpenTrade(), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', 'days_to_earnings', 'reason');
});

t('promote: rejects when already trimmed >= 50%', () => {
  const snap = fxIdealPromotionSnap(); snap.trimmedPct = 0.6;
  const r = shouldPromoteToTrendHold(snap, fxOpenTrade({ trimmed_pct: 0.6 }), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', 'trimmed_pct', 'reason');
});

t('promote: rejects within demote cooldown (6h)', () => {
  const snap = fxIdealPromotionSnap();
  const trade = fxOpenTrade({ trend_hold_demoted_at: Date.now() - 60 * 60 * 1000 });  // 1h ago
  const r = shouldPromoteToTrendHold(snap, trade, DEFAULT_TREND_HOLD_CONFIG);
  expect(r.promote, '==', false, 'promote');
  expect(r.reason, 'matches', 'cooldown_after_demote', 'reason');
});

// ─────────────────────────────────────────────────────────────────────
// shouldDemoteFromTrendHold
// ─────────────────────────────────────────────────────────────────────
t('demote: intact macro trend → no demote', () => {
  const snap = fxIdealPromotionSnap();
  const trade = fxOpenTrade({ trend_hold_state: 'active' });
  const r = shouldDemoteFromTrendHold(snap, trade, DEFAULT_TREND_HOLD_CONFIG);
  expect(r.demote, '==', false, 'demote');
});

t('demote: 2 consecutive weekly closes below EMA-21 → demote (PRIMARY)', () => {
  const snap = fxIdealPromotionSnap();
  snap.weekly.consecutive_below_ema21 = 2;
  const r = shouldDemoteFromTrendHold(snap, fxOpenTrade({ trend_hold_state: 'active' }), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.demote, '==', true, 'demote');
  expect(r.reason, 'matches', 'weekly_below_ema21_streak', 'reason');
});

t('demote: weekly TD9 sell-9 setup complete → demote', () => {
  const snap = fxIdealPromotionSnap();
  snap.weekly.td9_sell_count = 9;
  const r = shouldDemoteFromTrendHold(snap, fxOpenTrade({ trend_hold_state: 'active' }), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.demote, '==', true, 'demote');
  expect(r.reason, 'matches', 'weekly_td9_sell_setup_complete', 'reason');
});

t('demote: monthly SuperTrend bear flip → demote', () => {
  const snap = fxIdealPromotionSnap();
  snap.monthly.stDir = -1;
  const r = shouldDemoteFromTrendHold(snap, fxOpenTrade({ trend_hold_state: 'active' }), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.demote, '==', true, 'demote');
  expect(r.reason, 'matches', 'monthly_supertrend_bear', 'reason');
});

t('demote: cascade flip W+D+4H all below → demote', () => {
  const snap = fxIdealPromotionSnap();
  snap.weekly.ema21_above = false;
  snap.daily.ema21_above = false;
  snap.fourH.ema21_above = false;
  const r = shouldDemoteFromTrendHold(snap, fxOpenTrade({ trend_hold_state: 'active' }), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.demote, '==', true, 'demote');
  expect(r.reason, 'matches', 'cascade_flip', 'reason');
});

t('demote: SPY -3% in single session → demote (macro shock)', () => {
  const snap = fxIdealPromotionSnap();
  snap.macro.spy_day_change_pct = -3.5;
  const r = shouldDemoteFromTrendHold(snap, fxOpenTrade({ trend_hold_state: 'active' }), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.demote, '==', true, 'demote');
  expect(r.reason, 'matches', 'spy_drop', 'reason');
});

t('demote: VIX > 35 → demote (macro shock)', () => {
  const snap = fxIdealPromotionSnap();
  snap.macro.vix = 38;
  const r = shouldDemoteFromTrendHold(snap, fxOpenTrade({ trend_hold_state: 'active' }), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.demote, '==', true, 'demote');
  expect(r.reason, 'matches', 'vix=', 'reason');
});

// ─────────────────────────────────────────────────────────────────────
// shouldDcaTrendHold
// ─────────────────────────────────────────────────────────────────────
t('dca: cloud reclaim with macro intact → DCA fires', () => {
  const snap = fxIdealPromotionSnap();
  snap.daily.cloud_status = 'above';
  snap.prev_daily_cloud_status = 'below';
  snap.close = 165;  // pullback from 170 entry = -2.9%
  const trade = fxOpenTrade({
    trend_hold_state: 'active',
    trend_hold_flavor: 'RESILIENT_TREND',
    avgEntry: 170,
  });
  const r = shouldDcaTrendHold(snap, trade, DEFAULT_TREND_HOLD_CONFIG);
  expect(r.dca, '==', true, 'dca');
  expect(r.reason, 'matches', 'cloud_reclaim', 'reason');
});

t('dca: rejects when not active', () => {
  const snap = fxIdealPromotionSnap();
  snap.prev_daily_cloud_status = 'below';
  const r = shouldDcaTrendHold(snap, fxOpenTrade({ trend_hold_state: null }), DEFAULT_TREND_HOLD_CONFIG);
  expect(r.dca, '==', false, 'dca');
  expect(r.reason, '==', 'not_active', 'reason');
});

t('dca: rejects CLEAN_TREND flavor (no DCA path)', () => {
  const snap = fxIdealPromotionSnap();
  snap.prev_daily_cloud_status = 'below';
  const trade = fxOpenTrade({ trend_hold_state: 'active', trend_hold_flavor: 'CLEAN_TREND' });
  const r = shouldDcaTrendHold(snap, trade, DEFAULT_TREND_HOLD_CONFIG);
  expect(r.dca, '==', false, 'dca');
  expect(r.reason, 'matches', 'flavor=', 'reason');
});

t('dca: rejects when weekly EMA-21 broken', () => {
  const snap = fxIdealPromotionSnap();
  snap.weekly.ema21_above = false;
  snap.prev_daily_cloud_status = 'below';
  const trade = fxOpenTrade({ trend_hold_state: 'active', trend_hold_flavor: 'RESILIENT_TREND' });
  const r = shouldDcaTrendHold(snap, trade, DEFAULT_TREND_HOLD_CONFIG);
  expect(r.dca, '==', false, 'dca');
  expect(r.reason, 'matches', 'weekly_ema21_broken', 'reason');
});

t('dca: rejects when no cloud reclaim (prev was already above)', () => {
  const snap = fxIdealPromotionSnap();
  snap.prev_daily_cloud_status = 'above';  // no reclaim
  const trade = fxOpenTrade({ trend_hold_state: 'active', trend_hold_flavor: 'RESILIENT_TREND' });
  const r = shouldDcaTrendHold(snap, trade, DEFAULT_TREND_HOLD_CONFIG);
  expect(r.dca, '==', false, 'dca');
  expect(r.reason, 'matches', 'no reclaim', 'reason');
});

t('dca: rejects when pullback exceeds -10%', () => {
  const snap = fxIdealPromotionSnap();
  snap.prev_daily_cloud_status = 'below';
  snap.close = 150;  // 170 entry → -11.7% pullback
  const trade = fxOpenTrade({ trend_hold_state: 'active', trend_hold_flavor: 'RESILIENT_TREND', avgEntry: 170 });
  const r = shouldDcaTrendHold(snap, trade, DEFAULT_TREND_HOLD_CONFIG);
  expect(r.dca, '==', false, 'dca');
  expect(r.reason, 'matches', 'too deep', 'reason');
});

// ─────────────────────────────────────────────────────────────────────
// evaluateExitSuppression
// ─────────────────────────────────────────────────────────────────────
const SUPPRESSED = [
  'HARD_FUSE_RSI_EXTREME',
  'PROFIT_GIVEBACK_STAGE_HOLD',
  'PROFIT_GIVEBACK_COOLING_HOLD',
  'SMART_RUNNER_SUPPORT_BREAK_CLOUD',
  'mfe_decay_structural_flatten',
  'ST_FLIP_4H_CLOSE',
];
for (const r of SUPPRESSED) {
  t(`suppress: ${r} suppressed when state=active`, () => {
    const out = evaluateExitSuppression({ trend_hold_state: 'active' }, r, DEFAULT_TREND_HOLD_CONFIG);
    expect(out.suppress, '==', true, 'suppress');
    expect(out.reason, 'matches', `^trend_hold_active_suppress\\(${r}\\)$`, 'reason');
  });
  t(`suppress: ${r} NOT suppressed when state=null`, () => {
    const out = evaluateExitSuppression({ trend_hold_state: null }, r, DEFAULT_TREND_HOLD_CONFIG);
    expect(out.suppress, '==', false, 'suppress');
  });
}
const ALLOWED = ['max_loss', 'sl_breached', 'TP_FULL', 'doctrine_force_exit', 'tape_capitulation_force_exit', 'PRE_EARNINGS_FORCE_EXIT'];
for (const r of ALLOWED) {
  t(`suppress: ${r} flows through unchanged when state=active`, () => {
    const out = evaluateExitSuppression({ trend_hold_state: 'active' }, r, DEFAULT_TREND_HOLD_CONFIG);
    expect(out.suppress, '==', false, 'suppress');
  });
}

// ─────────────────────────────────────────────────────────────────────
// extractTrendSnapshot — normalization sanity check
// ─────────────────────────────────────────────────────────────────────
t('extractTrendSnapshot: maps tickerData fields correctly', () => {
  const td = {
    ticker: 'SNDK',
    priceClose: 200,
    tf_tech: {
      D: { ema21: 180, ema48: 175, ema5: 195, ema12: 188, stDir: 1, rsi: 72 },
      W: { ema21: 165, stDir: 1, rsi: 70 },
      "4H": { ema21: 192, rsi: 68 },
    },
    monthly_bundle: { supertrend_dir: 1 },
    td_sequential: { per_tf: { W: { bearish_prep_count: 4 } } },
    spy_day_change_pct: 0.4,
    vix_level: 16,
    sector_rating: 'DOUBLE_OW',
    days_to_earnings: 25,
  };
  const trade = fxOpenTrade();
  const snap = extractTrendSnapshot(td, trade);
  expect(snap, 'truthy', null, 'snap');
  expect(snap.weekly.ema21_above, '==', true, 'wkEMA21 above');
  expect(snap.daily.ema21_above, '==', true, 'dEMA21 above');
  expect(snap.fourH.ema21_above, '==', true, '4H EMA21 above');
  expect(snap.weekly.stDir, '==', 1, 'wk stDir');
  expect(snap.monthly.stDir, '==', 1, 'mST');
  expect(snap.weekly.td9_sell_count, '==', 4, 'TD9 sell');
  expect(snap.daily.cloud_status, '==', 'above', 'cloud');
  expect(snap.sector_rating, '==', 'DOUBLE_OW', 'sector');
});

t('extractTrendSnapshot: returns null on empty input', () => {
  expect(extractTrendSnapshot(null, {}), '==', null, 'null in -> null out');
});

// ─────────────────────────────────────────────────────────────────────
// loadTrendHoldConfig + isTrendHoldEnabled
// ─────────────────────────────────────────────────────────────────────
t('loadTrendHoldConfig: respects deep_audit_trend_hold_max_positions override', () => {
  const cfg = loadTrendHoldConfig({ deep_audit_trend_hold_max_positions: 7 });
  expect(cfg.max_simultaneous_positions, '==', 7, 'cap=7');
});

t('loadTrendHoldConfig: rejects out-of-range cap (defaults retained)', () => {
  const cfg = loadTrendHoldConfig({ deep_audit_trend_hold_max_positions: 999 });
  expect(cfg.max_simultaneous_positions, '==', DEFAULT_TREND_HOLD_CONFIG.max_simultaneous_positions, 'cap=default');
});

t('isTrendHoldEnabled: default OFF', () => {
  expect(isTrendHoldEnabled(null), '==', false, 'null daCfg');
  expect(isTrendHoldEnabled({}), '==', false, 'empty daCfg');
  expect(isTrendHoldEnabled({ deep_audit_trend_hold_enabled: 'false' }), '==', false, 'explicit false');
  expect(isTrendHoldEnabled({ deep_audit_trend_hold_enabled: 'true' }), '==', true, 'explicit true');
});

// ─────────────────────────────────────────────────────────────────────
// isTrendHoldActive
// ─────────────────────────────────────────────────────────────────────
t('isTrendHoldActive: case-insensitive + null-safe', () => {
  expect(isTrendHoldActive({ trend_hold_state: 'active' }), '==', true, 'active');
  expect(isTrendHoldActive({ trend_hold_state: 'ACTIVE' }), '==', true, 'ACTIVE');
  expect(isTrendHoldActive({ trend_hold_state: 'demoted' }), '==', false, 'demoted');
  expect(isTrendHoldActive({ trend_hold_state: null }), '==', false, 'null');
  expect(isTrendHoldActive({}), '==', false, 'missing column');
  expect(isTrendHoldActive(null), '==', false, 'null trade');
});

// ─────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────
console.log(log.join('\n'));
console.log('---');
console.log(`PASS: ${pass}  FAIL: ${fail}  TOTAL: ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
