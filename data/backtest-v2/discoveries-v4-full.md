# Discovery v4 — Spreads + Dealer + Intraday features

**Events:** 7850
**Min N univariate:** 80 | **bivariate:** 50


## Horizon: outcome1h

Baseline: bounce 24.1% / break 25.0% (N=7850)

### Univariate top 20 (spreads/dealer/intraday)

| Feature | Bucket | N | bounce% | break% | eb | ek | signal | OOS |
|---|---|---|---|---|---|---|---|---|
| spreads_bias | [-0.5,-0.2) | 327 | 21.4 | 41.0 | -2.7pp | +16pp | BREAK+ | ✓ 1.02x (Nte=163) |
| spreads_straddle_count | [5,15) | 172 | 28.5 | 40.7 | +4.3pp | +15.7pp | BREAK+ | ✓ 0.76x (Nte=78) |
| spreads_inst_count | [5,15) | 159 | 32.7 | 39.6 | +8.6pp | +14.6pp | BREAK+ | weak 0.38x |
| intra_burst_count | [1,3) | 461 | 25.8 | 39.0 | +1.7pp | +14.1pp | BREAK+ | weak 0.05x |
| spreads_largest_prem | >=2000000 | 619 | 25.2 | 38.4 | +1.1pp | +13.5pp | BREAK+ | weak 0.44x |
| spreads_straddle_count | [1,5) | 157 | 29.9 | 36.3 | +5.8pp | +11.3pp | BREAK+ | ✓ 0.69x (Nte=68) |
| spreads_largest_prem | [100000,500000) | 462 | 26.8 | 35.7 | +2.7pp | +10.7pp | BREAK+ | ✓ 0.88x (Nte=221) |
| intra_bullBear_bias_at_touch | [-0.2,0.2) | 1634 | 26.7 | 35.3 | +2.5pp | +10.3pp | BREAK+ | weak 0.4x |
| spreads_bias | >=0.5 | 197 | 25.4 | 35.0 | +1.2pp | +10pp | BREAK+ | ✓ 1.27x (Nte=113) |
| intra_entropy_at_touch | [0.5,0.7) | 1342 | 25.8 | 34.7 | +1.6pp | +9.7pp | BREAK+ | ✓ 0.57x (Nte=747) |
| spreads_inst_count | >=50 | 1127 | 26.2 | 34.4 | +2pp | +9.4pp | BREAK+ | weak 0.32x |
| spreads_bias | [0.2,0.5) | 258 | 26.4 | 33.7 | +2.2pp | +8.7pp | BREAK+ | weak 0.05x |
| spreads_straddle_count | >=15 | 1370 | 25.9 | 33.6 | +1.8pp | +8.6pp | BREAK+ | weak 0.37x |
| intra_entropy_at_touch | [0.7,0.9) | 375 | 30.9 | 33.3 | +6.8pp | +8.3pp | BREAK+ | weak -0.28x |
| spreads_inst_count | [1,5) | 130 | 27.7 | 33.1 | +3.6pp | +8.1pp | BREAK+ | ✓ 1.42x (Nte=53) |
| spreads_bias | <-0.5 | 223 | 27.4 | 32.3 | +3.2pp | +7.3pp | BREAK+ | ✓ 0.73x (Nte=107) |
| spreads_inst_count | [15,50) | 296 | 23.6 | 32.1 | -0.5pp | +7.1pp | BREAK+ | ✓ 1.17x (Nte=139) |
| intra_opening_bias | [0.1,0.3) | 153 | 18.3 | 19.6 | -5.8pp | -5.4pp | BOUNCE- | ✓ 1.53x (Nte=69) |
| intra_closing_bias | <-0.3 | 445 | 25.2 | 30.6 | +1pp | +5.6pp | BREAK+ | weak 0.34x |
| intra_closing_bias | >=0.3 | 346 | 18.8 | 22.5 | -5.4pp | -2.5pp | BOUNCE- | ✓ 0.69x (Nte=188) |

## Horizon: outcome4h

Baseline: bounce 34.8% / break 34.4% (N=7850)

### Univariate top 20 (spreads/dealer/intraday)

