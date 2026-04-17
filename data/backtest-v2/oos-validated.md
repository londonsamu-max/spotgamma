# OOS Validation Report — 2026-04-17

**Split date:** 2025-10-01
**Train N:** 2804 events (2024-12-09 → 2025-09-30)
**Test N:**  2485 events (2025-10-01 → 2026-04-10)
**Min N train:** 100 | **Min N test:** 40
**Min edge train:** 5pp | **Edge retention:** ≥50%

Survivors = rules where edge direction persists AND test-edge ≥ 50% of train-edge.

## Horizon: outcome1h

Train baseline: bounce 24.3% / break 25.4% / flat 50.4%
Test baseline:  bounce 24.1% / break 28.2% / flat 47.6%

### Univariate survivors (52)

| Feature | Bucket | Ntr | Nte | bounce_tr | bounce_te | break_tr | break_te | edge_tr | edge_te | retention | signal |
|---|---|---|---|---|---|---|---|---|---|---|---|
| vixLevel | <15 | 246 | 162 | 13.4 | 18.5 | 18.3 | 9.9 | -10.8pp | -5.6pp | 0.52x | BOUNCE- |
| vixBucket | v_low | 246 | 162 | 13.4 | 18.5 | 18.3 | 9.9 | -10.8pp | -5.6pp | 0.52x | BOUNCE- |
| distToZeroGammaPct | [-0.05,-0.02) | 159 | 83 | 10.1 | 13.3 | 11.3 | 12.0 | -14.2pp | -10.9pp | 0.76x | BOUNCE- |
| sessionProgress | [0.1,0.3) | 123 | 166 | 26.0 | 25.3 | 13.8 | 13.3 | -11.6pp | -15pp | 1.30x | BREAK- |
| minuteBucket | morn | 223 | 251 | 22.9 | 25.1 | 19.3 | 14.3 | -6.1pp | -13.9pp | 2.28x | BREAK- |
| priceRelToOpenPct | <-0.01 | 321 | 293 | 40.5 | 31.1 | 31.8 | 42.0 | +16.2pp | +7pp | Xx | BOUNCE+ |
| distSpotToStrikePct | [0.01,0.03) | 316 | 297 | 36.1 | 31.6 | 33.9 | 41.8 | +11.8pp | +7.5pp | 0.64x | BOUNCE+ |
| sessionProgress | [0.7,0.9) | 406 | 409 | 31.3 | 28.6 | 39.4 | 40.6 | +14pp | +12.3pp | 0.88x | BREAK+ |
| oiRatio | >=0.7 | 469 | 317 | 17.5 | 18.0 | 14.7 | 16.1 | -10.7pp | -12.2pp | 1.14x | BREAK- |
| vixLevel | [25,30) | 157 | 399 | 30.6 | 30.1 | 48.4 | 40.1 | +23pp | +11.9pp | 0.51x | BREAK+ |
| vixBucket | high | 157 | 399 | 30.6 | 30.1 | 48.4 | 40.1 | +23pp | +11.9pp | 0.51x | BREAK+ |
| sessionRangeBeforeTouchPct | <0.003 | 572 | 515 | 11.9 | 12.4 | 11.0 | 19.8 | -14.4pp | -8.4pp | 0.59x | BREAK- |
| minuteBucket | aft | 482 | 478 | 31.1 | 28.2 | 37.1 | 39.7 | +11.7pp | +11.5pp | 0.98x | BREAK+ |
| sessionRangeBeforeTouchPct | >=0.015 | 542 | 433 | 35.6 | 29.3 | 36.0 | 38.6 | +11.4pp | +5.2pp | Xx | BOUNCE+ |
| regime | neutral | 201 | 233 | 17.9 | 23.6 | 25.4 | 18.0 | -6.3pp | -0.5pp | Xx | BOUNCE- |
| daysToOpex | [3,7) | 226 | 201 | 22.1 | 33.8 | 14.2 | 18.4 | -11.2pp | -9.8pp | 0.88x | BREAK- |
| distToCallWallPct | [-0.05,-0.02) | 665 | 561 | 29.3 | 28.7 | 31.9 | 37.6 | +6.5pp | +9.4pp | 1.44x | BREAK+ |
| barsWithin1Pct | <2 | 302 | 57 | 34.1 | 33.3 | 32.8 | 26.3 | +9.9pp | +9.2pp | 0.94x | BOUNCE+ |
| distToCallWallPct | <-0.05 | 363 | 99 | 40.2 | 26.3 | 32.0 | 36.4 | +16pp | +2.2pp | Xx | BOUNCE+ |
| distToCallWallPct | [0,0.02) | 574 | 439 | 17.8 | 21.6 | 20.4 | 20.3 | -6.5pp | -2.5pp | Xx | BOUNCE- |
| priceRelToOpenPct | [-0.01,-0.003) | 573 | 475 | 32.5 | 32.0 | 31.1 | 34.3 | +8.2pp | +7.9pp | 0.96x | BOUNCE+ |
| sessionProgress | [0.5,0.7) | 257 | 177 | 25.3 | 31.6 | 31.5 | 21.5 | +6.1pp | -6.8pp | Xx | BREAK+ |
| distToPutWallPct | [-0.02,0) | 404 | 306 | 26.7 | 31.4 | 33.7 | 33.3 | +8.3pp | +5.1pp | 0.61x | BREAK+ |
| oiRatio | <0.3 | 717 | 525 | 35.6 | 31.0 | 31.8 | 34.1 | +11.3pp | +6.9pp | 0.61x | BOUNCE+ |
| minuteOfSession | <60 | 841 | 768 | 15.1 | 18.0 | 15.1 | 21.4 | -10.3pp | -6.9pp | 0.67x | BREAK- |

