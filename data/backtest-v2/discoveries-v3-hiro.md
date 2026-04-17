# Discovery v3 — HIRO Features

**Events with HIRO data:** 4213/7850
**Split:** train <2025-10-01, test >=2025-10-01


## Horizon: outcome1h

Baseline: bounce 24.6% / break 26.7% (N=4213)

### HIRO univariate top 20

| Feature | Bucket | N | bounce% | break% | eb | ek | signal | OOS retention |
|---|---|---|---|---|---|---|---|---|
| hiro_extreme_count | >=3 | 131 | 23.7 | 43.5 | -1pp | +16.9pp | BREAK+ | ✓ 0.65x (Ntr=64/Nte=67) |
| hiro_qqq_delta_1h | [-10,10) | 283 | 29.7 | 41.7 | +5.1pp | +15pp | BREAK+ | ✓ 0.7x (Ntr=112/Nte=171) |
| hiro_extreme_count | [2,3) | 473 | 21.8 | 41.2 | -2.8pp | +14.6pp | BREAK+ | weak 0.47x |
| hiro_qqq_pctl | <-70 | 235 | 18.3 | 40.9 | -6.3pp | +14.2pp | BREAK+ | weak 0.47x |
| hiro_spy_pctl | >=70 | 274 | 28.1 | 39.8 | +3.5pp | +13.1pp | BREAK+ | ✓ 0.7x (Ntr=131/Nte=143) |
| hiro_spy_pctl | <-70 | 286 | 18.5 | 39.5 | -6.1pp | +12.9pp | BREAK+ | weak 0.46x |
| hiro_spy_pctl | [-30,0) | 217 | 26.7 | 39.2 | +2.1pp | +12.5pp | BREAK+ | weak 0.15x |
| hiro_avg_pctl | [-20,0) | 430 | 23.0 | 39.1 | -1.6pp | +12.4pp | BREAK+ | ✓ 0.61x (Ntr=202/Nte=228) |
| hiro_spx_pctl | <-70 | 396 | 25.0 | 38.1 | +0.4pp | +11.5pp | BREAK+ | weak 0.1x |
| hiro_consensus | bearish | 880 | 24.8 | 38.1 | +0.2pp | +11.4pp | BREAK+ | weak 0.27x |
| hiro_spy_pctl | [-70,-30) | 268 | 21.6 | 37.3 | -3pp | +10.7pp | BREAK+ | ✓ 0.84x (Ntr=118/Nte=150) |
| hiro_qqq_pctl | [-70,-30) | 290 | 27.9 | 37.2 | +3.3pp | +10.6pp | BREAK+ | weak 0.49x |
| hiro_qqq_delta_1h | >=30 | 532 | 24.1 | 37.0 | -0.6pp | +10.4pp | BREAK+ | ✓ 1.49x (Ntr=243/Nte=289) |
| hiro_qqq_delta_1h | <-30 | 478 | 21.8 | 37.0 | -2.9pp | +10.4pp | BREAK+ | weak 0.46x |
| hiro_spx_delta_1h | [10,30) | 198 | 19.7 | 36.9 | -4.9pp | +10.2pp | BREAK+ | ✓ 2.57x (Ntr=82/Nte=116) |
| hiro_qqq_delta_1h | [10,30) | 93 | 34.4 | 17.2 | +9.8pp | -9.5pp | BOUNCE+ | weak 0.32x |
| hiro_spx_pctl | >=70 | 380 | 22.9 | 36.3 | -1.7pp | +9.7pp | BREAK+ | ✓ 1.37x (Ntr=188/Nte=192) |
| hiro_spy_pctl | [0,30) | 206 | 21.8 | 35.9 | -2.8pp | +9.3pp | BREAK+ | ✓ 9.87x (Ntr=86/Nte=120) |
| hiro_spx_delta_1h | <-30 | 653 | 26.5 | 36.0 | +1.9pp | +9.3pp | BREAK+ | weak 0.29x |
| hiro_qqq_pctl | >=70 | 329 | 28.3 | 35.9 | +3.7pp | +9.2pp | BREAK+ | ✓ 0.5x (Ntr=140/Nte=189) |

## Horizon: outcome4h

Baseline: bounce 35.0% / break 36.4% (N=4213)

### HIRO univariate top 20

