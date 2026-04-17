# Discovery Report — 2026-04-17

**Total events:** 5289
**Symbols:** SPY, QQQ, GLD, DIA
**Date range:** 2024-12-09 → 2026-04-10
**Min N per cell:** 80
**Min edge (pp):** 4

## Horizon: outcome15m

**Baseline:** bounce 14.8% | break 16.0% | flat 69.2% (N=5289)

### Univariate — Top 30 discoveries

| Feature | Bucket | N | bounce% | break% | flat% | edge_bounce | edge_break | signal |
|---|---|---|---|---|---|---|---|---|
| vixLevel | >=30 | 305 | 25.6 | 32.5 | 42.0 | +10.8pp | +16.4pp | bounce+ |
| vixBucket | extreme | 305 | 25.6 | 32.5 | 42.0 | +10.8pp | +16.4pp | bounce+ |
| gammaConcentration | >=0.8 | 94 | 27.7 | 31.9 | 40.4 | +12.9pp | +15.9pp | bounce+ |
| dxyTrend5d | down | 138 | 30.4 | 18.1 | 51.4 | +15.6pp | +2.1pp | bounce+ |
| barsWithin1Pct | <2 | 359 | 24.0 | 29.0 | 47.1 | +9.2pp | +13pp | bounce+ |
| vixLevel | [25,30) | 556 | 17.1 | 29.0 | 54.0 | +2.3pp | +12.9pp | bounce+ |
| vixBucket | high | 556 | 17.1 | 29.0 | 54.0 | +2.3pp | +12.9pp | bounce+ |
| sessionProgress | [0.7,0.9) | 815 | 22.5 | 28.1 | 49.4 | +7.7pp | +12.1pp | bounce+ |
| gapToNextBarBelowPct | >=0.01 | 329 | 26.7 | 27.4 | 45.9 | +12pp | +11.3pp | bounce+ |
| distToZeroGammaPct | [-0.05,-0.02) | 242 | 2.9 | 4.1 | 93.0 | -11.9pp | -11.9pp | neutral |
| sessionRangeBeforeTouchPct | >=0.015 | 975 | 24.3 | 27.8 | 47.9 | +9.5pp | +11.8pp | bounce+ |
| gapToNextBarAbovePct | >=0.01 | 346 | 21.4 | 27.5 | 51.2 | +6.6pp | +11.4pp | bounce+ |
| distSpotToStrikePct | [0.01,0.03) | 613 | 24.3 | 27.1 | 48.6 | +9.5pp | +11.1pp | bounce+ |
| priceRelToOpenPct | <-0.01 | 614 | 25.9 | 26.2 | 47.9 | +11.1pp | +10.2pp | bounce+ |
| priceRelToOpenPct | >=0.01 | 453 | 18.3 | 27.2 | 54.5 | +3.5pp | +11.1pp | bounce+ |
| minuteBucket | aft | 960 | 22.2 | 27.1 | 50.7 | +7.4pp | +11.1pp | bounce+ |
| distToCallWallPct | <-0.05 | 462 | 25.3 | 25.3 | 49.4 | +10.5pp | +9.3pp | bounce+ |
| sessionRangeBeforeTouchPct | <0.003 | 1087 | 5.1 | 5.7 | 89.2 | -9.7pp | -10.3pp | neutral |
| oiRatio | >=0.7 | 786 | 7.9 | 5.9 | 86.3 | -6.9pp | -10.2pp | neutral |
| distSpotToStrikePct | [-0.03,-0.01) | 444 | 15.5 | 25.2 | 59.2 | +0.8pp | +9.2pp | bounce+ |
| isQuarterlyOpex | true | 123 | 10.6 | 25.2 | 64.2 | -4.2pp | +9.2pp | break+ |
| minuteOfSession | <60 | 1609 | 7.3 | 7.0 | 85.6 | -7.5pp | -9pp | neutral |
| sessionProgress | <0.1 | 1497 | 7.0 | 7.1 | 85.9 | -7.8pp | -8.9pp | neutral |
| vixLevel | <15 | 408 | 8.8 | 7.1 | 84.1 | -6pp | -8.9pp | neutral |
| minuteBucket | open | 1438 | 7.0 | 7.2 | 85.9 | -7.8pp | -8.9pp | neutral |
| vixBucket | v_low | 408 | 8.8 | 7.1 | 84.1 | -6pp | -8.9pp | neutral |
| distToPutWallPct | [-0.05,-0.02) | 189 | 23.3 | 23.8 | 52.9 | +8.5pp | +7.8pp | bounce+ |
| oiRatio | <0.3 | 1242 | 22.5 | 23.1 | 54.4 | +7.7pp | +7.1pp | bounce+ |
| sessionProgress | [0.1,0.3) | 289 | 10.0 | 8.3 | 81.7 | -4.8pp | -7.7pp | neutral |
| priceRelToOpenPct | [-0.003,0.003) | 2299 | 8.7 | 8.4 | 83.0 | -6.1pp | -7.7pp | neutral |