## Horizon: outcome4h

Train baseline: bounce 33.5% / break 36.4% / flat 30.0%
Test baseline:  bounce 35.3% / break 36.4% / flat 28.3%

### Univariate survivors (41)

| Feature | Bucket | Ntr | Nte | bounce_tr | bounce_te | break_tr | break_te | edge_tr | edge_te | retention | signal |
|---|---|---|---|---|---|---|---|---|---|---|---|
| vixLevel | >=30 | 252 | 53 | 33.7 | 17.0 | 47.6 | 69.8 | +11.2pp | +33.4pp | 2.99x | BREAK+ |
| vixBucket | extreme | 252 | 53 | 33.7 | 17.0 | 47.6 | 69.8 | +11.2pp | +33.4pp | 2.99x | BREAK+ |
| tltTrend5d | down | 439 | 56 | 35.8 | 62.5 | 44.4 | 19.6 | +8pp | -16.7pp | Xx | BREAK+ |
| vixLevel | [25,30) | 157 | 399 | 35.7 | 30.1 | 54.1 | 53.4 | +17.7pp | +17pp | 0.96x | BREAK+ |
| vixBucket | high | 157 | 399 | 35.7 | 30.1 | 54.1 | 53.4 | +17.7pp | +17pp | 0.96x | BREAK+ |
| sessionProgress | [0.3,0.5) | 174 | 166 | 39.1 | 34.3 | 46.6 | 52.4 | +10.1pp | +16pp | 1.59x | BREAK+ |
| minuteBucket | aft | 482 | 478 | 36.7 | 32.2 | 44.4 | 50.8 | +8pp | +14.5pp | 1.82x | BREAK+ |
| sessionProgress | [0.7,0.9) | 406 | 409 | 36.5 | 32.5 | 43.8 | 50.4 | +7.4pp | +14pp | 1.89x | BREAK+ |
| distToZeroGammaPct | [-0.05,-0.02) | 159 | 83 | 25.2 | 37.3 | 17.6 | 24.1 | -18.8pp | -12.3pp | 0.65x | BREAK- |
| priceRelToOpenPct | >=0.01 | 235 | 218 | 27.2 | 32.1 | 42.6 | 48.2 | -6.3pp | -3.2pp | 0.51x | BOUNCE- |
| vixLevel | <15 | 246 | 162 | 24.4 | 34.6 | 31.3 | 25.3 | -9.1pp | -0.7pp | Xx | BOUNCE- |
| vixBucket | v_low | 246 | 162 | 24.4 | 34.6 | 31.3 | 25.3 | -9.1pp | -0.7pp | Xx | BOUNCE- |
| distSpotToStrikePct | [-0.03,-0.01) | 224 | 220 | 26.8 | 32.3 | 38.4 | 47.3 | -6.7pp | -3pp | Xx | BOUNCE- |
| isOpex | true | 139 | 137 | 35.3 | 45.3 | 43.9 | 29.2 | +7.4pp | -7.2pp | Xx | BREAK+ |
| sessionProgress | <0.1 | 789 | 708 | 27.9 | 33.6 | 28.9 | 27.1 | -7.6pp | -9.3pp | 1.23x | BREAK- |
| gapToNextBarAbovePct | >=0.01 | 274 | 72 | 36.5 | 44.4 | 42.7 | 43.1 | +6.3pp | +6.7pp | 1.07x | BREAK+ |
| minuteBucket | open | 768 | 670 | 27.6 | 33.7 | 28.8 | 27.3 | -7.7pp | -9.1pp | 1.18x | BREAK- |
| distToPutWallPct | [-0.02,0) | 404 | 306 | 38.1 | 43.5 | 44.6 | 27.5 | +8.1pp | -8.9pp | Xx | BREAK+ |
| sessionProgress | [0.5,0.7) | 257 | 177 | 35.4 | 44.1 | 49.0 | 31.1 | +12.6pp | -5.3pp | Xx | BREAK+ |
| barsWithin1Pct | <2 | 302 | 57 | 39.7 | 43.9 | 44.4 | 33.3 | +7.9pp | -3pp | Xx | BREAK+ |
| minuteOfSession | <60 | 841 | 768 | 29.0 | 33.3 | 28.8 | 28.1 | -7.7pp | -8.3pp | 1.08x | BREAK- |
| daysToOpex | [3,7) | 226 | 201 | 31.4 | 43.3 | 30.1 | 31.3 | -6.4pp | -5pp | 0.79x | BREAK- |
| gapToNextBarBelowPct | >=0.01 | 273 | 56 | 39.2 | 42.9 | 45.1 | 37.5 | +8.6pp | +1.1pp | Xx | BREAK+ |
| vixTrend5d | flat | 308 | 200 | 32.8 | 28.0 | 30.8 | 34.0 | -5.6pp | -2.4pp | Xx | BREAK- |
| oiRatio | >=0.7 | 469 | 317 | 24.3 | 28.1 | 27.1 | 29.7 | -9.4pp | -6.7pp | 0.72x | BREAK- |