| Feature | Bucket | N | bounce% | break% | eb | ek | signal | OOS |
|---|---|---|---|---|---|---|---|---|
| spreads_bias | [-0.5,-0.2) | 327 | 25.7 | 48.3 | -9.1pp | +14pp | BREAK+ | ✓ 1.06x (Nte=163) |
| intra_burst_count | [1,3) | 461 | 28.9 | 48.4 | -5.9pp | +14pp | BREAK+ | ✓ 1.2x (Nte=227) |
| spreads_straddle_count | [5,15) | 172 | 33.7 | 46.5 | -1.1pp | +12.2pp | BREAK+ | ✓ 2.67x (Nte=78) |
| spreads_bias | <-0.5 | 223 | 29.1 | 45.7 | -5.6pp | +11.4pp | BREAK+ | ✓ 1x (Nte=107) |
| intra_burst_count | >=7 | 113 | 29.2 | 23.0 | -5.6pp | -11.3pp | BREAK- | ✓ 4.87x (Nte=40) |
| spreads_inst_count | [5,15) | 159 | 34.6 | 44.7 | -0.2pp | +10.3pp | BREAK+ | ✓ 2.32x (Nte=76) |
| spreads_largest_prem | [100000,500000) | 462 | 31.6 | 44.4 | -3.2pp | +10pp | BREAK+ | ✓ 2.44x (Nte=221) |
| intra_bullBear_bias_at_touch | [-0.2,0.2) | 1634 | 32.7 | 44.2 | -2pp | +9.8pp | BREAK+ | ✓ 1.1x (Nte=864) |
| spreads_inst_count | [15,50) | 296 | 29.1 | 43.9 | -5.7pp | +9.6pp | BREAK+ | weak -9.96x |
| intra_entropy_at_touch | [0.5,0.7) | 1342 | 32.6 | 43.7 | -2.2pp | +9.4pp | BREAK+ | ✓ 1.5x (Nte=747) |
| spreads_bias | >=0.5 | 197 | 34.0 | 42.6 | -0.8pp | +8.3pp | BREAK+ | ✓ 3.38x (Nte=113) |
| intra_com_migration_pct | [0.003,0.01) | 484 | 29.8 | 42.4 | -5pp | +8pp | BREAK+ | weak 0.49x |
| dealer_calls_net | [-50,50) | 151 | 39.7 | 26.5 | +4.9pp | -7.9pp | BREAK- | ✓ 0.62x (Nte=75) |
| dealer_puts_net | [-50,50) | 173 | 31.2 | 26.6 | -3.6pp | -7.8pp | BREAK- | ✓ 0.88x (Nte=93) |
| spreads_largest_prem | >=2000000 | 619 | 33.4 | 42.0 | -1.3pp | +7.6pp | BREAK+ | weak -0.05x |
| intra_opening_bias | [0.1,0.3) | 153 | 27.5 | 28.1 | -7.3pp | -6.3pp | BOUNCE- | ✓ 0.57x (Nte=69) |
| spreads_straddle_count | [1,5) | 157 | 32.5 | 41.4 | -2.3pp | +7pp | BREAK+ | ✓ 11.23x (Nte=68) |
| spreads_inst_count | >=50 | 1127 | 33.5 | 41.2 | -1.3pp | +6.8pp | BREAK+ | weak 0.21x |
| spreads_straddle_count | >=15 | 1370 | 32.8 | 41.2 | -2pp | +6.8pp | BREAK+ | ✓ 0.64x (Nte=772) |
| spreads_bias | [0.2,0.5) | 258 | 37.2 | 41.1 | +2.4pp | +6.7pp | BREAK+ | ✓ 1.67x (Nte=133) |

### Bivariate NEW × Context (top 25)