## Horizon: outcome1h

**Baseline:** bounce 24.2% | break 26.7% | flat 49.1% (N=5289)

### Univariate — Top 30 discoveries

| Feature | Bucket | N | bounce% | break% | flat% | edge_bounce | edge_break | signal |
|---|---|---|---|---|---|---|---|---|
| dxyTrend5d | down | 138 | 42.0 | 27.5 | 30.4 | +17.8pp | +0.8pp | bounce+ |
| isQuarterlyOpex | true | 123 | 18.7 | 43.9 | 37.4 | -5.5pp | +17.2pp | break+ |
| vixLevel | [25,30) | 556 | 30.2 | 42.4 | 27.3 | +6pp | +15.7pp | bounce+ |
| vixBucket | high | 556 | 30.2 | 42.4 | 27.3 | +6pp | +15.7pp | bounce+ |
| distToZeroGammaPct | [-0.05,-0.02) | 242 | 11.2 | 11.6 | 77.3 | -13pp | -15.2pp | neutral |
| distToPutWallPct | [-0.05,-0.02) | 189 | 37.6 | 33.9 | 28.6 | +13.4pp | +7.1pp | bounce+ |
| sessionProgress | [0.7,0.9) | 815 | 29.9 | 40.0 | 30.1 | +5.8pp | +13.3pp | bounce+ |
| sessionProgress | [0.1,0.3) | 289 | 25.6 | 13.5 | 60.9 | +1.4pp | -13.2pp | bounce+ |
| distToCallWallPct | <-0.05 | 462 | 37.2 | 32.9 | 29.9 | +13pp | +6.2pp | bounce+ |
| sessionRangeBeforeTouchPct | <0.003 | 1087 | 12.1 | 15.2 | 72.7 | -12pp | -11.6pp | neutral |
| gammaConcentration | >=0.8 | 94 | 36.2 | 31.9 | 31.9 | +12pp | +5.2pp | bounce+ |
| vixLevel | >=30 | 305 | 31.8 | 38.7 | 29.5 | +7.6pp | +12pp | bounce+ |
| vixBucket | extreme | 305 | 31.8 | 38.7 | 29.5 | +7.6pp | +12pp | bounce+ |
| priceRelToOpenPct | <-0.01 | 614 | 36.0 | 36.6 | 27.4 | +11.8pp | +9.9pp | bounce+ |
| vixLevel | <15 | 408 | 15.4 | 15.0 | 69.6 | -8.7pp | -11.8pp | neutral |
| vixBucket | v_low | 408 | 15.4 | 15.0 | 69.6 | -8.7pp | -11.8pp | neutral |
| minuteBucket | aft | 960 | 29.7 | 38.4 | 31.9 | +5.5pp | +11.7pp | bounce+ |
| oiRatio | >=0.7 | 786 | 17.7 | 15.3 | 67.0 | -6.5pp | -11.5pp | neutral |
| distSpotToStrikePct | [0.01,0.03) | 613 | 33.9 | 37.7 | 28.4 | +9.7pp | +10.9pp | bounce+ |
| daysToOpex | [3,7) | 427 | 27.6 | 16.2 | 56.2 | +3.5pp | -10.6pp | bounce+ |
| gapToNextBarBelowPct | >=0.01 | 329 | 34.7 | 33.1 | 32.2 | +10.5pp | +6.4pp | bounce+ |
| sessionRangeBeforeTouchPct | >=0.015 | 975 | 32.8 | 37.1 | 30.1 | +8.6pp | +10.4pp | bounce+ |
| minuteBucket | morn | 474 | 24.1 | 16.7 | 59.3 | -0.1pp | -10.1pp | neutral |
| barsWithin1Pct | <2 | 359 | 34.0 | 31.8 | 34.3 | +9.8pp | +5pp | bounce+ |
| oiRatio | <0.3 | 1242 | 33.7 | 32.8 | 33.6 | +9.5pp | +6pp | bounce+ |
| minuteBucket | open | 1438 | 15.5 | 19.2 | 65.3 | -8.7pp | -7.5pp | neutral |
| sessionProgress | <0.1 | 1497 | 15.6 | 18.8 | 65.5 | -8.6pp | -7.9pp | neutral |
| minuteOfSession | <60 | 1609 | 16.5 | 18.1 | 65.4 | -7.7pp | -8.6pp | neutral |
| tltTrend5d | down | 495 | 25.5 | 35.2 | 39.4 | +1.3pp | +8.4pp | bounce+ |
| priceRelToOpenPct | [-0.01,-0.003) | 1048 | 32.3 | 32.5 | 35.2 | +8.1pp | +5.8pp | bounce+ |

