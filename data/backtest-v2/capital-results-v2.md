# Capital Backtest v2 — Minute-by-Minute Walk Forward

**Capital inicial:** $1000
**Risk per trade:** 1.0%
**Slippage:** 0.03% round-trip
**Período:** 2024-12-09 → 2026-04-10 (5289 eventos)
**Universo:** SPY + QQQ (native ETF gamma bars)

## Walk-forward: se caminan bars de 1-min desde el touch, detectando SL/TP intra-barra.


## SL/TP tight — SL=0.3%, TP=0.6% (R:R 1:2)

| Estrategia | # Trades | Capital final | Return % | Win% | PF | Expectancy $ | Max DD % | Sharpe | L-Streak |
|---|---|---|---|---|---|---|---|---|---|
| L114_break | 861 | $594.64 | -40.5% | 37% | 0.93 | -0.471 | 64.7% | -0.6 | 49 |
| L115_bounce | 359 | $972.10 | -2.8% | 40.4% | 0.99 | -0.078 | 26.9% | 0 | 16 |
| L121_break | 58 | $1006.90 | +0.7% | 41.4% | 1.02 | 0.119 | 11.5% | 0.25 | 9 |
| ensemble_HIGH_conf | 1242 | $539.46 | -46.1% | 38.1% | 0.93 | -0.371 | 66.9% | -0.49 | 48 |
| ensemble_ALL_tiers | 2469 | $78.89 | -92.1% | 37.7% | 0.87 | -0.373 | 95% | -1.21 | 48 |
| random_control | 2535 | $49.83 | -95% | 37.9% | 0.82 | -0.375 | 95.5% | -1.52 | 13 |

### Monte Carlo shuffle (top strat = L121_break, N=500 shuffles)

- **Mediana:** $1006.90
- **P05:** $1006.90 (5% peor caso)
- **P95:** $1006.90 (5% mejor caso)
- **Ruinas** (drops below $500): 0.0%


## SL/TP medium — SL=0.5%, TP=1.0% (R:R 1:2)

| Estrategia | # Trades | Capital final | Return % | Win% | PF | Expectancy $ | Max DD % | Sharpe | L-Streak |
|---|---|---|---|---|---|---|---|---|---|
| L114_break | 861 | $1610.12 | +61% | 46% | 1.08 | 0.709 | 56.6% | 0.83 | 37 |
| L115_bounce | 359 | $1188.98 | +18.9% | 45.7% | 1.12 | 0.526 | 17.7% | 0.85 | 15 |
| L121_break | 58 | $1234.99 | +23.5% | 56.9% | 1.98 | 4.052 | 9.1% | 4.59 | 9 |
| ensemble_HIGH_conf | 1242 | $2455.20 | +145.5% | 46.9% | 1.11 | 1.172 | 58.2% | 1.08 | 37 |
| ensemble_ALL_tiers | 2469 | $932.75 | -6.7% | 44.5% | 1 | -0.027 | 70% | 0.04 | 37 |
| random_control | 2637 | $71.84 | -92.8% | 41.6% | 0.76 | -0.352 | 93.4% | -1.63 | 14 |

### Monte Carlo shuffle (top strat = ensemble_HIGH_conf, N=500 shuffles)

- **Mediana:** $2455.20
- **P05:** $2455.20 (5% peor caso)
- **P95:** $2455.20 (5% mejor caso)
- **Ruinas** (drops below $500): 0.0%


## SL/TP wide — SL=0.8%, TP=1.6% (R:R 1:2)

| Estrategia | # Trades | Capital final | Return % | Win% | PF | Expectancy $ | Max DD % | Sharpe | L-Streak |
|---|---|---|---|---|---|---|---|---|---|
| L114_break | 861 | $1611.71 | +61.2% | 50.6% | 1.1 | 0.71 | 48.3% | 0.95 | 37 |
| L115_bounce | 359 | $1355.30 | +35.5% | 52.6% | 1.36 | 0.99 | 12% | 1.92 | 13 |
| L121_break | 58 | $1314.46 | +31.4% | 65.5% | 3.52 | 5.422 | 4.5% | 7.67 | 5 |
| ensemble_HIGH_conf | 1242 | $2905.35 | +190.5% | 52.3% | 1.19 | 1.534 | 50.3% | 1.52 | 37 |
| ensemble_ALL_tiers | 2469 | $1631.69 | +63.2% | 49% | 1.05 | 0.256 | 59.4% | 0.45 | 37 |
| random_control | 2634 | $361.31 | -63.9% | 45.6% | 0.89 | -0.242 | 68.5% | -0.8 | 12 |

### Monte Carlo shuffle (top strat = ensemble_HIGH_conf, N=500 shuffles)

- **Mediana:** $2905.35
- **P05:** $2905.35 (5% peor caso)
- **P95:** $2905.35 (5% mejor caso)
- **Ruinas** (drops below $500): 0.0%

