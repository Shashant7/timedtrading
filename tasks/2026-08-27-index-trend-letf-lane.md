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

## Out of scope (this pass)
- Separate KV paper book for index trend (uses advisory play + model_play path)
- Today UI strip for `index_trend_plays` (API ready first)
- Broker mirror for LETF index trend (shares path exists via play-the-move)
