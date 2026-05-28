# DMARC Ramp Runbook (2026-05-28)

## Current state

```
_dmarc.timed-trading.com  TXT  "v=DMARC1; p=none; sp=none; aspf=r; adkim=r"
```

- `p=none` — monitoring only, no enforcement
- `sp=none` — subdomain policy is also none (inherits parent)
- `aspf=r, adkim=r` — relaxed alignment (typical first step)
- **NO `rua=` reporting endpoint** — we cannot see aggregate reports from receivers, so we have zero visibility into whether legitimate mail is being aligned

DMARC `p=none` went live **2026-05-10** (commit `1803232e`). Today is **2026-05-28** = **+18 days**.

## Ramp schedule (against the user's original plan)

| Milestone | Original target | Status | Action |
| --- | --- | --- | --- |
| +0 wk: `p=none` | 2026-05-10 | ✅ live | (none) |
| **+2 wk: `p=quarantine; pct=25`** | **2026-05-24** | **⚠️ 4 days overdue** | **Flip now** (step 1 below) |
| +3 wk: `p=quarantine` (no pct) | 2026-05-31 | upcoming | Flip 2026-05-31 |
| +4 wk: `p=reject` | 2026-06-07 | upcoming | Flip 2026-06-07 |
| +12 wk: Re-run CF Security Insights | 2026-08-02 | upcoming | Re-scan + triage |
| Annually | 2027-05-10 | upcoming | Rotate security.txt `Expires:` |

The +2/+3/+4 ramp can compress if `rua=` reports are clean for the first week. Don't ratchet up if there's any DKIM/SPF misalignment in the reports.

## Step 1 — flip to `p=quarantine; pct=25` + add `rua=` (do NOW)

The DNS edit lives in Cloudflare. Worker code can't make this change.

### What to put in the DNS record

```
Name:  _dmarc.timed-trading.com
Type:  TXT
Value: v=DMARC1; p=quarantine; sp=quarantine; pct=25; aspf=r; adkim=r; rua=mailto:dmarc-reports@timed-trading.com; ruf=mailto:dmarc-reports@timed-trading.com; fo=1
TTL:   1 hour (3600)
```

Changes from current:
- `p=none` → `p=quarantine` — receivers will start sending suspicious mail to spam for 25% of failing messages
- `sp=none` → `sp=quarantine` — subdomain policy matches parent
- Added `pct=25` — only quarantine 25% of failures while we ramp
- Added `rua=mailto:dmarc-reports@timed-trading.com` — aggregate reports (XML) sent to this address daily
- Added `ruf=mailto:dmarc-reports@timed-trading.com` — forensic per-failure reports
- Added `fo=1` — forensic on any (SPF or DKIM) failure, not just both

### Prerequisites

1. **Create the alias** `dmarc-reports@timed-trading.com` first (Cloudflare Email Routing, Google Workspace alias, or any other inbox). It can forward to the operator's primary inbox — Gmail handles the inbound XML reports fine.

2. **Optional but recommended**: register the domain with a free DMARC reporting service (Postmark DMARC Digests, Valimail, or DMARC.org's tools). They parse the XML and email you a human-readable digest. Without that, you'll just see XML attachments daily.

### Steps in Cloudflare

1. Cloudflare dashboard → DNS → Records → search `_dmarc`
2. Edit the existing TXT record
3. Replace the value with the string above
4. Save
5. Verify within 1 minute: `dig +short TXT _dmarc.timed-trading.com`

## Step 2 — flip to `p=quarantine` (no pct) at +3 wk (2026-05-31)

Only if Step 1's first 5-7 days of `rua=` reports show:
- Zero unexpected DKIM failures from owned senders (SendGrid, Cloudflare Email Routing, anything that sends FROM @timed-trading.com)
- SPF alignment >95% on owned mail
- Forensic reports (if any) are all attributed to spoofers, not legitimate senders

Then change `pct=25` to `pct=100` (or just remove the `pct` parameter — both are equivalent):

```
v=DMARC1; p=quarantine; sp=quarantine; aspf=r; adkim=r; rua=mailto:dmarc-reports@timed-trading.com; ruf=mailto:dmarc-reports@timed-trading.com; fo=1
```

## Step 3 — flip to `p=reject` at +4 wk (2026-06-07)

Only if Step 2's first 5-7 days are clean. Change `p=quarantine` → `p=reject` + `sp=quarantine` → `sp=reject`:

```
v=DMARC1; p=reject; sp=reject; aspf=r; adkim=r; rua=mailto:dmarc-reports@timed-trading.com; ruf=mailto:dmarc-reports@timed-trading.com; fo=1
```

If you ever want to tighten further (after months at `p=reject` with clean reports), switch `aspf=r` → `aspf=s` (strict SPF alignment) and `adkim=r` → `adkim=s`. Don't do this unless you've verified every legitimate sender uses an exactly-matching From domain.

## Step 4 — re-scan at +12 wk (2026-08-02)

```
1. Cloudflare dashboard → Security → Security Insights → run scan
2. Triage findings against tasks/2026-05-10-cf-security-insights.md (the
   original triage doc shipped with commit 1803232e)
3. Note any new issues in tasks/lessons.md
```

## Step 5 — annual rotation (2027-05-10)

Update `react-app/.well-known/security.txt`:
- `Expires:` to `2028-05-10T00:00:00.000Z`
- Re-deploy frontend

## What goes wrong

| symptom | cause | fix |
| --- | --- | --- |
| Legitimate mail showing up in spam after Step 1 | Owned sender's DKIM is misconfigured | Check Cloudflare Email Routing DKIM CNAMEs; verify SendGrid Sender Authentication is `verified` for the sender domain |
| Zero `rua=` reports arriving | Either receivers aren't sending, or the alias inbox isn't routing | Send yourself a test email FROM the domain to a Gmail/Yahoo address; wait 24h for first batch |
| Burst of forensic `ruf=` reports | Active spoofing campaign against the domain | Good — exactly what `p=reject` later will block. Forward sample to security@ for review. |
| Subdomain mail (e.g. `mail.timed-trading.com`) starts failing | `sp=` policy now applies to subdomain | Add per-subdomain DMARC record at `_dmarc.mail.timed-trading.com` with `p=none` while you triage |

## Automated drift monitor (this PR)

New endpoint `GET /timed/admin/dmarc/posture` returns:
- Current DNS TXT value for `_dmarc.timed-trading.com`
- Parsed policy (p, sp, pct, rua, ruf, aspf, adkim, fo)
- Drift flags vs expected (e.g. `unexpected_relaxation: p went from quarantine to none`)
- Last-seen-posture from KV so the operator can see when the change happened

New cron: daily 13:00 UTC posts a Discord system-alert if any drift flag fires (e.g. someone accidentally reverts the DMARC record).
