#!/usr/bin/env bash
# Phase-I combined: baseline + W1 + W2 + W3 (rank-V2 DEFERRED).
#
# V2 was empirically validated but over-filtered during live scoring (3 trades
# vs baseline's 10 on Aug 1-7, 0% WR vs 50%). The calibration was done on
# v10b's post-filtered trade sample, which doesn't represent the live scoring
# distribution. Needs more work before shipping.
#
# This script activates the 3 workstreams that each tested clean in isolation:
#   - W1 (lifecycle): filtered 1 bad re-entry (STX) on v10b Aug smoke
#   - W2 (SHORT gates): inert on bull days, will fire for bear shorts
#   - W3 (MFE exits): new exit rules that cut zero-MFE trades faster
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$DIR/00-baseline.sh"
"$DIR/10-w1-lifecycle.sh"
"$DIR/20-w2-short.sh"
"$DIR/30-w3-mfe-exits.sh"
echo "Phase-I combined (W1+W2+W3, V2 deferred) activated."
