# PR #890 — Investor slope gate, cooldown, provenance

Canonical description for [PR #890](https://github.com/Shashant7/timedtrading/pull/890).  
Supersedes earlier draft text that mentioned 1H EMA21 and 4H direction gates (removed).

## Summary

Investor timing + cooldown refinements after the CRDO/MOD post-mortem.

### Re-entry cooldowns

| Rule | Value |
|---|---|
| Single loss | **5 days** |
| Persistent loser | **3 consecutive losses → 21 days** (was 2 → 45) |

### Capital deployment gate (4H SuperTrend **slope only**)

Block new opens and adds **only** when **4H SuperTrend is actively sloping down** (`stSlopeDn` / negative `stSlope`).

**Allowed:**
- 4H ST bearish but **flat** slope
- 4H direction flip alone without downward slope

**Not gated:**
- No 1H EMA21 check
- No 4H bearish-direction-only block

Tunable via `deep_audit_investor_st_slope_gate_enabled` (legacy alias: `deep_audit_investor_4h_gate_enabled`).

### Investor provenance (`decision_records`, `engine=investor`)

Full `inputs_json` on ENTRY / EXIT / ADMIT_REJECT: score components, FSD tier, entry floor, 4H ST slope snapshot (`h4_timing`), timing overlay, `gate_trace`.

```sql
SELECT event_type, ts, reason, inputs_json
FROM decision_records
WHERE engine = 'investor' AND ticker IN ('CRDO','MOD')
ORDER BY ts DESC LIMIT 10;
```

### Tests

33 passing — `worker/investor-4h-timing.test.js`, `worker/investor-reentry-cooldown.test.js`

### Deploy

Worker deploy required. `timed:investor:scores` includes `h4_timing` slope snapshot after next compute.
