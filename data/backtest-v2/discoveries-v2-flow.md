# Discovery v2 — Flow Features — 2026-04-17

**Total events:** 5289
**With strike-level flow:** 1230 (23.3%)
**Min N (flow subset):** 50
**Min edge:** 5pp

## Horizon: outcome1h

**Flow subset baseline:** bounce 27.1% | break 34.0%

### Univariate FLOW features (top 20)

| Feature | Bucket | N | bounce% | break% | edge_b | edge_k | signal | OOS ret |
|---|---|---|---|---|---|---|---|---|
| flow_strikeShareOfDay | >=0.05 | 60 | 26.7 | 23.3 | -0.4pp | -10.7pp | BREAK- | 0.23x weak (Ntr=32 Nte=28) |
| flow_strikeShareOfDay | [0.001,0.01) | 277 | 35.0 | 43.3 | +7.9pp | +9.3pp | BREAK+ | 0.72x ✓ (Ntr=99 Nte=178) |
| flow_aggBias | [-0.3,-0.1) | 80 | 35.0 | 31.3 | +7.9pp | -2.7pp | BOUNCE+ | 1.40x ✓ (Ntr=32 Nte=48) |
| flow_highOpenShare | [0.02,0.1) | 73 | 21.9 | 41.1 | -5.2pp | +7.1pp | BREAK+ | 1.76x ✓ (Ntr=17 Nte=56) |
| flow_instShare | [0.005,0.02) | 94 | 34.0 | 36.2 | +7pp | +2.2pp | BOUNCE+ | 0.36x weak (Ntr=44 Nte=50) |
| flow_dte0Share | [0.3,0.6) | 132 | 33.3 | 32.6 | +6.3pp | -1.4pp | BOUNCE+ | 13.13x ✓ (Ntr=75 Nte=57) |
| flow_highOpenShare | [0.005,0.02) | 181 | 28.7 | 39.8 | +1.7pp | +5.8pp | BREAK+ | 7.33x ✓ (Ntr=71 Nte=110) |

## Horizon: outcome4h

**Flow subset baseline:** bounce 32.4% | break 42.9%

### Univariate FLOW features (top 20)

| Feature | Bucket | N | bounce% | break% | edge_b | edge_k | signal | OOS ret |
|---|---|---|---|---|---|---|---|---|
| flow_strikeShareOfDay | >=0.05 | 60 | 26.7 | 26.7 | -5.7pp | -16.3pp | BREAK- | 1.75x ✓ (Ntr=32 Nte=28) |
| flow_strikeShareOfDay | [0.001,0.01) | 277 | 32.1 | 54.2 | -0.2pp | +11.2pp | BREAK+ | 1.17x ✓ (Ntr=99 Nte=178) |
| flow_instShare | [0.005,0.02) | 94 | 34.0 | 52.1 | +1.7pp | +9.2pp | BREAK+ | 0.05x weak (Ntr=44 Nte=50) |
| flow_dte0Share | [0.3,0.6) | 132 | 34.1 | 34.8 | +1.7pp | -8.1pp | BREAK- | sign flip ✗ (Ntr=75 Nte=57) |
| flow_largestPrem | >=1000000 | 246 | 38.6 | 40.2 | +6.3pp | -2.7pp | BOUNCE+ | 1.03x ✓ (Ntr=99 Nte=147) |
| flow_aggBias | [0.1,0.3) | 103 | 36.9 | 37.9 | +4.5pp | -5.1pp | BREAK- | 0.43x weak (Ntr=61 Nte=42) |

### Bivariate FLOW × CORE (top 25) — 4h horizon

