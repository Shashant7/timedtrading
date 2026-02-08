-- TD Sequential (DeMark Sequencer) Seed Patterns
-- These patterns leverage server-side computed TD Sequential data (D/W/M)
-- to detect exhaustion/reversal setups at various timeframe levels.

-- TD9 Bullish in Bear State (reversal from oversold)
-- When TD9 bullish fires while in bear state, potential bottom reversal
INSERT OR REPLACE INTO pattern_library (pattern_id, name, description, expected_direction, definition_json, hit_rate, sample_count, avg_return, avg_magnitude, expected_value, directional_accuracy, confidence, status, version, last_updated, created_at)
VALUES (
  'td9_bullish_bear_state',
  'TD9 Bullish + Bear State',
  'TD9 bullish exhaustion signal while in bear state — potential reversal bottom. DeMark prep phase completed with 9 consecutive closes below close[4].',
  'UP',
  '[{"field":"td_sequential.td9_bullish","op":"truthy"},{"field":"state","op":"in","value":["HTF_BEAR_LTF_BEAR","HTF_BEAR_LTF_PULLBACK"]}]',
  0.5, 0, 0, 0, 0, 0.5, 0.4, 'active', 1, 1770561132398, 1770561132398
);

-- TD9 Bearish in Bull State (exhaustion top)
-- When TD9 bearish fires while in bull state, potential topping pattern
INSERT OR REPLACE INTO pattern_library (pattern_id, name, description, expected_direction, definition_json, hit_rate, sample_count, avg_return, avg_magnitude, expected_value, directional_accuracy, confidence, status, version, last_updated, created_at)
VALUES (
  'td9_bearish_bull_state',
  'TD9 Bearish + Bull State',
  'TD9 bearish exhaustion signal while in bull state — potential exhaustion top. Warns of reversal risk for LONG positions.',
  'DOWN',
  '[{"field":"td_sequential.td9_bearish","op":"truthy"},{"field":"state","op":"in","value":["HTF_BULL_LTF_BULL","HTF_BULL_LTF_PULLBACK"]}]',
  0.5, 0, 0, 0, 0, 0.5, 0.4, 'active', 1, 1770561132398, 1770561132398
);

-- TD13 Bullish (strong exhaustion reversal up)
-- TD13 is the leadup phase completion — stronger and rarer than TD9
INSERT OR REPLACE INTO pattern_library (pattern_id, name, description, expected_direction, definition_json, hit_rate, sample_count, avg_return, avg_magnitude, expected_value, directional_accuracy, confidence, status, version, last_updated, created_at)
VALUES (
  'td13_bullish_reversal',
  'TD13 Bullish Reversal',
  'TD13 bullish leadup phase complete — strongest DeMark reversal signal. Extended selling exhaustion suggests imminent bottom.',
  'UP',
  '[{"field":"td_sequential.td13_bullish","op":"truthy"}]',
  0.5, 0, 0, 0, 0, 0.5, 0.5, 'active', 1, 1770561132398, 1770561132398
);

-- TD13 Bearish (strong exhaustion reversal down)
INSERT OR REPLACE INTO pattern_library (pattern_id, name, description, expected_direction, definition_json, hit_rate, sample_count, avg_return, avg_magnitude, expected_value, directional_accuracy, confidence, status, version, last_updated, created_at)
VALUES (
  'td13_bearish_reversal',
  'TD13 Bearish Reversal',
  'TD13 bearish leadup phase complete — strongest DeMark reversal signal. Extended buying exhaustion suggests imminent top.',
  'DOWN',
  '[{"field":"td_sequential.td13_bearish","op":"truthy"}]',
  0.5, 0, 0, 0, 0, 0.5, 0.5, 'active', 1, 1770561132398, 1770561132398
);

-- TD9 Bullish + High Completion (double exhaustion confirmation)
-- When both TD Sequential AND phase completion are showing exhaustion, reversal is more likely
INSERT OR REPLACE INTO pattern_library (pattern_id, name, description, expected_direction, definition_json, hit_rate, sample_count, avg_return, avg_magnitude, expected_value, directional_accuracy, confidence, status, version, last_updated, created_at)
VALUES (
  'td9_bullish_high_completion',
  'TD9 Bullish + High Completion',
  'TD9 bullish combined with high phase completion (>70%) — double exhaustion confirmation strengthens reversal probability.',
  'UP',
  '[{"field":"td_sequential.td9_bullish","op":"truthy"},{"field":"phase_pct","op":"gte","value":0.7}]',
  0.5, 0, 0, 0, 0, 0.5, 0.45, 'active', 1, 1770561132398, 1770561132398
);

-- TD9 Bearish + High Completion (double exhaustion for exit)
INSERT OR REPLACE INTO pattern_library (pattern_id, name, description, expected_direction, definition_json, hit_rate, sample_count, avg_return, avg_magnitude, expected_value, directional_accuracy, confidence, status, version, last_updated, created_at)
VALUES (
  'td9_bearish_high_completion',
  'TD9 Bearish + High Completion',
  'TD9 bearish combined with high phase completion (>70%) — compound exhaustion signal, high probability of mean reversion down.',
  'DOWN',
  '[{"field":"td_sequential.td9_bearish","op":"truthy"},{"field":"phase_pct","op":"gte","value":0.7}]',
  0.5, 0, 0, 0, 0, 0.5, 0.45, 'active', 1, 1770561132398, 1770561132398
);

-- TD Sequential Multi-TF Confluence Bullish (D+W or W+M signals aligned)
-- When multiple timeframes show bullish exhaustion simultaneously
INSERT OR REPLACE INTO pattern_library (pattern_id, name, description, expected_direction, definition_json, hit_rate, sample_count, avg_return, avg_magnitude, expected_value, directional_accuracy, confidence, status, version, last_updated, created_at)
VALUES (
  'td_multi_tf_bullish',
  'TD Multi-TF Bullish Confluence',
  'TD Sequential bullish signals active on 2+ timeframes (D/W/M) simultaneously — rare but high-conviction reversal setup.',
  'UP',
  '[{"field":"td_sequential.td9_bullish","op":"truthy"},{"field":"td_sequential.boost","op":"gte","value":5}]',
  0.5, 0, 0, 0, 0, 0.5, 0.5, 'active', 1, 1770561132398, 1770561132398
);

-- TD Sequential Multi-TF Confluence Bearish
INSERT OR REPLACE INTO pattern_library (pattern_id, name, description, expected_direction, definition_json, hit_rate, sample_count, avg_return, avg_magnitude, expected_value, directional_accuracy, confidence, status, version, last_updated, created_at)
VALUES (
  'td_multi_tf_bearish',
  'TD Multi-TF Bearish Confluence',
  'TD Sequential bearish signals active on 2+ timeframes (D/W/M) simultaneously — rare but high-conviction reversal/exit setup.',
  'DOWN',
  '[{"field":"td_sequential.td9_bearish","op":"truthy"},{"field":"td_sequential.boost","op":"lte","value":-5}]',
  0.5, 0, 0, 0, 0, 0.5, 0.5, 'active', 1, 1770561132398, 1770561132398
);

-- Log the seeding event
INSERT INTO model_changelog (change_id, change_type, description, status, proposed_at, approved_by, approved_at, created_at)
VALUES (
  'chg:seed_td:1770561132398',
  'add_pattern',
  'Seeded 8 TD Sequential patterns: TD9/TD13 bullish/bearish reversals, double exhaustion, multi-TF confluence',
  'auto_applied',
  1770561132398,
  'system',
  1770561132398,
  1770561132398
);