| Feature | Bucket | N | bounce% | break% | eb | ek | signal | OOS retention |
|---|---|---|---|---|---|---|---|---|
| hiro_qqq_pctl | <-70 | 235 | 21.3 | 52.8 | -13.7pp | +16.3pp | BREAK+ | ✓ 0.88x (Ntr=103/Nte=132) |
| hiro_spy_pctl | [-30,0) | 217 | 24.0 | 52.1 | -11pp | +15.6pp | BREAK+ | weak 0.33x |
| hiro_qqq_delta_1h | [-10,10) | 283 | 31.8 | 51.6 | -3.2pp | +15.2pp | BREAK+ | ✓ 1.69x (Ntr=112/Nte=171) |
| hiro_spx_pctl | <-70 | 396 | 31.8 | 50.3 | -3.1pp | +13.8pp | BREAK+ | ✓ 0.89x (Ntr=199/Nte=197) |
| hiro_qqq_pctl | [0,30) | 179 | 32.4 | 49.7 | -2.6pp | +13.3pp | BREAK+ | ✓ 1.01x (Ntr=91/Nte=88) |
| hiro_spy_pctl | <-70 | 286 | 27.6 | 49.3 | -7.3pp | +12.9pp | BREAK+ | ✓ 0.69x (Ntr=143/Nte=143) |
| hiro_avg_pctl | [-50,-20) | 445 | 28.1 | 49.0 | -6.9pp | +12.6pp | BREAK+ | ✓ 1.68x (Ntr=229/Nte=216) |
| hiro_qqq_pctl | [-70,-30) | 290 | 30.7 | 48.6 | -4.3pp | +12.2pp | BREAK+ | ✓ 0.72x (Ntr=148/Nte=142) |
| hiro_consensus | bearish | 880 | 28.1 | 48.1 | -6.9pp | +11.6pp | BREAK+ | ✓ 0.97x (Ntr=439/Nte=441) |
| hiro_extreme_count | [2,3) | 473 | 31.9 | 48.0 | -3pp | +11.6pp | BREAK+ | ✓ 0.58x (Ntr=233/Nte=240) |
| hiro_spx_delta_1h | [10,30) | 198 | 26.8 | 48.0 | -8.2pp | +11.5pp | BREAK+ | ✓ 2.31x (Ntr=82/Nte=116) |
| hiro_extreme_count | >=3 | 131 | 24.4 | 47.3 | -10.5pp | +10.9pp | BREAK+ | ✓ 1.12x (Ntr=64/Nte=67) |
| hiro_spy_pctl | [-70,-30) | 268 | 28.7 | 46.6 | -6.2pp | +10.2pp | BREAK+ | ✓ 1.68x (Ntr=118/Nte=150) |
| hiro_spx_delta_1h | <-30 | 653 | 33.1 | 45.0 | -1.9pp | +8.6pp | BREAK+ | ✓ 1.25x (Ntr=283/Nte=370) |
| hiro_spy_pctl | >=70 | 274 | 31.4 | 44.5 | -3.6pp | +8.1pp | BREAK+ | ✓ 0.53x (Ntr=131/Nte=143) |
| hiro_qqq_delta_1h | <-30 | 478 | 29.7 | 44.4 | -5.3pp | +7.9pp | BREAK+ | weak 0.34x |
| hiro_qqq_delta_1h | [-30,-10) | 93 | 31.2 | 44.1 | -3.8pp | +7.7pp | BREAK+ | weak -0.06x |
| hiro_avg_pctl | [-20,0) | 430 | 32.3 | 43.7 | -2.6pp | +7.3pp | BREAK+ | ✓ 0.93x (Ntr=202/Nte=228) |
| hiro_avg_pctl | <-50 | 231 | 34.2 | 43.3 | -0.8pp | +6.9pp | BREAK+ | weak 0.44x |
| hiro_qqq_pctl | [-30,0) | 201 | 40.8 | 33.3 | +5.8pp | -3.1pp | BOUNCE+ | ✓ 2.62x (Ntr=69/Nte=132) |

### Bivariate HIRO × Context (top 30)