| FlowFeat | Bucket | CoreFeat | Bucket | N | bounce% | break% | edge_b | edge_k | OOS |
|---|---|---|---|---|---|---|---|---|---|
| flow_strikeShareOfDay | [0.001,0.01) | priceRelToOpenPct | >=0.01 | 59 | 28.8 | 62.7 | -3.5pp | +19.8pp | ✓ 0.96x Nte=34 |
| flow_strikeShareOfDay | >=0.05 | minuteBucket | close | 56 | 28.6 | 23.2 | -3.8pp | -19.7pp | ✓ 1.35x Nte=26 |
| flow_largestPrem | [200000,1000000) | vixTrend5d | flat | 55 | 12.7 | 60.0 | -19.6pp | +17.1pp | ✓ 0.81x Nte=33 |
| flow_strikeShareOfDay | [0.001,0.01) | vixBucket | low | 58 | 24.1 | 62.1 | -8.2pp | +19.1pp | ✓ 21.74x Nte=36 |
| flow_strikeShareOfDay | >=0.05 | gammaType | resistance | 58 | 27.6 | 24.1 | -4.8pp | -18.8pp | ✓ 2.26x Nte=26 |
| flow_strikeShareOfDay | >=0.05 | sessionProgress | >=0.9 | 57 | 28.1 | 24.6 | -4.3pp | -18.4pp | ✓ 1.18x Nte=27 |
| flow_strikeShareOfDay | [0.001,0.01) | priceRelToOpenPct | [-0.01,-0.003) | 67 | 20.9 | 61.2 | -11.5pp | +18.3pp | ✓ 1.49x Nte=48 |
| flow_largestPrem | >=1000000 | vixTrend5d | down | 65 | 46.2 | 24.6 | +13.8pp | -18.3pp | ✓ 0.84x Nte=31 |
| flow_strikeShareOfDay | [0.001,0.01) | vixTrend5d | up | 186 | 29.0 | 60.8 | -3.3pp | +17.8pp | weak 0.49x Nte=124 |
| flow_strikeShareOfDay | [0.001,0.01) | vixTrend5d | down | 71 | 49.3 | 28.2 | +16.9pp | -14.8pp | weak 0.10x Nte=36 |
| flow_dte0Share | >=0.6 | vixTrend5d | flat | 106 | 16.0 | 58.5 | -16.3pp | +15.6pp | ✓ 1.20x Nte=64 |
| flow_instShare | <0.005 | vixTrend5d | flat | 110 | 16.4 | 56.4 | -16pp | +13.4pp | ✓ 1.26x Nte=64 |
| flow_strikeShareOfDay | [0.01,0.05) | vixBucket | extreme | 63 | 30.2 | 58.7 | -2.2pp | +15.8pp | ✓ 2.79x Nte=15 |
| flow_strikeShareOfDay | [0.001,0.01) | distSpotToStrikePct | [0.01,0.03) | 75 | 24.0 | 58.7 | -8.4pp | +15.7pp | ✓ 1.31x Nte=43 |
| flow_largestPrem | [200000,1000000) | vixBucket | extreme | 53 | 26.4 | 58.5 | -5.9pp | +15.6pp | ✓ 1.06x Nte=11 |
| flow_aggBias | [-0.1,0.1) | vixTrend5d | flat | 95 | 16.8 | 55.8 | -15.5pp | +12.9pp | ✓ 1.43x Nte=58 |
| flow_strikeShareOfDay | [0.001,0.01) | dominance | <0.2 | 126 | 27.8 | 57.9 | -4.6pp | +15pp | ✓ 0.95x Nte=63 |
| flow_strikeShareOfDay | [0.001,0.01) | sessionProgress | >=0.9 | 170 | 28.8 | 57.6 | -3.5pp | +14.7pp | ✓ 0.88x Nte=98 |
| flow_strikeShareOfDay | [0.001,0.01) | sym | QQQ | 141 | 29.8 | 57.4 | -2.6pp | +14.5pp | ✓ 2.72x Nte=108 |
| flow_strikeShareOfDay | [0.001,0.01) | oiRatio | [0.3,0.5) | 63 | 23.8 | 57.1 | -8.5pp | +14.2pp | flip Nte=51 |
| flow_strikeShareOfDay | [0.001,0.01) | oiRatio | <0.3 | 126 | 30.2 | 57.1 | -2.2pp | +14.2pp | weak 0.43x Nte=63 |
| flow_strikeShareOfDay | [0.001,0.01) | distSpotToStrikePct | [-0.03,-0.01) | 51 | 33.3 | 56.9 | +1pp | +13.9pp | ✓ 1.49x Nte=33 |
| flow_aggBias | [-0.1,0.1) | vixBucket | extreme | 95 | 29.5 | 56.8 | -2.9pp | +13.9pp | ✓ 2.40x Nte=20 |
| flow_strikeShareOfDay | [0.01,0.05) | sessionProgress | [0.7,0.9) | 239 | 31.4 | 56.5 | -1pp | +13.6pp | ✓ 1.43x Nte=155 |
| flow_strikeShareOfDay | [0.001,0.01) | minuteBucket | close | 156 | 29.5 | 56.4 | -2.9pp | +13.5pp | ✓ 0.65x Nte=89 |

## Horizon: outcomeEod

**Flow subset baseline:** bounce 34.0% | break 42.4%

### Univariate FLOW features (top 20)

| Feature | Bucket | N | bounce% | break% | edge_b | edge_k | signal | OOS ret |
|---|---|---|---|---|---|---|---|---|
| flow_strikeShareOfDay | >=0.05 | 60 | 33.3 | 23.3 | -0.7pp | -19pp | BREAK- | 1.41x ✓ (Ntr=32 Nte=28) |
| flow_strikeShareOfDay | [0.001,0.01) | 277 | 35.0 | 53.4 | +1pp | +11.1pp | BREAK+ | 0.88x ✓ (Ntr=99 Nte=178) |
| flow_instShare | [0.005,0.02) | 94 | 29.8 | 51.1 | -4.2pp | +8.7pp | BREAK+ | sign flip ✗ (Ntr=44 Nte=50) |
| flow_aggBias | [-0.3,-0.1) | 80 | 40.0 | 42.5 | +6pp | +0.1pp | BOUNCE+ | 2.20x ✓ (Ntr=32 Nte=48) |
| flow_dte0Share | [0.3,0.6) | 132 | 33.3 | 36.4 | -0.7pp | -6pp | BREAK- | sign flip ✗ (Ntr=75 Nte=57) |
| flow_highOpenShare | [0.02,0.1) | 73 | 37.0 | 37.0 | +3pp | -5.4pp | BREAK- | sign flip ✗ (Ntr=17 Nte=56) |