### Bivariate survivors (136) — using features: vixLevel, vixBucket, tltTrend5d, sessionProgress, minuteBucket, distToZeroGammaPct, priceRelToOpenPct, distSpotToStrikePct, isOpex, gapToNextBarAbovePct

| Feat1 | B1 | Feat2 | B2 | Ntr | Nte | bounce_tr | bounce_te | break_tr | break_te | edge_tr | edge_te | signal |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| vixLevel | >=30 | vixBucket | extreme | 252 | 53 | 33.7 | 17.0 | 47.6 | 69.8 | +11.2pp | +33.4pp | BREAK+ |
| vixLevel | >=30 | tltTrend5d | flat | 123 | 53 | 29.3 | 17.0 | 54.5 | 69.8 | +18pp | +33.4pp | BREAK+ |
| vixLevel | >=30 | isOpex | false | 252 | 53 | 33.7 | 17.0 | 47.6 | 69.8 | +11.2pp | +33.4pp | BREAK+ |
| vixBucket | extreme | tltTrend5d | flat | 123 | 53 | 29.3 | 17.0 | 54.5 | 69.8 | +18pp | +33.4pp | BREAK+ |
| vixBucket | extreme | isOpex | false | 252 | 53 | 33.7 | 17.0 | 47.6 | 69.8 | +11.2pp | +33.4pp | BREAK+ |
| vixLevel | [15,20) | distSpotToStrikePct | [0.01,0.03) | 115 | 106 | 53.9 | 61.3 | 26.1 | 18.9 | +20.4pp | +26pp | BOUNCE+ |
| vixBucket | low | distSpotToStrikePct | [0.01,0.03) | 115 | 106 | 53.9 | 61.3 | 26.1 | 18.9 | +20.4pp | +26pp | BOUNCE+ |
| minuteBucket | aft | priceRelToOpenPct | [0.003,0.01) | 127 | 127 | 26.8 | 26.0 | 55.1 | 59.1 | +18.7pp | +22.7pp | BREAK+ |
| sessionProgress | [0.7,0.9) | priceRelToOpenPct | [0.003,0.01) | 110 | 106 | 29.1 | 26.4 | 52.7 | 57.5 | +16.3pp | +21.2pp | BREAK+ |
| sessionProgress | [0.3,0.5) | distToZeroGammaPct | <-0.05 | 103 | 77 | 35.9 | 39.0 | 48.5 | 54.5 | +12.1pp | +18.2pp | BREAK+ |
| vixLevel | [20,25) | tltTrend5d | up | 107 | 72 | 44.9 | 31.9 | 36.4 | 54.2 | +11.3pp | -3.3pp | BOUNCE+ |
| vixBucket | mid | tltTrend5d | up | 107 | 72 | 44.9 | 31.9 | 36.4 | 54.2 | +11.3pp | -3.3pp | BOUNCE+ |
| tltTrend5d | flat | sessionProgress | [0.3,0.5) | 134 | 160 | 35.8 | 32.5 | 51.5 | 53.8 | +15pp | +17.4pp | BREAK+ |
| vixLevel | [25,30) | isOpex | false | 157 | 369 | 35.7 | 29.8 | 54.1 | 53.7 | +17.7pp | +17.3pp | BREAK+ |
| vixBucket | high | isOpex | false | 157 | 369 | 35.7 | 29.8 | 54.1 | 53.7 | +17.7pp | +17.3pp | BREAK+ |
| vixLevel | [25,30) | vixBucket | high | 157 | 399 | 35.7 | 30.1 | 54.1 | 53.4 | +17.7pp | +17pp | BREAK+ |
| vixLevel | [15,20) | sessionProgress | <0.1 | 484 | 351 | 25.8 | 28.2 | 24.6 | 19.9 | -11.9pp | -16.4pp | BREAK- |
| vixBucket | low | sessionProgress | <0.1 | 484 | 351 | 25.8 | 28.2 | 24.6 | 19.9 | -11.9pp | -16.4pp | BREAK- |
| sessionProgress | [0.3,0.5) | isOpex | false | 164 | 161 | 40.2 | 33.5 | 44.5 | 52.8 | +8.1pp | +16.4pp | BREAK+ |
| vixLevel | [15,20) | minuteBucket | open | 477 | 332 | 25.8 | 28.3 | 24.7 | 20.5 | -11.7pp | -15.9pp | BREAK- |

