#!/usr/bin/env python3
"""
Backfill TradingView CSV exports into D1 ticker_candles.

Usage:
  python3 scripts/backfill-tv-exports.py

Reads CSV files from 'TV Exports/' folder for RTY1! and YM1! (and DIA if present),
generates batch SQL, and executes via wrangler d1 execute.
"""

import csv
import subprocess
import sys
import os
import time

TV_EXPORTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "TV Exports")
DB_NAME = "timed-trading-ledger"

# Map CSV filename patterns to (ticker, tf) pairs
FILE_MAP = {
    "CME_MINI_RTY1!": "RTY1!",
    "CBOT_MINI_YM1!": "YM1!",
    "AMEX_DIA": "DIA",
}

TF_MAP = {
    "1": "1",
    "3": "3",
    "5": "5",
    "10": "10",
    "30": "30",
    "60": "60",
    "240": "240",
    "1D": "D",
    "1W": "W",
    "1M": "M",
}

# D1 batch limit: max statements per execute
# Using --file mode, so we can push larger batches
BATCH_SIZE = 500

def parse_csv_file(filepath):
    """Parse a TV export CSV file. Returns list of (ts_ms, o, h, l, c)."""
    rows = []
    with open(filepath, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ts_sec = int(row["time"])
            ts_ms = ts_sec * 1000
            o = float(row["open"])
            h = float(row["high"])
            l = float(row["low"])
            c = float(row["close"])
            rows.append((ts_ms, o, h, l, c))
    return rows


def build_sql_batch(ticker, tf, rows):
    """Build INSERT OR REPLACE SQL statements for a batch of rows."""
    now_ms = int(time.time() * 1000)
    stmts = []
    for ts_ms, o, h, l, c in rows:
        stmt = (
            f"INSERT INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at) "
            f"VALUES ('{ticker}', '{tf}', {ts_ms}, {o}, {h}, {l}, {c}, NULL, {now_ms}) "
            f"ON CONFLICT(ticker, tf, ts) DO UPDATE SET "
            f"o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, updated_at=excluded.updated_at"
        )
        stmts.append(stmt)
    return stmts


def execute_sql_batch(stmts, dry_run=False):
    """Execute a batch of SQL statements via wrangler d1 execute --file."""
    if dry_run:
        print(f"  [DRY RUN] Would execute {len(stmts)} statements")
        return True

    # Write SQL to temp file to avoid shell escaping issues and size limits
    tmp_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "_backfill_tmp.sql")
    combined = ";\n".join(stmts) + ";"
    with open(tmp_path, "w") as f:
        f.write(combined)

    cmd = [
        "npx", "wrangler", "d1", "execute", DB_NAME,
        "--remote",
        "--file", tmp_path,
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=os.path.dirname(os.path.dirname(__file__)),
        )
        if result.returncode != 0:
            err = result.stderr[:300] if result.stderr else result.stdout[:300]
            print(f"  ERROR: {err}")
            return False
        return True
    except subprocess.TimeoutExpired:
        print("  ERROR: Command timed out")
        return False
    finally:
        try:
            os.remove(tmp_path)
        except:
            pass


def main():
    dry_run = "--dry-run" in sys.argv

    if not os.path.isdir(TV_EXPORTS_DIR):
        print(f"ERROR: TV Exports directory not found: {TV_EXPORTS_DIR}")
        sys.exit(1)

    files = os.listdir(TV_EXPORTS_DIR)
    csv_files = [f for f in files if f.endswith(".csv")]

    # Parse and group
    tasks = []
    for fname in sorted(csv_files):
        # Extract ticker prefix and TF from filename like "CME_MINI_RTY1!, 5_c43af.csv"
        ticker = None
        tf = None
        for prefix, sym in FILE_MAP.items():
            if fname.startswith(prefix):
                ticker = sym
                # Extract TF: after ", " and before "_"
                after_comma = fname[len(prefix):].lstrip(",").strip()
                tf_part = after_comma.split("_")[0].strip()
                tf = TF_MAP.get(tf_part)
                break

        if not ticker or not tf:
            continue

        filepath = os.path.join(TV_EXPORTS_DIR, fname)
        tasks.append((ticker, tf, filepath, fname))

    if not tasks:
        print("No matching CSV files found to backfill.")
        sys.exit(0)

    total_rows = 0
    total_batches = 0
    total_errors = 0

    for ticker, tf, filepath, fname in tasks:
        rows = parse_csv_file(filepath)
        if not rows:
            print(f"  SKIP {fname}: no data rows")
            continue

        print(f"\n{ticker} tf={tf}: {len(rows)} candles from {fname}")
        stmts = build_sql_batch(ticker, tf, rows)

        # Execute in batches
        for i in range(0, len(stmts), BATCH_SIZE):
            batch = stmts[i : i + BATCH_SIZE]
            batch_num = i // BATCH_SIZE + 1
            total_batches_for_file = (len(stmts) + BATCH_SIZE - 1) // BATCH_SIZE
            sys.stdout.write(f"  Batch {batch_num}/{total_batches_for_file} ({len(batch)} rows)...")
            sys.stdout.flush()

            ok = execute_sql_batch(batch, dry_run=dry_run)
            if ok:
                print(" OK")
                total_rows += len(batch)
            else:
                print(" FAILED")
                total_errors += 1
            total_batches += 1

    print(f"\n{'='*50}")
    print(f"Done! {total_rows} rows inserted across {total_batches} batches, {total_errors} errors")
    if dry_run:
        print("(DRY RUN — no actual writes)")


if __name__ == "__main__":
    main()