## Horizon: outcome4h

**Baseline:** bounce 34.4% | break 36.4% | flat 29.2% (N=5289)

### Univariate — Top 30 discoveries

| Feature | Bucket | N | bounce% | break% | flat% | edge_bounce | edge_break | signal |
|---|---|---|---|---|---|---|---|---|
| vixLevel | [25,30) | 556 | 31.7 | 53.6 | 14.7 | -2.7pp | +17.2pp | break+ |
| vixBucket | high | 556 | 31.7 | 53.6 | 14.7 | -2.7pp | +17.2pp | break+ |
| distToZeroGammaPct | [-0.05,-0.02) | 242 | 29.3 | 19.8 | 50.8 | -5pp | -16.6pp | neutral |
| dxyTrend5d | down | 138 | 50.7 | 26.1 | 23.2 | +16.4pp | -10.3pp | bounce+ |
| vixLevel | >=30 | 305 | 30.8 | 51.5 | 17.7 | -3.5pp | +15.1pp | break+ |
| vixBucket | extreme | 305 | 30.8 | 51.5 | 17.7 | -3.5pp | +15.1pp | break+ |
| sessionProgress | [0.3,0.5) | 340 | 36.8 | 49.4 | 13.8 | +2.4pp | +13pp | bounce+ |
| minuteBucket | aft | 960 | 34.5 | 47.6 | 17.9 | +0.1pp | +11.2pp | bounce+ |
| sessionProgress | [0.7,0.9) | 815 | 34.5 | 47.1 | 18.4 | +0.1pp | +10.7pp | bounce+ |
| gammaConcentration | >=0.8 | 94 | 39.4 | 45.7 | 14.9 | +5pp | +9.3pp | bounce+ |
| priceRelToOpenPct | <-0.01 | 614 | 43.5 | 37.6 | 18.9 | +9.1pp | +1.2pp | bounce+ |
| sessionRangeBeforeTouchPct | <0.003 | 1087 | 29.3 | 27.4 | 43.3 | -5.1pp | -9pp | neutral |
| priceRelToOpenPct | >=0.01 | 453 | 29.6 | 45.3 | 25.2 | -4.8pp | +8.8pp | break+ |
| oiRatio | >=0.7 | 786 | 25.8 | 28.1 | 46.1 | -8.5pp | -8.3pp | neutral |
| sessionProgress | <0.1 | 1497 | 30.6 | 28.1 | 41.3 | -3.8pp | -8.4pp | neutral |
| minuteBucket | open | 1438 | 30.5 | 28.1 | 41.4 | -3.9pp | -8.3pp | neutral |
| minuteOfSession | <60 | 1609 | 31.1 | 28.5 | 40.5 | -3.3pp | -8pp | neutral |
| distSpotToStrikePct | [0.01,0.03) | 613 | 41.9 | 39.5 | 18.6 | +7.6pp | +3.1pp | bounce+ |
| vixLevel | [20,25) | 1262 | 42.0 | 37.4 | 20.6 | +7.6pp | +1pp | bounce+ |
| vixBucket | mid | 1262 | 42.0 | 37.4 | 20.6 | +7.6pp | +1pp | bounce+ |
| vixLevel | <15 | 408 | 28.4 | 28.9 | 42.6 | -5.9pp | -7.5pp | neutral |
| minuteBucket | mid | 636 | 39.0 | 43.9 | 17.1 | +4.6pp | +7.5pp | bounce+ |
| vixBucket | v_low | 408 | 28.4 | 28.9 | 42.6 | -5.9pp | -7.5pp | neutral |
| distToCallWallPct | <-0.05 | 462 | 41.8 | 41.3 | 16.9 | +7.4pp | +4.9pp | bounce+ |
| gapToNextBarBelowPct | >=0.01 | 329 | 39.8 | 43.8 | 16.4 | +5.5pp | +7.4pp | bounce+ |
| regime | neutral | 434 | 33.4 | 29.3 | 37.3 | -0.9pp | -7.2pp | neutral |
| gammaBucket | large | 276 | 34.8 | 29.3 | 35.9 | +0.4pp | -7.1pp | bounce+ |
| distToPutWallPct | [-0.05,-0.02) | 189 | 41.3 | 39.7 | 19.0 | +6.9pp | +3.3pp | bounce+ |
| barsWithin1Pct | >=10 | 1443 | 30.8 | 29.7 | 39.4 | -3.5pp | -6.7pp | neutral |
| minuteOfSession | [60,180) | 442 | 35.5 | 43.0 | 21.5 | +1.2pp | +6.6pp | bounce+ |