| F1 | B1 | F2 | B2 | N | b% | br% | eb | ek | OOS |
|---|---|---|---|---|---|---|---|---|---|
| hiro_qqq_delta_1h | <-30 | vixBucket | high | 67 | 7.5 | 79.1 | -27.5pp | +42.7pp | ✓ 0.68x Nte=37 |
| hiro_avg_pctl | [-20,0) | vixBucket | extreme | 56 | 7.1 | 78.6 | -27.8pp | +42.1pp | ✓ 1.03x Nte=11 |
| hiro_spy_pctl | [-30,0) | priceRelToOpenPct | >=0.01 | 73 | 9.6 | 76.7 | -25.4pp | +40.3pp | ✓ 0.77x Nte=41 |
| hiro_extreme_count | [2,3) | vixBucket | extreme | 67 | 17.9 | 71.6 | -17.1pp | +35.2pp | ✓ 0.6x Nte=5 |
| hiro_spy_pctl | [-30,0) | distSpotToStrikePct | [-0.03,-0.01) | 64 | 17.2 | 70.3 | -17.8pp | +33.9pp | ✓ 0.6x Nte=43 |
| hiro_qqq_pctl | [-30,0) | vixBucket | mid | 51 | 68.6 | 11.8 | +33.7pp | -24.7pp | weak -1.02x Nte=50 |
| hiro_spy_pctl | [0,30) | vixBucket | mid | 63 | 68.3 | 12.7 | +33.3pp | -23.7pp | ✓ 3.58x Nte=49 |
| hiro_qqq_pctl | [-70,-30) | vixBucket | high | 73 | 16.4 | 68.5 | -18.5pp | +32.1pp | weak 0.46x Nte=48 |
| hiro_avg_pctl | [-20,0) | minuteBucket | aft | 91 | 22.0 | 67.0 | -13pp | +30.6pp | ✓ 1.54x Nte=50 |
| hiro_qqq_pctl | <-70 | flow_strikeShareOfDay | [0.001,0.01) | 60 | 18.3 | 66.7 | -16.6pp | +30.2pp | ✓ 0.64x Nte=34 |
| hiro_spy_pctl | [-30,0) | flow_strikeShareOfDay | [0.001,0.01) | 58 | 20.7 | 65.5 | -14.3pp | +29.1pp | ✓ 1.2x Nte=35 |
| hiro_spy_pctl | [-70,-30) | flow_strikeShareOfDay | [0.001,0.01) | 61 | 26.2 | 65.6 | -8.7pp | +29.1pp | ✓ 1.92x Nte=27 |
| hiro_spx_pctl | <-70 | vixBucket | high | 72 | 18.1 | 65.3 | -16.9pp | +28.8pp | weak 0.46x Nte=39 |
| hiro_consensus | bearish | vixBucket | high | 148 | 20.3 | 64.2 | -14.7pp | +27.8pp | ✓ 0.55x Nte=107 |
| hiro_consensus | mixed | minuteBucket | aft | 81 | 27.2 | 64.2 | -7.8pp | +27.8pp | ✓ 1.25x Nte=44 |
| hiro_avg_pctl | [-50,-20) | priceRelToOpenPct | [-0.003,0.003) | 71 | 19.7 | 63.4 | -15.2pp | +26.9pp | ✓ 1.48x Nte=39 |
| hiro_avg_pctl | [-50,-20) | minuteBucket | aft | 98 | 31.6 | 63.3 | -3.3pp | +26.8pp | ✓ 6.03x Nte=64 |
| hiro_avg_pctl | [-20,0) | priceRelToOpenPct | >=0.01 | 89 | 16.9 | 62.9 | -18.1pp | +26.5pp | ✓ 1.49x Nte=43 |
| hiro_qqq_delta_1h | [-10,10) | priceRelToOpenPct | [0.003,0.01) | 83 | 21.7 | 62.7 | -13.3pp | +26.2pp | ✓ 1.61x Nte=48 |
| hiro_avg_pctl | [-20,0) | distSpotToStrikePct | [-0.03,-0.01) | 72 | 20.8 | 62.5 | -14.1pp | +26.1pp | ✓ 1.65x Nte=44 |
| hiro_spy_pctl | [-70,-30) | minuteBucket | aft | 79 | 30.4 | 62.0 | -4.6pp | +25.6pp | ✓ 4.12x Nte=45 |
| hiro_qqq_pctl | [30,70) | minuteBucket | aft | 73 | 27.4 | 61.6 | -7.6pp | +25.2pp | ✓ 1.16x Nte=42 |
| hiro_consensus | bearish | minuteBucket | aft | 185 | 27.0 | 61.6 | -7.9pp | +25.2pp | ✓ 3.4x Nte=104 |
| hiro_extreme_count | [1,2) | vixBucket | high | 86 | 25.6 | 61.6 | -9.4pp | +25.2pp | ✓ 0.65x Nte=61 |
| hiro_qqq_pctl | <-70 | distSpotToStrikePct | [0.01,0.03) | 54 | 22.2 | 61.1 | -12.7pp | +24.7pp | ✓ 1.17x Nte=33 |
| hiro_spx_pctl | [-70,-30) | minuteBucket | aft | 85 | 28.2 | 61.2 | -6.7pp | +24.7pp | ✓ 0.94x Nte=47 |
| hiro_spy_pctl | >=70 | distSpotToStrikePct | [0.01,0.03) | 77 | 24.7 | 61.0 | -10.3pp | +24.6pp | ✓ 0.58x Nte=46 |
| hiro_avg_pctl | [-50,-20) | vixBucket | high | 69 | 21.7 | 60.9 | -13.2pp | +24.4pp | ✓ 0.51x Nte=57 |
| hiro_spy_pctl | [-30,0) | approach | up | 119 | 13.4 | 60.5 | -21.5pp | +24.1pp | weak 0.39x Nte=64 |
| hiro_qqq_pctl | <-70 | priceRelToOpenPct | <-0.01 | 53 | 20.8 | 60.4 | -14.2pp | +23.9pp | ✓ 0.81x Nte=32 |