| F1 | B1 | F2 | B2 | N | b% | br% | eb | ek | OOS |
|---|---|---|---|---|---|---|---|---|---|
| intra_entropy_at_touch | [0.7,0.9) | vixBucket | extreme | 58 | 24.1 | 72.4 | -10.7pp | +38.1pp | ✓ 1.7x Nte=2 |
| intra_burst_count | [1,3) | priceRelToOpenPct | >=0.01 | 74 | 17.6 | 66.2 | -17.2pp | +31.9pp | ✓ 0.68x Nte=36 |
| spreads_bias | >=0.5 | minuteBucket | aft | 59 | 22.0 | 62.7 | -12.8pp | +28.4pp | ✓ 1.9x Nte=34 |
| spreads_largest_prem | >=2000000 | minuteBucket | aft | 51 | 25.5 | 62.7 | -9.3pp | +28.4pp | ✓ 0.52x Nte=35 |
| spreads_straddle_count | [5,15) | sym | QQQ | 80 | 28.7 | 62.5 | -6pp | +28.1pp | ✓ 1.5x Nte=31 |
| spreads_straddle_count | [1,5) | minuteBucket | aft | 50 | 22.0 | 62.0 | -12.8pp | +27.6pp | ✓ 2.54x Nte=22 |
| spreads_largest_prem | [500000,2000000) | vixBucket | high | 73 | 27.4 | 61.6 | -7.4pp | +27.3pp | weak 0.46x Nte=58 |
| spreads_inst_count | >=50 | vixBucket | extreme | 142 | 26.8 | 61.3 | -8pp | +26.9pp | ✓ 1.58x Nte=24 |
| spreads_bias | [-0.5,-0.2) | flow_strikeShareOfDay | [0.001,0.01) | 74 | 29.7 | 60.8 | -5.1pp | +26.5pp | ✓ 1.07x Nte=35 |
| spreads_inst_count | [5,15) | sym | QQQ | 73 | 28.8 | 60.3 | -6pp | +25.9pp | ✓ 1.67x Nte=27 |
| spreads_straddle_count | >=15 | vixBucket | extreme | 157 | 28.0 | 59.9 | -6.8pp | +25.5pp | ✓ 1.52x Nte=25 |
| spreads_bias | <-0.5 | minuteBucket | aft | 74 | 24.3 | 59.5 | -10.5pp | +25.1pp | ✓ 2.97x Nte=47 |
| spreads_largest_prem | >=2000000 | vixBucket | extreme | 125 | 28.8 | 59.2 | -6pp | +24.8pp | ✓ 1.38x Nte=22 |
| intra_burst_count | [1,3) | hiro_consensus | mixed | 58 | 27.6 | 58.6 | -7.2pp | +24.3pp | ✓ 1.47x Nte=35 |
| intra_bullBear_bias_at_touch | [-0.2,0.2) | vixBucket | extreme | 156 | 30.1 | 58.3 | -4.7pp | +24pp | ✓ 2.08x Nte=24 |
| intra_burst_count | [1,3) | vixBucket | high | 81 | 28.4 | 58.0 | -6.4pp | +23.7pp | weak 0.29x Nte=45 |
| spreads_straddle_count | [5,15) | hiro_consensus | bearish | 71 | 26.8 | 57.7 | -8pp | +23.4pp | ✓ 4.04x Nte=28 |
| spreads_bias | [-0.5,-0.2) | minuteBucket | aft | 80 | 28.7 | 57.5 | -6pp | +23.1pp | ✓ 2.54x Nte=47 |
| intra_burst_count | [1,3) | approach | up | 219 | 20.1 | 57.1 | -14.7pp | +22.7pp | ✓ 1x Nte=112 |
| spreads_largest_prem | [100000,500000) | minuteBucket | aft | 176 | 29.5 | 56.8 | -5.2pp | +22.5pp | ✓ 2.01x Nte=89 |
| intra_burst_count | >=7 | hiro_consensus | bullish | 50 | 42.0 | 12.0 | +7.2pp | -22.4pp | ✓ 1.26x Nte=20 |
| spreads_largest_prem | [500000,2000000) | flow_strikeShareOfDay | [0.001,0.01) | 125 | 33.6 | 56.8 | -1.2pp | +22.4pp | ✓ 1.84x Nte=91 |
| spreads_inst_count | [5,15) | approach | up | 69 | 30.4 | 56.5 | -4.4pp | +22.2pp | ✓ 2.23x Nte=35 |
| intra_bullBear_bias_at_touch | [-0.2,0.2) | vixBucket | high | 197 | 26.9 | 56.3 | -7.9pp | +22pp | weak 0.37x Nte=127 |
| spreads_straddle_count | [5,15) | minuteBucket | aft | 96 | 33.3 | 56.3 | -1.5pp | +21.9pp | ✓ 2.92x Nte=43 |