### Bivariate (top-12 features combined) — Top 30 pair discoveries

Top features used: vixLevel, vixBucket, distToZeroGammaPct, dxyTrend5d, sessionProgress, minuteBucket, gammaConcentration, priceRelToOpenPct, sessionRangeBeforeTouchPct, oiRatio, minuteOfSession, distSpotToStrikePct

| Feat1 | Bucket1 | Feat2 | Bucket2 | N | bounce% | break% | edge_bounce | edge_break |
|---|---|---|---|---|---|---|---|---|
| vixLevel | [25,30) | distSpotToStrikePct | [-0.03,-0.01) | 94 | 18.1 | 73.4 | -16.3pp | +37pp |
| vixBucket | high | distSpotToStrikePct | [-0.03,-0.01) | 94 | 18.1 | 73.4 | -16.3pp | +37pp |
| vixLevel | [25,30) | priceRelToOpenPct | >=0.01 | 112 | 17.0 | 70.5 | -17.4pp | +34.1pp |
| vixBucket | high | priceRelToOpenPct | >=0.01 | 112 | 17.0 | 70.5 | -17.4pp | +34.1pp |
| vixLevel | [25,30) | minuteBucket | mid | 85 | 20.0 | 67.1 | -14.4pp | +30.6pp |
| vixBucket | high | minuteBucket | mid | 85 | 20.0 | 67.1 | -14.4pp | +30.6pp |
| distToZeroGammaPct | [-0.05,-0.02) | minuteBucket | open | 83 | 22.9 | 8.4 | -11.5pp | -28pp |
| distToZeroGammaPct | [-0.05,-0.02) | minuteOfSession | <60 | 90 | 25.6 | 8.9 | -8.8pp | -27.5pp |
| distToZeroGammaPct | [-0.05,-0.02) | sessionProgress | <0.1 | 87 | 24.1 | 9.2 | -10.2pp | -27.2pp |
| vixLevel | >=30 | dxyTrend5d | flat | 228 | 22.8 | 63.2 | -11.5pp | +26.7pp |
| vixBucket | extreme | dxyTrend5d | flat | 228 | 22.8 | 63.2 | -11.5pp | +26.7pp |
| vixLevel | [25,30) | distToZeroGammaPct | >=0.05 | 201 | 25.9 | 61.2 | -8.5pp | +24.8pp |
| vixBucket | high | distToZeroGammaPct | >=0.05 | 201 | 25.9 | 61.2 | -8.5pp | +24.8pp |
| vixLevel | [25,30) | oiRatio | [0.3,0.5) | 215 | 28.8 | 60.9 | -5.5pp | +24.5pp |
| vixBucket | high | oiRatio | [0.3,0.5) | 215 | 28.8 | 60.9 | -5.5pp | +24.5pp |
| vixLevel | >=30 | distToZeroGammaPct | >=0.05 | 147 | 27.2 | 60.5 | -7.1pp | +24.1pp |
| vixBucket | extreme | distToZeroGammaPct | >=0.05 | 147 | 27.2 | 60.5 | -7.1pp | +24.1pp |
| sessionProgress | <0.1 | oiRatio | >=0.7 | 199 | 19.1 | 12.6 | -15.3pp | -23.9pp |
| minuteBucket | open | oiRatio | >=0.7 | 191 | 19.4 | 12.6 | -15pp | -23.8pp |
| vixLevel | [15,20) | priceRelToOpenPct | <-0.01 | 200 | 58.0 | 20.5 | +23.6pp | -15.9pp |
| vixBucket | low | priceRelToOpenPct | <-0.01 | 200 | 58.0 | 20.5 | +23.6pp | -15.9pp |
| vixLevel | [25,30) | sessionRangeBeforeTouchPct | >=0.015 | 226 | 27.0 | 59.7 | -7.4pp | +23.3pp |
| vixBucket | high | sessionRangeBeforeTouchPct | >=0.015 | 226 | 27.0 | 59.7 | -7.4pp | +23.3pp |
| vixLevel | [15,20) | distSpotToStrikePct | [0.01,0.03) | 221 | 57.5 | 22.6 | +23.1pp | -13.8pp |
| vixBucket | low | distSpotToStrikePct | [0.01,0.03) | 221 | 57.5 | 22.6 | +23.1pp | -13.8pp |
| vixLevel | [25,30) | priceRelToOpenPct | [-0.01,-0.003) | 113 | 25.7 | 59.3 | -8.7pp | +22.9pp |
| vixBucket | high | priceRelToOpenPct | [-0.01,-0.003) | 113 | 25.7 | 59.3 | -8.7pp | +22.9pp |
| oiRatio | >=0.7 | minuteOfSession | <60 | 212 | 18.4 | 13.7 | -16pp | -22.7pp |
| dxyTrend5d | down | oiRatio | <0.3 | 86 | 57.0 | 23.3 | +22.6pp | -13.2pp |
| vixLevel | <15 | sessionProgress | <0.1 | 128 | 30.5 | 14.1 | -3.9pp | -22.4pp |

