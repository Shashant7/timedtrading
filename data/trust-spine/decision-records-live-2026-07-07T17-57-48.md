# Decision records — live forward validation

Generated: 2026-07-07T17:57:48.087Z

## Summary

| Metric | Value | Gate |
|--------|------:|------|
| Total rows | 62 | >= 50 |
| Config epochs | 6 | >= 2 for attribution |
| Engine builds | 13 | informational |
| With config_hash | 30 | 100% |
| With engine_git_sha | 61 | 100% |
| Investor TRIM rows | 0 | > 0 after provenance PR |

## By engine / event

| engine | event_type | n |
|--------|------------|--:|
| investor | ENTRY | 18 |
| investor | EXIT | 12 |
| trader | EXIT | 12 |
| trader | ENTRY | 11 |
| trader | TRIM | 5 |
| investor | ADMIT_REJECT | 2 |
| trader | DEFEND | 2 |

## Verdict

**PARTIAL** — gates not cleared:
- missing config_hash
- missing engine_git_sha
