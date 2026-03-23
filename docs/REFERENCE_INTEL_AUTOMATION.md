# Reference-Intel Automation

## Scope
Automates the Phase 10 cycle:
- refresh reference-intel artifacts
- run reference drift + CIO drift checks
- run validation matrix
- publish revalidation trigger output

## Runner
- Script: `scripts/run-reference-intel-refresh.sh`
- Main command inside runner:
  - `python3 scripts/reference-intel-refresh.py --run-matrix`

## LaunchAgent (macOS launchd)
- Plist: `scripts/com.timedtrading.reference-intel-refresh.plist`
- Schedule:
  - 06:15 local time
  - 18:15 local time

## Install / Enable
```bash
mkdir -p "$HOME/Library/LaunchAgents"
cp "/Users/shashant/timedtrading/scripts/com.timedtrading.reference-intel-refresh.plist" "$HOME/Library/LaunchAgents/"
launchctl unload "$HOME/Library/LaunchAgents/com.timedtrading.reference-intel-refresh.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.timedtrading.reference-intel-refresh.plist"
launchctl start com.timedtrading.reference-intel-refresh
```

## Verify
```bash
launchctl list | rg "reference-intel-refresh"
```

Check outputs:
- `data/reference-intel/revalidation-trigger-v1.json`
- `data/reference-intel/drift-monitor-v1.json`
- `data/reference-intel/cio-drift-monitor-v1.json`
- `data/reference-intel/validation-go-no-go-v1.json`
- `data/reference-intel/refresh-cron.log`

## Disable
```bash
launchctl unload "$HOME/Library/LaunchAgents/com.timedtrading.reference-intel-refresh.plist"
```

