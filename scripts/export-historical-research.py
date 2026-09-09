#!/usr/bin/env python3
"""Read existing candle history for the union of ledger and Discovery tickers.

No authentication, broker calls, replays, or data-heal routes. Each read uses
the historical asOfTs route. Checkpoints permit safe restart; unavailable data
remains explicit. Raw inputs belong in an explicitly supplied output directory.
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.parse


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--ledger', required=True)
    p.add_argument('--discovery', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--as-of', required=True, help='UTC ISO timestamp, fixed for all reads')
    p.add_argument('--timeframes', default='D,60')
    p.add_argument('--workers', type=int, default=6)
    a = p.parse_args()
    cutoff = int(dt.datetime.fromisoformat(a.as_of.replace('Z', '+00:00')).timestamp() * 1000)
    ledger = json.loads(Path(a.ledger).read_text())
    discovery = json.loads(Path(a.discovery).read_text())
    symbols = sorted({r['ticker'] for r in ledger['trades'] + discovery['moves']})
    tfs = a.timeframes.split(',')
    if not set(tfs) <= {'15', '30', '60', '240', 'D', 'W', 'M'}:
        p.error('This exporter uses only unrestricted historical timeframe reads')
    out = Path(a.output)
    out.mkdir(parents=True, exist_ok=True)
    endpoint = 'https://timed-trading-ingest.shashant.workers.dev/timed/candles'

    def read(job):
        ticker, tf = job
        dest = out / f'{ticker}-{tf}.json'
        try:
            if dest.exists():
                saved = json.loads(dest.read_text())
                if saved.get('as_of_ts') != cutoff:
                    raise ValueError('Checkpoint has a different as-of timestamp')
            else:
                bars, pages, cursor = {}, [], cutoff
                for _ in range(100):
                    params = dict(ticker=ticker, tf=tf, limit=3000, asOfTs=cursor)
                    url = endpoint + '?' + urllib.parse.urlencode(params)
                    raw = subprocess.run(['curl', '--fail', '-sS', '--max-time', '60', url],
                                         check=True, capture_output=True).stdout
                    payload = json.loads(raw)
                    if payload.get('ok') is not True:
                        raise ValueError('Candle API did not return ok=true')
                    chunk = payload.get('candles', [])
                    pages.append(dict(url=url, sha256=hashlib.sha256(raw).hexdigest(), count=len(chunk)))
                    for b in chunk:
                        ts = int(b['ts'])
                        if ts > cursor:
                            raise ValueError('Candle exceeds requested historical cursor')
                        bars[ts] = b
                    if len(chunk) < 3000:
                        break
                    next_cursor = min(int(b['ts']) for b in chunk) - 1
                    if next_cursor >= cursor:
                        raise ValueError('Historical pagination did not advance')
                    cursor = next_cursor
                else:
                    raise ValueError('Pagination safety limit reached')
                saved = dict(ticker=ticker, tf=tf, as_of_ts=cutoff, pages=pages,
                             candles=[bars[t] for t in sorted(bars)])
                tmp = dest.with_suffix('.tmp')
                tmp.write_text(json.dumps(saved, separators=(',', ':')))
                tmp.replace(dest)
            bars = saved['candles']
            return dict(ticker=ticker, tf=tf, n=len(bars),
                        first_ts=bars[0]['ts'] if bars else None,
                        last_ts=bars[-1]['ts'] if bars else None,
                        file=dest.name, sha256=hashlib.sha256(dest.read_bytes()).hexdigest())
        except Exception as e:
            return dict(ticker=ticker, tf=tf, error=type(e).__name__ + ': ' + str(e)[:250])

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(a.workers, 8))) as pool:
        futures = [pool.submit(read, (s, tf)) for s in symbols for tf in tfs]
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            results.append(result)
            if len(results) % 25 == 0 or result.get('error'):
                print(json.dumps(dict(completed=len(results), total=len(futures), last=result)), flush=True)
    manifest = dict(as_of_ts=cutoff, endpoint=endpoint, timeframes=tfs,
                    ledger_rows=len(ledger['trades']), discovery_rows=len(discovery['moves']),
                    discovery_total_reported=discovery.get('summary', {}).get('total_moves'),
                    symbols=symbols, files=sorted(results, key=lambda r: (r['ticker'], r['tf'])),
                    limitations=['Universe selected from historical trades and detected moves; not an unbiased universe.',
                                 'Candle history can be revised; read time is not proof of point-in-time vintage.',
                                 'A returned candle is not necessarily closed as of its open timestamp.'])
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(dict(files=len(results), errors=sum('error' in r for r in results),
                         candles=sum(r.get('n', 0) for r in results))), flush=True)


if __name__ == '__main__':
    main()
