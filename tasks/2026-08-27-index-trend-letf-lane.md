# Index Trend LETF lane (2026-08-27)

## Problem
Day trades (0/1 DTE options) and index swing/trend (SPYU/SPXU shares) were
conflated on `day_trade_letf_plays`. Operator wants them **orthogonal**.

## Lanes

| Lane | Vehicle | Horizon | API field |
|------|---------|---------|-----------|
| Index day trade | 0/1 DTE options | Same session | `day_trade_plays` |
| Index trend | SPYU/SPXU/TQQQ… shares | Days–weeks | `index_trend_plays` |

Signal always on underlying (SPY/QQQ/IWM/DIA). LETF symbols are quote-only
(`EXECUTION_LETF_SYMBOLS`), not scored.

## Index trend entry gates (LONG)
- Index proxy ticker (SPY/QQQ/IWM/DIA)
- NOT chop (`resolveLetfHorizon !== avoid_chop`)
- One of: confluence RIDE/DRIFT LONG, FSD `rally_active`, timing `add_on_dips` /
  `fsd_rally_dip_buy`, compression call opportunity with macro risk-on

## Index trend entry gates (SHORT / inverse LETF)
- Extension exhaustion (`put_opportunity` / `short_opportunity`) OR
  confluence FADE/SHORT aligned

## Management doctrine (stamped on play)
- Wider stop vs day trade (ATR-based on underlying, not premium)
- Trim ladder: 25% at +1R, 25% at +2R, trail remainder
- Add-on-dip: FSD rally + compression → `dca_add` signal
- Exit: month-end target deadline, macro invalidation, or ST flip

## Completed (2026-08-27 follow-up)
- KV paper book (`timed:idx-trend-book:*`, carry, actions ring)
- Today UI strip (`IndexTrendLetfStrip`) + right-rail panel
- Broker mirror via `/bridge/order` on LETF ticker (`index_trend_letf` vehicle)
- */15 cron dispatch (`it_only=1`) during RTH
