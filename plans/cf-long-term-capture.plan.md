# CF long-term capture — replicate compounder dip buys

## Live CF forensic (2026-07-23)

| Field | Value |
|---|---|
| Entry | 2026-07-15 @ $115.90 · 43.14 sh (~$5k) |
| Path | `compounder_dip_buy:growth_strong:weekly_pullback_monthly_intact\|intraday_pullback` |
| Score / zone | 64 · `momentum_runner_exhausted` |
| Now | ~$127 · ~+10% · FV ~$147 discount · FSD strong (GRNY/GRNI) |
| Gaps | D1 `thesis`/`thesis_invalidation` null; DCA monthly calendar-only (0 adds); book often full |

## Replication levers

1. **Confirmed dips** — `detectCompounderDipBuy` requires ≥2 signals; exhausted zones also need a structural signal (not lone `-2%` days).
2. **Exhaustion order** — evaluate `momentum_runner_exhausted` before the broad compounder lane; allow `growth_elite` **and** `growth_strong` override on confirmed structural dips (CF shape).
3. **Persist thesis on auto-open** — write `thesis` / `thesis_invalidation` / stageReason notes from score row (manual BUY path already does).
4. **Pullback DCA** — for FSD / compounder / FV-discount holds, allow opportunistic DCA on confirmed dips (min 5d gap), not only calendar `dca_next_ts`.
5. **Provenance (calibration loop)** — every Long Term ENTRY/ADD/DCA writes
   rich `decision_records.inputs_json` via `buildInvestorDecisionInputs`
   (scoreRow → compounder/dip/FV/thesis/RS/timing/CIO). Position also
   stamps `entry_provenance_json`. Heal backfills blanks from scores.
6. **Short Term parity** — same quality-dip shape softens trader pullback
   RSI-exhaust + non-prime rank floors so multi-day rips (CF +10%) can
   print on the Short Term book too (`isQualityCompounderDip`).
7. **Model open-lane bars** — defend/trim/hold cards without a live book
   row are ghost stages; drop them (or sticky-exit) so POSITION bars
   always pair with Open Long/Short.
