#!/usr/bin/env python3
"""Export existing Timed Trading research data using an environment secret.

Run during environment setup if TIMED_API_KEY is a setup-only secret. The key
is never persisted. This script does not deploy, replay, place orders or alter
configuration. --plan prints the exact reads without requiring a key.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.parse

# Verified against react-app/_worker.js WORKER_ORIGIN and worker/wrangler.toml.
ORIGIN = 'https://timed-trading-ingest.shashant.workers.dev'
ALLOWED_PATHS = {
    '/timed/debug/trades', '/timed/move-discovery',
    '/timed/admin/model-config', '/timed/admin/backtests/run-trades',
    '/timed/admin/runs/detail', '/timed/admin/runs/config',
    '/timed/admin/runs/trade-events', '/timed/admin/runs/direction-accuracy',
}


def read_api(path, params, secret):
    if path not in ALLOWED_PATHS:
        raise ValueError('Route is not in the reviewed read-only export allowlist')
    if not secret or any(c in secret for c in '\r\n\x00'):
        raise ValueError('TIMED_API_KEY is missing or invalid')
    query = urllib.parse.urlencode(params)
    url = ORIGIN + path + ('?' + query if query else '')
    # No -L: a redirect must never forward the credential elsewhere. The header
    # enters curl over stdin, not argv, shell interpolation or a temporary file.
    command = ['curl', '--silent', '--show-error', '--proto', '=https',
               '--connect-timeout', '15', '--max-time', '120',
               '--request', 'GET', '--header', '@-', '--write-out', '\n%{http_code}', url]
    child_env = {k: v for k, v in os.environ.items() if k != 'TIMED_API_KEY'}
    result = subprocess.run(command, input=('X-API-Key: ' + secret + '\n').encode(),
                            capture_output=True, env=child_env)
    if result.returncode:
        # Never forward untrusted stderr or credential-bearing response bodies.
        raise RuntimeError('Transport failed; curl exit ' + str(result.returncode))
    body, _, status = result.stdout.rpartition(b'\n')
    if status != b'200':
        raise RuntimeError('HTTP ' + status.decode(errors='replace')[:3])
    if secret.encode() in body:
        raise RuntimeError('Response reflected the credential; nothing was saved')
    data = json.loads(body)
    if data.get('ok') is False:
        raise RuntimeError('API returned ok=false; response was not saved')
    return url, body, data


def requests_for(run_ids):
    reads = [
        ('trades-raw.json', '/timed/debug/trades', {}),
        ('discovery.json', '/timed/move-discovery', {}),
        ('rank-config.json', '/timed/admin/model-config', {'prefix': 'deep_audit_rank_'}),
        ('setup-config.json', '/timed/admin/model-config', {'prefix': 'deep_audit_tt_'}),
    ]
    for run_id in dict.fromkeys(run_ids):
        # File names never contain a remote-supplied path. The full ID is in the
        # request manifest, with query encoding separate from filesystem naming.
        tag = hashlib.sha256(run_id.encode()).hexdigest()[:20]
        for name, route, limit in [
            ('trades', '/timed/admin/backtests/run-trades', 20000),
            ('detail', '/timed/admin/runs/detail', None),
            ('config', '/timed/admin/runs/config', None),
            ('events', '/timed/admin/runs/trade-events', 50000),
            ('direction', '/timed/admin/runs/direction-accuracy', 10000),
        ]:
            params = {'run_id': run_id}
            if limit:
                params['limit'] = limit
            reads.append((f'run-{tag}-{name}.json', route, params))
    return reads


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--run-id', action='append', default=[])
    parser.add_argument('--plan', action='store_true')
    args = parser.parse_args()
    reads = requests_for(args.run_id)
    if args.plan:
        print(json.dumps({'origin': ORIGIN, 'method': 'GET', 'requests': reads}, indent=2))
        return
    secret = os.environ.get('TIMED_API_KEY', '')
    if not secret:
        parser.error('Configure TIMED_API_KEY as an environment secret; do not pass it as an argument')
    out = Path(args.output)
    repo = Path(__file__).resolve().parents[1]
    if out.resolve() == repo or repo in out.resolve().parents:
        parser.error('Save raw admin exports outside the git checkout')
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = {'origin': ORIGIN, 'started_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                'requests': [], 'limitations': [
                    'Discovery report is a capped cached summary, not the complete mover corpus.',
                    'Run IDs are explicit; repeated backtest arms are not independent trades.',
                    'Returned rank traces/snapshots need timestamp and code/config-vintage checks.',
                    'A full response at the server limit is flagged as possibly truncated.',
                    'No new replay, discovery scan, metrics backfill or data-heal request is issued.',
                ]}
    for name, path, params in reads:
        try:
            url, body, data = read_api(path, params, secret)
            destination = out / name
            with destination.open('wb') as handle:
                os.chmod(destination, 0o600)
                handle.write(body)
            row = {'file': name, 'url': url, 'sha256': hashlib.sha256(body).hexdigest(),
                   'bytes': len(body), 'retrieved_at': dt.datetime.now(dt.timezone.utc).isoformat()}
            for field in ('trades', 'moves', 'events', 'rows', 'items'):
                if isinstance(data.get(field), list):
                    row[field + '_count'] = len(data[field])
                    if params.get('limit') and len(data[field]) >= params['limit']:
                        row['possibly_truncated'] = True
            manifest['requests'].append(row)
            print(json.dumps({k: v for k, v in row.items() if k != 'url'}), flush=True)
        except Exception as error:
            manifest['requests'].append({'file': name, 'error': str(error)[:120]})
            # Stop immediately on failed authentication/transport, retaining the
            # successful checkpoints and no credential in output or manifest.
            print('Export stopped at ' + name + ': ' + type(error).__name__, flush=True)
            break
        finally:
            target = out / 'admin-manifest.json'
            with target.open('w') as handle:
                os.chmod(target, 0o600)
                json.dump(manifest, handle, indent=2)
                handle.write('\n')
    if any('error' in row for row in manifest['requests']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