## Horizon: outcomeEod

Baseline: bounce 39.6% / break 42.9% (N=4213)

### HIRO univariate top 20

| Feature | Bucket | N | bounce% | break% | eb | ek | signal | OOS retention |
|---|---|---|---|---|---|---|---|---|
| hiro_extreme_count | >=3 | 131 | 22.9 | 51.1 | -16.7pp | +8.3pp | BOUNCE- | ✓ 0.84x (Ntr=64/Nte=67) |
| hiro_spy_pctl | [-30,0) | 217 | 23.5 | 56.2 | -16.1pp | +13.3pp | BOUNCE- | weak 0.43x |
| hiro_qqq_pctl | <-70 | 235 | 25.1 | 54.9 | -14.5pp | +12pp | BOUNCE- | ✓ 0.58x (Ntr=103/Nte=132) |
| hiro_qqq_delta_1h | [10,30) | 93 | 36.6 | 30.1 | -3.1pp | -12.8pp | BREAK- | ✓ 0.74x (Ntr=45/Nte=48) |
| hiro_avg_pctl | [-50,-20) | 445 | 27.6 | 47.2 | -12pp | +4.3pp | BOUNCE- | ✓ 2.64x (Ntr=229/Nte=216) |
| hiro_qqq_pctl | [-30,0) | 201 | 39.3 | 31.8 | -0.3pp | -11.1pp | BREAK- | ✓ 1.35x (Ntr=69/Nte=132) |
| hiro_consensus | bearish | 880 | 28.5 | 48.4 | -11.1pp | +5.5pp | BOUNCE- | ✓ 1.2x (Ntr=439/Nte=441) |
| hiro_spy_pctl | <-70 | 286 | 28.7 | 49.0 | -11pp | +6.1pp | BOUNCE- | weak 0.19x |
| hiro_qqq_delta_1h | <-30 | 478 | 29.5 | 46.0 | -10.1pp | +3.1pp | BOUNCE- | weak 0.33x |
| hiro_spx_delta_1h | [10,30) | 198 | 29.8 | 48.5 | -9.8pp | +5.6pp | BOUNCE- | weak 0.49x |
| hiro_spx_delta_1h | [-30,-10) | 153 | 35.3 | 33.3 | -4.3pp | -9.6pp | BREAK- | ✓ 2.82x (Ntr=75/Nte=78) |
| hiro_spy_pctl | [0,30) | 206 | 40.3 | 33.5 | +0.7pp | -9.4pp | BREAK- | weak 0.03x |
| hiro_spx_pctl | <-70 | 396 | 30.3 | 49.2 | -9.3pp | +6.4pp | BOUNCE- | ✓ 1.08x (Ntr=199/Nte=197) |
| hiro_spx_pctl | [-70,-30) | 372 | 30.6 | 43.3 | -9pp | +0.4pp | BOUNCE- | ✓ 3.36x (Ntr=198/Nte=174) |
| hiro_spy_pctl | [-70,-30) | 268 | 31.3 | 44.8 | -8.3pp | +1.9pp | BOUNCE- | ✓ 2.43x (Ntr=118/Nte=150) |
| hiro_spx_pctl | [-30,0) | 172 | 31.4 | 39.0 | -8.2pp | -3.9pp | BOUNCE- | ✓ 0.92x (Ntr=77/Nte=95) |
| hiro_qqq_pctl | [30,70) | 245 | 31.4 | 46.1 | -8.2pp | +3.2pp | BOUNCE- | ✓ 12.75x (Ntr=126/Nte=119) |
| hiro_avg_pctl | [0,20) | 401 | 31.7 | 45.6 | -8pp | +2.7pp | BOUNCE- | weak 0.35x |
| hiro_qqq_pctl | [-70,-30) | 290 | 31.7 | 43.1 | -7.9pp | +0.2pp | BOUNCE- | ✓ 0.52x (Ntr=148/Nte=142) |
| hiro_spx_delta_1h | <-30 | 653 | 31.9 | 45.2 | -7.8pp | +2.3pp | BOUNCE- | ✓ 6.89x (Ntr=283/Nte=370) |