## Horizon: outcomeEod

**Baseline:** bounce 40.0% | break 40.7% | flat 19.3% (N=5289)

### Univariate — Top 30 discoveries

| Feature | Bucket | N | bounce% | break% | flat% | edge_bounce | edge_break | signal |
|---|---|---|---|---|---|---|---|---|
| vixLevel | >=30 | 305 | 26.9 | 66.2 | 6.9 | -13.1pp | +25.5pp | break+ |
| vixBucket | extreme | 305 | 26.9 | 66.2 | 6.9 | -13.1pp | +25.5pp | break+ |
| vixLevel | [25,30) | 556 | 30.4 | 58.6 | 11.0 | -9.6pp | +17.9pp | break+ |
| vixBucket | high | 556 | 30.4 | 58.6 | 11.0 | -9.6pp | +17.9pp | break+ |
| isQuarterlyOpex | true | 123 | 52.0 | 32.5 | 15.4 | +12pp | -8.2pp | bounce+ |
| priceRelToOpenPct | >=0.01 | 453 | 28.5 | 47.2 | 24.3 | -11.5pp | +6.5pp | break+ |
| distSpotToStrikePct | [-0.03,-0.01) | 444 | 29.3 | 44.4 | 26.4 | -10.7pp | +3.6pp | break+ |
| gammaConcentration | [0.4,0.6) | 129 | 36.4 | 48.8 | 14.7 | -3.6pp | +8.1pp | break+ |
| distToPutWallPct | [-0.05,-0.02) | 189 | 38.1 | 48.7 | 13.2 | -1.9pp | +7.9pp | break+ |
| minuteBucket | aft | 960 | 35.4 | 48.2 | 16.4 | -4.6pp | +7.5pp | break+ |
| distToZeroGammaPct | [-0.05,-0.02) | 242 | 33.9 | 33.5 | 32.6 | -6.1pp | -7.3pp | neutral |
| gammaConcentration | >=0.8 | 94 | 37.2 | 47.9 | 14.9 | -2.8pp | +7.1pp | break+ |
| isOpex | true | 276 | 47.1 | 36.6 | 16.3 | +7.1pp | -4.2pp | bounce+ |
| sessionProgress | [0.7,0.9) | 815 | 36.3 | 47.6 | 16.1 | -3.7pp | +6.9pp | break+ |
| tltTrend5d | up | 438 | 46.6 | 36.3 | 17.1 | +6.6pp | -4.4pp | bounce+ |
| priceRelToOpenPct | [0.003,0.01) | 875 | 33.6 | 42.4 | 24.0 | -6.4pp | +1.7pp | break+ |
| approach | up | 1921 | 33.8 | 42.9 | 23.3 | -6.2pp | +2.1pp | break+ |
| vixTrend5d | down | 1936 | 41.8 | 34.7 | 23.5 | +1.9pp | -6.1pp | bounce+ |
| oiRatio | >=0.7 | 786 | 34.1 | 35.5 | 30.4 | -5.9pp | -5.2pp | neutral |
| vixLevel | [15,20) | 2758 | 42.3 | 34.9 | 22.8 | +2.4pp | -5.9pp | bounce+ |
| vixBucket | low | 2758 | 42.3 | 34.9 | 22.8 | +2.4pp | -5.9pp | bounce+ |
| gapToNextBarBelowPct | >=0.01 | 329 | 40.1 | 46.5 | 13.4 | +0.1pp | +5.8pp | bounce+ |
| distToPutWallPct | [-0.02,0) | 710 | 45.4 | 37.3 | 17.3 | +5.4pp | -3.4pp | bounce+ |
| barsWithin1Pct | >=10 | 1443 | 38.3 | 35.3 | 26.3 | -1.7pp | -5.4pp | neutral |
| gapToNextBarAbovePct | >=0.01 | 346 | 40.2 | 46.0 | 13.9 | +0.2pp | +5.2pp | bounce+ |
| gammaType | support | 726 | 41.7 | 35.5 | 22.7 | +1.7pp | -5.2pp | bounce+ |
| minuteBucket | open | 1438 | 45.2 | 40.9 | 13.9 | +5.2pp | +0.1pp | bounce+ |
| minuteBucket | close | 1781 | 36.4 | 35.5 | 28.0 | -3.5pp | -5.2pp | neutral |
| sessionProgress | <0.1 | 1497 | 45.1 | 40.9 | 14.0 | +5.1pp | +0.1pp | bounce+ |
| minuteOfSession | <60 | 1609 | 45.1 | 41.0 | 13.9 | +5.1pp | +0.3pp | bounce+ |