## Horizon: outcomeEod

Train baseline: bounce 40.0% / break 40.9% / flat 19.0%
Test baseline:  bounce 39.9% / break 40.5% / flat 19.6%

### Univariate survivors (20)

| Feature | Bucket | Ntr | Nte | bounce_tr | bounce_te | break_tr | break_te | edge_tr | edge_te | retention | signal |
|---|---|---|---|---|---|---|---|---|---|---|---|
| vixLevel | >=30 | 252 | 53 | 30.2 | 11.3 | 63.9 | 77.4 | +22.9pp | +36.8pp | 1.61x | BREAK+ |
| vixBucket | extreme | 252 | 53 | 30.2 | 11.3 | 63.9 | 77.4 | +22.9pp | +36.8pp | 1.61x | BREAK+ |
| vixLevel | [25,30) | 157 | 399 | 28.0 | 31.3 | 59.9 | 58.1 | +18.9pp | +17.6pp | 0.93x | BREAK+ |
| vixBucket | high | 157 | 399 | 28.0 | 31.3 | 59.9 | 58.1 | +18.9pp | +17.6pp | 0.93x | BREAK+ |
| distToZeroGammaPct | [-0.05,-0.02) | 159 | 83 | 29.6 | 42.2 | 36.5 | 27.7 | -10.5pp | +2.2pp | Xx | BOUNCE- |
| distSpotToStrikePct | [-0.03,-0.01) | 224 | 220 | 29.0 | 29.5 | 42.0 | 46.8 | -11pp | -10.4pp | 0.94x | BOUNCE- |
| minuteBucket | aft | 482 | 478 | 37.6 | 33.3 | 46.1 | 50.4 | +5.1pp | +9.9pp | 1.93x | BREAK+ |
| priceRelToOpenPct | >=0.01 | 235 | 218 | 26.4 | 30.7 | 46.8 | 47.7 | -13.7pp | -9.2pp | 0.67x | BOUNCE- |
| barsWithin1Pct | <2 | 302 | 57 | 41.7 | 49.1 | 46.4 | 35.1 | +5.4pp | -5.4pp | Xx | BREAK+ |
| sessionProgress | [0.7,0.9) | 406 | 409 | 37.4 | 35.2 | 46.6 | 48.7 | +5.6pp | +8.1pp | 1.45x | BREAK+ |
| oiRatio | >=0.7 | 469 | 317 | 34.1 | 34.1 | 36.7 | 33.8 | -5.9pp | -5.9pp | 0.99x | BOUNCE- |
| distToCallWallPct | <-0.05 | 363 | 99 | 41.9 | 44.4 | 47.1 | 35.4 | +6.2pp | -5.2pp | Xx | BREAK+ |
| barsWithin1Pct | >=10 | 595 | 848 | 38.0 | 38.6 | 35.3 | 35.4 | -5.6pp | -5.1pp | 0.91x | BREAK- |
| gammaType | support | 274 | 452 | 41.6 | 41.8 | 35.8 | 35.4 | -5.2pp | -5.1pp | 0.99x | BREAK- |
| priceRelToOpenPct | [0.003,0.01) | 449 | 426 | 32.3 | 35.0 | 45.9 | 38.7 | -7.8pp | -4.9pp | 0.64x | BOUNCE- |
| approach | up | 999 | 922 | 32.5 | 35.2 | 44.6 | 41.0 | -7.5pp | -4.7pp | 0.62x | BOUNCE- |
| minuteBucket | open | 768 | 670 | 46.4 | 43.9 | 40.6 | 41.2 | +6.3pp | +4pp | 0.63x | BOUNCE+ |
| priceRelToOpenPct | [-0.01,-0.003) | 573 | 475 | 45.5 | 43.8 | 34.2 | 40.4 | -6.7pp | -0.1pp | Xx | BREAK- |
| sessionProgress | <0.1 | 789 | 708 | 46.4 | 43.6 | 40.6 | 41.2 | +6.3pp | +3.7pp | 0.59x | BOUNCE+ |
| minuteOfSession | <60 | 841 | 768 | 46.5 | 43.5 | 40.3 | 41.8 | +6.4pp | +3.6pp | 0.55x | BOUNCE+ |