## Horizon: outcomeEod

Baseline: bounce 40.9% / break 40.2% (N=7850)

### Univariate top 20 (spreads/dealer/intraday)

| Feature | Bucket | N | bounce% | break% | eb | ek | signal | OOS |
|---|---|---|---|---|---|---|---|---|
| intra_burst_count | >=7 | 113 | 29.2 | 24.8 | -11.6pp | -15.5pp | BREAK- | ✓ 2.58x (Nte=40) |
| spreads_bias | [-0.5,-0.2) | 327 | 28.4 | 48.0 | -12.4pp | +7.8pp | BOUNCE- | ✓ 0.74x (Nte=163) |
| spreads_inst_count | [15,50) | 296 | 30.1 | 45.3 | -10.8pp | +5pp | BOUNCE- | ✓ 3.67x (Nte=139) |
| dealer_calls_net | [-50,50) | 151 | 51.7 | 31.1 | +10.8pp | -9.1pp | BOUNCE+ | ✓ 6.45x (Nte=75) |
| intra_burst_count | [1,3) | 461 | 31.2 | 47.7 | -9.6pp | +7.5pp | BOUNCE- | ✓ 1.9x (Nte=227) |
| spreads_bias | <-0.5 | 223 | 31.4 | 44.8 | -9.5pp | +4.6pp | BOUNCE- | ✓ 1.48x (Nte=107) |
| spreads_largest_prem | >=2000000 | 619 | 31.3 | 43.3 | -9.5pp | +3.1pp | BOUNCE- | weak 0.36x |
| spreads_straddle_count | >=15 | 1370 | 32.4 | 43.3 | -8.4pp | +3pp | BOUNCE- | ✓ 0.58x (Nte=772) |
| spreads_inst_count | >=50 | 1127 | 32.8 | 43.0 | -8pp | +2.8pp | BOUNCE- | weak 0.37x |
| dealer_puts_net | [-50,50) | 173 | 48.6 | 33.5 | +7.7pp | -6.7pp | BOUNCE+ | ✓ 1.59x (Nte=93) |
| intra_bullBear_bias_at_touch | [-0.2,0.2) | 1634 | 33.2 | 45.8 | -7.6pp | +5.5pp | BOUNCE- | ✓ 0.93x (Nte=864) |
| spreads_largest_prem | [500000,2000000) | 631 | 33.6 | 43.1 | -7.3pp | +2.9pp | BOUNCE- | ✓ 0.58x (Nte=376) |
| intra_entropy_at_touch | [0.5,0.7) | 1342 | 33.5 | 44.4 | -7.3pp | +4.2pp | BOUNCE- | ✓ 1x (Nte=747) |
| intra_closing_bias | [-0.3,-0.1) | 663 | 47.1 | 36.8 | +6.2pp | -3.4pp | BOUNCE+ | ✓ 0.6x (Nte=363) |
| dealer_calls_net | [50,500) | 382 | 39.5 | 46.3 | -1.3pp | +6.1pp | BREAK+ | ✓ 1.24x (Nte=197) |
| intra_entropy_at_touch | [0.7,0.9) | 375 | 34.9 | 45.3 | -5.9pp | +5.1pp | BOUNCE- | weak 0.15x |
| spreads_straddle_count | [5,15) | 172 | 37.8 | 45.9 | -3.1pp | +5.7pp | BREAK+ | weak -22.17x |
| intra_opening_bias | [-0.3,-0.1) | 256 | 46.5 | 41.0 | +5.6pp | +0.8pp | BOUNCE+ | ✓ 6.47x (Nte=109) |
| intra_closing_bias | <-0.3 | 445 | 37.8 | 45.8 | -3.1pp | +5.6pp | BREAK+ | ✓ 5.11x (Nte=211) |
| intra_burst_count | [3,7) | 482 | 35.3 | 35.5 | -5.6pp | -4.8pp | BOUNCE- | weak 0.08x |
