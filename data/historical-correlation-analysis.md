# Comprehensive Gamma Bar Correlation Analysis

**Data range:** 2024-09-04 to 2026-04-10 (399 trading days)
**Total bar touches analyzed:** 2269

---

## A. Gamma Bar Bounce/Break Analysis

**Overall:** 2269 bar touches across all symbols. Bounce rate: 49.1% (N=2269)

### A1. Bounce Rate by Symbol

| Symbol | Touches | Bounces | Breaks | Bounce Rate |
|--------|---------|---------|--------|-------------|
| SPX | 795 | 359 | 436 | 45.2% |
| QQQ | 377 | 171 | 206 | 45.4% |
| SPY | 474 | 251 | 223 | 53.0% |
| DIA | 421 | 229 | 192 | 54.4% |
| GLD | 202 | 105 | 97 | 52.0% |

### A2. Bounce Rate by Bar Size (totalGamma)

#### SPX Bar Size Buckets

| Bar Size | Touches | Bounces | Breaks | Bounce Rate | Confidence |
|----------|---------|---------|--------|-------------|------------|
| <500M | 32 | 14 | 18 | 43.8% | LOW |
| 500M-1B | 338 | 151 | 187 | 44.7% | HIGH |
| 1B-2B | 300 | 133 | 167 | 44.3% | HIGH |
| 2B-5B | 101 | 48 | 53 | 47.5% | MEDIUM |
| >5B | 24 | 13 | 11 | 54.2% | LOW |

#### GLD Bar Size Buckets

| Bar Size | Touches | Bounces | Breaks | Bounce Rate | Confidence |
|----------|---------|---------|--------|-------------|------------|
| <5M | 0 | 0 | 0 | N/A | LOW |
| 5M-20M | 4 | 2 | 2 | 50.0% | LOW |
| 20M-50M | 39 | 20 | 19 | 51.3% | LOW |
| 50M-100M | 60 | 33 | 27 | 55.0% | MEDIUM |
| >100M | 99 | 50 | 49 | 50.5% | MEDIUM |

#### DIA Bar Size Buckets

| Bar Size | Touches | Bounces | Breaks | Bounce Rate | Confidence |
|----------|---------|---------|--------|-------------|------------|
| <5M | 26 | 12 | 14 | 46.2% | LOW |
| 5M-10M | 142 | 86 | 56 | 60.6% | MEDIUM |
| 10M-30M | 199 | 105 | 94 | 52.8% | MEDIUM |
| 30M-100M | 52 | 26 | 26 | 50.0% | MEDIUM |
| >100M | 2 | 0 | 2 | 0.0% | LOW |

### A3. Bounce Rate by Gamma Regime

| Regime | Touches | Bounces | Breaks | Bounce Rate | Avg Range |
|--------|---------|---------|--------|-------------|-----------|
| negative | 131 | 53 | 78 | 40.5% | 94.4 |
| neutral | 296 | 140 | 156 | 47.3% | 74.6 |
| positive | 324 | 153 | 171 | 47.2% | 52.9 |
| very_negative | 44 | 13 | 31 | 29.5% | 141.4 |

### A4. Bounce Rate by VRP (IV30 - RV30)

| VRP Bucket | Touches | Bounces | Breaks | Bounce Rate | Confidence |
|------------|---------|---------|--------|-------------|------------|
| very_neg (<-5) | 80 | 32 | 48 | 40.0% | MEDIUM |
| neg (-5 to -2) | 104 | 56 | 48 | 53.8% | MEDIUM |
| slight_neg (-2 to 0) | 151 | 63 | 88 | 41.7% | MEDIUM |
| slight_pos (0 to 2) | 158 | 69 | 89 | 43.7% | MEDIUM |
| pos (2 to 5) | 168 | 88 | 80 | 52.4% | MEDIUM |
| very_pos (>5) | 113 | 43 | 70 | 38.1% | MEDIUM |

### A5. Bounce Rate by Bar Type

| Type | Touches | Bounces | Breaks | Bounce Rate | Confidence |
|------|---------|---------|--------|-------------|------------|
| resistance | 1771 | 867 | 904 | 49.0% | HIGH |
| support | 498 | 248 | 250 | 49.8% | HIGH |

### A6. Bounce Rate by Gamma Ratio

| Gamma Ratio | Touches | Bounces | Breaks | Bounce Rate | Confidence |
|-------------|---------|---------|--------|-------------|------------|
| <0.2 (very neg) | 0 | 0 | 0 | N/A | LOW |
| 0.2-0.4 (neg) | 108 | 41 | 67 | 38.0% | MEDIUM |
| 0.4-0.6 (neutral) | 542 | 248 | 294 | 45.8% | HIGH |
| 0.6-0.8 (pos) | 145 | 70 | 75 | 48.3% | MEDIUM |
| >=0.8 (very pos) | 0 | 0 | 0 | N/A | LOW |

### A7. Support Bar Bounce Rate by Regime (SPX)

| Regime | Support Bounces | Support Break | Support Bounce% | Resist Bounces | Resist Break | Resist Bounce% |
|--------|----------------|---------------|-----------------|----------------|--------------|----------------|
| negative | 11 | 19 | 36.7% | 42 | 59 | 41.6% |
| neutral | 58 | 62 | 48.3% | 82 | 94 | 46.6% |
| positive | 85 | 100 | 45.9% | 68 | 71 | 48.9% |
| very_negative | 1 | 3 | 25.0% | 12 | 28 | 30.0% |

### A8. Bounce Rate by Distance from Spot Price (SPX)

| Distance | Touches | Bounces | Breaks | Bounce Rate | Confidence |
|----------|---------|---------|--------|-------------|------------|
| <0.5% | 33 | 13 | 20 | 39.4% | LOW |
| 0.5-1% | 17 | 9 | 8 | 52.9% | LOW |
| 1-2% | 38 | 13 | 25 | 34.2% | LOW |
| 2-3% | 34 | 22 | 12 | 64.7% | LOW |
| >3% | 673 | 302 | 371 | 44.9% | HIGH |


```
RULE: Fatter gamma bars bounce more reliably than thin bars
Evidence: SPX bars >2B gamma: 48.8% bounce rate (N=125), bars <500M: 43.8% (N=32)
Win rate: See table A2
Action: Prioritize entries at bars with gamma >1B SPX. Bars <500M are breakout candidates, not bounce plays.
Confidence: MEDIUM
```

```
RULE: Positive gamma regime increases bounce probability
Evidence: Positive/very_pos regime: 47.2% bounce rate vs negative: 37.7%
Win rate: See table A3
Action: In positive gamma, trust bar bounces. In negative gamma, expect breaks — use LEVEL mode for breakout entries.
Confidence: HIGH
```

---

## B. Level-to-Level Movement Analysis (L58 Validation)

**Total days analyzed:** 385
**Days price traveled bar-to-bar:** 223 (57.9%)

**Avg daily range (SPX):** 67.8 points
**Avg distance between 2 nearest fat bars:** 17.0 points
**Ratio (range / bar distance):** 3.99x

### Level-to-Level Travel Rate by Bar Distance

| Bar Distance | Days | Traveled | Travel Rate | Avg Range | Confidence |
|-------------|------|----------|-------------|-----------|------------|
| <10pts | 132 | 92 | 69.7% | 53.2 | MEDIUM |
| 10-25pts | 165 | 100 | 60.6% | 63.3 | MEDIUM |
| 25-50pts | 61 | 24 | 39.3% | 78.9 | MEDIUM |
| 50-100pts | 21 | 6 | 28.6% | 116.5 | LOW |
| >100pts | 6 | 1 | 16.7% | 228.1 | LOW |


```
RULE: Price travels from one fat gamma bar to the next in the majority of sessions
Evidence: 57.9% of days (N=385), avg range 67.8pts covers avg bar dist 17.0pts
Win rate: 57.9%
Action: Set TP at the next fat gamma bar. The vacuum between bars is the profit zone. Price accelerates through low-gamma gaps.
Confidence: HIGH
```

---

## C. Regime + Direction + VRP Analysis

**Total days:** 385

### C1. Day Direction by Regime

| Regime | Days | UP | DOWN | UP% | Avg UP Mag | Avg DOWN Mag | Avg Range% |
|--------|------|----|----- |-----|------------|--------------|------------|
| negative | 66 | 36 | 30 | 54.5% | 0.718% | -0.767% | 1.428% |
| neutral | 142 | 79 | 63 | 55.6% | 0.503% | -0.528% | 1.054% |
| positive | 151 | 80 | 71 | 53.0% | 0.342% | -0.432% | 0.744% |
| very_negative | 26 | 14 | 12 | 53.8% | 1.833% | -1.501% | 2.704% |

### C2. Day Direction by VRP

| VRP Bucket | Days | UP | DOWN | UP% | Avg Magnitude | Avg Range% | Confidence |
|------------|------|----|------|-----|---------------|------------|------------|
| very_neg (<-5) | 44 | 28 | 16 | 63.6% | 0.724% | 1.235% | LOW |
| neg (-5 to -2) | 49 | 33 | 16 | 67.3% | 0.514% | 1.081% | LOW |
| slight_neg (-2 to 0) | 60 | 34 | 26 | 56.7% | 0.532% | 0.980% | MEDIUM |
| slight_pos (0 to 2) | 77 | 45 | 32 | 58.4% | 0.468% | 0.894% | MEDIUM |
| pos (2 to 5) | 85 | 44 | 41 | 51.8% | 0.504% | 1.025% | MEDIUM |
| very_pos (>5) | 60 | 20 | 40 | 33.3% | 0.798% | 1.494% | MEDIUM |

### C3. Regime + VRP Combination

| Regime | VRP | Days | UP% | Avg Mag | Confidence |
|--------|-----|------|-----|---------|------------|
| negative | neg (-5 to -2) | 10 | 80.0% | 0.833% | LOW |
| negative | slight_neg (-2 to 0) | 6 | 83.3% | 0.935% | LOW |
| negative | slight_pos (0 to 2) | 7 | 71.4% | 0.752% | LOW |
| negative | pos (2 to 5) | 15 | 53.3% | 0.633% | LOW |
| negative | very_pos (>5) | 18 | 27.8% | 0.679% | LOW |
| neutral | very_neg (<-5) | 17 | 64.7% | 0.475% | LOW |
| neutral | neg (-5 to -2) | 16 | 62.5% | 0.418% | LOW |
| neutral | slight_neg (-2 to 0) | 25 | 68.0% | 0.621% | LOW |
| neutral | slight_pos (0 to 2) | 28 | 57.1% | 0.439% | LOW |
| neutral | pos (2 to 5) | 35 | 54.3% | 0.523% | LOW |
| neutral | very_pos (>5) | 19 | 26.3% | 0.581% | LOW |
| positive | very_neg (<-5) | 19 | 63.2% | 0.418% | LOW |
| positive | neg (-5 to -2) | 17 | 64.7% | 0.303% | LOW |
| positive | slight_neg (-2 to 0) | 29 | 41.4% | 0.371% | LOW |
| positive | slight_pos (0 to 2) | 40 | 57.5% | 0.375% | LOW |
| positive | pos (2 to 5) | 30 | 46.7% | 0.297% | LOW |
| positive | very_pos (>5) | 15 | 46.7% | 0.675% | LOW |
| very_negative | very_neg (<-5) | 5 | 60.0% | 2.921% | LOW |
| very_negative | neg (-5 to -2) | 6 | 66.7% | 0.831% | LOW |
| very_negative | pos (2 to 5) | 5 | 60.0% | 1.216% | LOW |
| very_negative | very_pos (>5) | 8 | 37.5% | 1.814% | LOW |

### C4. Average Daily Range by Regime

| Regime | Avg Range (pts) | Avg Range% | Max Range | Days |
|--------|-----------------|------------|-----------|------|
| negative | 86.4 | 1.428% | 237.9 | 66 |
| neutral | 66.3 | 1.054% | 236.3 | 142 |
| positive | 47.4 | 0.744% | 211.6 | 151 |
| very_negative | 147.1 | 2.704% | 532.9 | 26 |


---

## D. Key Level Accuracy

**Days with valid levels:** 385

**Close between callWall and putWall:** 47.8% (N=385)
**Touched callWall (within 0.2%):** 11.4% (44 days)
**Touched putWall (within 0.2%):** 10.4% (40 days)
**Close above gammaFlip:** 77.4% (N=371)

**Above gammaFlip AND up day:** 53.7% (N=287)
**Below gammaFlip AND down day:** 42.9% (N=84)
**GammaFlip total directional accuracy:** 51.2% (N=371)


```
RULE: Price closes between callWall and putWall the vast majority of sessions
Evidence: 47.8% of days (N=385)
Win rate: 47.8%
Action: Use callWall as max upside target and putWall as max downside target. Trades beyond these walls are low probability.
Confidence: HIGH
```

```
RULE: GammaFlip (zeroGamma) is a reliable directional pivot
Evidence: Above flip + up: 53.7%, Below flip + down: 42.9% (N=371)
Win rate: 51.2%
Action: Bias LONG when price is above gammaFlip, SHORT when below. This is the single most reliable regime signal.
Confidence: HIGH
```

---

## E. Candle Patterns at Gamma Bars

**Total candle-at-bar observations:** 795

### Pattern Distribution

| Pattern | Count | Next Day UP% | Confidence |
|---------|-------|-------------|------------|
| body_through_down | 199 | 52.8% (N=195) | MEDIUM |
| body_through_up | 234 | 55.2% (N=221) | HIGH |
| bounce_above | 102 | 45.5% (N=101) | MEDIUM |
| bounce_below | 79 | 53.2% (N=77) | MEDIUM |
| doji_at_bar | 57 | 60.4% (N=53) | MEDIUM |
| wick_rejection_long | 63 | 62.3% (N=61) | MEDIUM |
| wick_rejection_short | 61 | 57.6% (N=59) | MEDIUM |

### Pattern at Support Bars vs Resistance Bars

| Pattern | At Support | Support Next UP% | At Resistance | Resist Next UP% |
|---------|------------|------------------|---------------|-----------------|
| body_through_down | 76 | 43.2% (N=74) | 123 | 58.7% (N=121) |
| body_through_up | 106 | 51.5% (N=101) | 128 | 58.3% (N=120) |
| bounce_above | 41 | 48.8% (N=41) | 61 | 43.3% (N=60) |
| bounce_below | 30 | 53.6% (N=28) | 49 | 53.1% (N=49) |
| doji_at_bar | 27 | 68.0% (N=25) | 30 | 53.6% (N=28) |
| wick_rejection_long | 29 | 50.0% (N=28) | 34 | 72.7% (N=33) |
| wick_rejection_short | 30 | 58.6% (N=29) | 31 | 56.7% (N=30) |


```
RULE: Wick rejection at support bar predicts next-day UP continuation
Evidence: Wick rejection long at support: next day UP 50.0% (N=28)
Win rate: See table
Action: When price wicks to a support gamma bar and closes above it with a long lower wick, bias LONG for next session.
Confidence: LOW
```

---

## F. VIX / DXY / TLT Correlations

**Days with macro data:** 370

### F1. VIX Change vs Bar Bounce Rate

| VIX Change | Days | Avg Bounce Rate | Avg SPX Mag | SPX UP% | Confidence |
|------------|------|-----------------|-------------|---------|------------|
| VIX drop >5% | 85 | 28.4% | 0.810% | 89.4% | MEDIUM |
| VIX drop 2-5% | 58 | 57.1% | 0.362% | 69.0% | MEDIUM |
| VIX drop 0-2% | 62 | 58.2% | 0.343% | 61.3% | MEDIUM |
| VIX rise 0-2% | 37 | 57.9% | 0.280% | 32.4% | LOW |
| VIX rise 2-5% | 55 | 53.0% | 0.463% | 36.4% | MEDIUM |
| VIX spike >5% | 73 | 39.9% | 0.944% | 17.8% | MEDIUM |

### F2. DXY Direction vs GLD Bar Bounce Rate

| DXY Direction | Days w/ GLD touches | Avg GLD Bounce Rate | Confidence |
|---------------|---------------------|---------------------|------------|
| DXY rising | 83 | 59.4% | MEDIUM |
| DXY falling | 87 | 47.8% | MEDIUM |

### F3. TLT Trend vs SPX Direction

| TLT Direction | Days | SPX UP% | Avg SPX Mag | Confidence |
|---------------|------|---------|-------------|------------|
| TLT rising (bonds bid) | 185 | 54.1% | 0.053% | MEDIUM |
| TLT falling (bonds sold) | 185 | 53.5% | 0.017% | MEDIUM |

### F4. VIX Level Impact on Bar Accuracy

| VIX Level | Days | Avg Bounce Rate | SPX UP% | Avg Range% | Confidence |
|-----------|------|-----------------|---------|------------|------------|
| <15 (calm) | 38 | 50.7% | 65.8% | 0.350% | LOW |
| 15-20 (normal) | 224 | 46.3% | 55.8% | 0.443% | HIGH |
| 20-25 (elevated) | 75 | 50.5% | 52.0% | 0.711% | MEDIUM |
| 25-30 (high) | 20 | 52.9% | 30.0% | 0.920% | LOW |
| >30 (extreme) | 13 | 11.9% | 30.8% | 2.425% | LOW |


```
RULE: VIX spikes >5% destroy gamma bar bounce reliability
Evidence: VIX spike >5% avg bounce rate: 39.9% vs calm days: 58.2% (N=73)
Win rate: See table F1
Action: On VIX spike days (>5%), do NOT trust gamma bar bounces. Switch to breakout mode. Reduce position sizes.
Confidence: MEDIUM
```

---

## G. Sector Rotation Signals

**Days with sector data:** 385

### G1. XLK vs SPY Performance and QQQ Gamma Accuracy

| XLK vs SPY | Days w/ QQQ touches | Avg QQQ Bounce Rate | Confidence |
|------------|---------------------|---------------------|------------|
| XLK underperform >0.5% | 54 | 38.6% | MEDIUM |
| XLK underperform 0.1-0.5% | 54 | 58.6% | MEDIUM |
| XLK inline | 50 | 49.3% | MEDIUM |
| XLK outperform 0.1-0.5% | 59 | 36.2% | MEDIUM |
| XLK outperform >0.5% | 49 | 38.1% | LOW |

### G2. XLF vs SPY Performance and DIA Gamma Accuracy

| XLF vs SPY | Days w/ DIA touches | Avg DIA Bounce Rate | Confidence |
|------------|---------------------|---------------------|------------|
| XLF underperform >0.5% | 58 | 52.3% | MEDIUM |
| XLF underperform 0.1-0.5% | 52 | 60.4% | MEDIUM |
| XLF inline | 53 | 54.1% | MEDIUM |
| XLF outperform 0.1-0.5% | 67 | 52.2% | MEDIUM |
| XLF outperform >0.5% | 57 | 61.7% | MEDIUM |


---

## H. Advanced Cross-Factor Analysis

### H1. Triple Factor: Regime + VRP + Bar Size (SPX Only)

Finding the optimal combination for highest bounce rate...

| Regime | VRP | Bar Size | Bounces | Breaks | Bounce% | N |
|--------|-----|----------|---------|--------|---------|---|
| negative | neg (-5 to -2) | 500M-1B | 3 | 8 | 27.3% | 11 |
| negative | pos (2 to 5) | 500M-1B | 10 | 5 | 66.7% | 15 |
| negative | pos (2 to 5) | 1B-2B | 5 | 6 | 45.5% | 11 |
| negative | very_pos (>5) | 500M-1B | 7 | 9 | 43.8% | 16 |
| negative | very_pos (>5) | 1B-2B | 5 | 5 | 50.0% | 10 |
| neutral | very_neg (<-5) | 1B-2B | 7 | 11 | 38.9% | 18 |
| neutral | neg (-5 to -2) | 500M-1B | 9 | 5 | 64.3% | 14 |
| neutral | slight_neg (-2 to 0) | 500M-1B | 14 | 20 | 41.2% | 34 |
| neutral | slight_neg (-2 to 0) | 1B-2B | 6 | 15 | 28.6% | 21 |
| neutral | slight_pos (0 to 2) | 500M-1B | 15 | 15 | 50.0% | 30 |
| neutral | slight_pos (0 to 2) | 1B-2B | 5 | 10 | 33.3% | 15 |
| neutral | slight_pos (0 to 2) | 2B-5B | 4 | 6 | 40.0% | 10 |
| neutral | pos (2 to 5) | 500M-1B | 12 | 23 | 34.3% | 35 |
| neutral | pos (2 to 5) | 1B-2B | 22 | 14 | 61.1% | 36 |
| neutral | very_pos (>5) | 500M-1B | 10 | 4 | 71.4% | 14 |
| neutral | very_pos (>5) | 1B-2B | 5 | 8 | 38.5% | 13 |
| positive | very_neg (<-5) | 1B-2B | 11 | 10 | 52.4% | 21 |
| positive | neg (-5 to -2) | 500M-1B | 5 | 7 | 41.7% | 12 |
| positive | neg (-5 to -2) | 1B-2B | 11 | 5 | 68.8% | 16 |
| positive | slight_neg (-2 to 0) | 500M-1B | 16 | 16 | 50.0% | 32 |
| positive | slight_neg (-2 to 0) | 1B-2B | 9 | 13 | 40.9% | 22 |
| positive | slight_neg (-2 to 0) | 2B-5B | 6 | 4 | 60.0% | 10 |
| positive | slight_pos (0 to 2) | 500M-1B | 17 | 13 | 56.7% | 30 |
| positive | slight_pos (0 to 2) | 1B-2B | 11 | 17 | 39.3% | 28 |
| positive | slight_pos (0 to 2) | 2B-5B | 5 | 6 | 45.5% | 11 |
| positive | slight_pos (0 to 2) | >5B | 3 | 7 | 30.0% | 10 |
| positive | pos (2 to 5) | 500M-1B | 9 | 8 | 52.9% | 17 |
| positive | pos (2 to 5) | 1B-2B | 12 | 12 | 50.0% | 24 |
| positive | pos (2 to 5) | 2B-5B | 8 | 2 | 80.0% | 10 |
| positive | very_pos (>5) | 500M-1B | 2 | 10 | 16.7% | 12 |
| positive | very_pos (>5) | 1B-2B | 5 | 15 | 25.0% | 20 |
| positive | very_pos (>5) | 2B-5B | 2 | 9 | 18.2% | 11 |

**Top 5 highest bounce rate combos (N>=10):**
- positive + pos (2 to 5) + 2B-5B: 80.0% bounce (N=10)
- neutral + very_pos (>5) + 500M-1B: 71.4% bounce (N=14)
- positive + neg (-5 to -2) + 1B-2B: 68.8% bounce (N=16)
- negative + pos (2 to 5) + 500M-1B: 66.7% bounce (N=15)
- neutral + neg (-5 to -2) + 500M-1B: 64.3% bounce (N=14)

**Bottom 5 lowest bounce rate (= best break setups):**
- positive + very_pos (>5) + 500M-1B: 16.7% bounce (N=12)
- positive + very_pos (>5) + 2B-5B: 18.2% bounce (N=11)
- positive + very_pos (>5) + 1B-2B: 25.0% bounce (N=20)
- negative + neg (-5 to -2) + 500M-1B: 27.3% bounce (N=11)
- neutral + slight_neg (-2 to 0) + 1B-2B: 28.6% bounce (N=21)

### H2. Day of Week Effects

| Day | Days | UP% | Avg Mag | Avg Range% | Bounce Rate |
|-----|------|-----|---------|------------|-------------|
| Mon | 74 | 63.5% | 0.526% | 1.082% | 51.9% (N=135) |
| Tue | 79 | 57.0% | 0.524% | 1.048% | 46.1% (N=165) |
| Wed | 79 | 51.9% | 0.591% | 1.157% | 46.4% (N=168) |
| Thu | 75 | 44.0% | 0.592% | 1.123% | 45.3% (N=161) |
| Fri | 78 | 55.1% | 0.668% | 1.130% | 37.3% (N=166) |

### H3. Monthly Patterns

| Month | Days | UP% | Avg Mag | Avg Range% |
|-------|------|-----|---------|------------|
| Jan | 37 | 51.4% | 0.446% | 0.885% |
| Feb | 38 | 57.9% | 0.667% | 1.147% |
| Mar | 43 | 44.2% | 0.783% | 1.533% |
| Apr | 28 | 57.1% | 1.494% | 2.614% |
| May | 21 | 61.9% | 0.447% | 1.085% |
| Jun | 20 | 60.0% | 0.428% | 0.831% |
| Jul | 22 | 59.1% | 0.349% | 0.668% |
| Aug | 21 | 52.4% | 0.463% | 0.769% |
| Sep | 38 | 55.3% | 0.355% | 0.828% |
| Oct | 46 | 47.8% | 0.484% | 0.898% |
| Nov | 39 | 59.0% | 0.558% | 1.075% |
| Dec | 32 | 56.3% | 0.415% | 0.816% |

### H4. Regime Persistence and Reversal

| Regime | Avg Streak | Max Streak | Total Streaks |
|--------|------------|------------|---------------|
| negative | 1.9 | 11 | 35 |
| neutral | 2.5 | 15 | 57 |
| positive | 4.0 | 27 | 38 |
| very_negative | 2.4 | 5 | 11 |

### H5. GLD Gamma Bar Analysis

**GLD touches:** 202
**GLD overall bounce rate:** 52.0%

| GLD Regime | Touches | Bounce Rate | Confidence |
|------------|---------|-------------|------------|
| neutral | 3 | 100.0% | LOW |
| positive | 199 | 51.3% | MEDIUM |

| GLD VRP | Touches | Bounce Rate | Confidence |
|---------|---------|-------------|------------|
| very_neg (<-5) | 50 | 54.0% | MEDIUM |
| neg (-5 to -2) | 17 | 47.1% | LOW |
| slight_neg (-2 to 0) | 15 | 60.0% | LOW |
| slight_pos (0 to 2) | 30 | 53.3% | LOW |
| pos (2 to 5) | 56 | 51.8% | MEDIUM |
| very_pos (>5) | 29 | 44.8% | LOW |


---

## Statistical Trading Rules

Rules ordered by confidence and actionability. Only rules with N >= 50 for HIGH confidence are included.

### SR1: Gamma bars are reliable support/resistance levels
- **Evidence:** Overall bounce rate across 2269 touches on 5 symbols over 399 days
- **N:** 2269 | **Win Rate:** 49.1% | **Confidence:** HIGH
- **Action:** Enter at fat gamma bars. They are statistically more likely to bounce than break.

### SR2: Fat bars (>2B SPX) bounce significantly more than thin bars (<500M)
- **Evidence:** Fat bars: 48.8% bounce (N=125). Thin bars: 43.8% bounce (N=32)
- **N:** 157 | **Win Rate:** Fat: 48.8%, Thin: 43.8% | **Confidence:** MEDIUM
- **Action:** Prioritize entries at bars with |gamma| > 2B SPX. Use thin bars as breakout targets, not bounce entries. For GLD: >50M = fat, <5M = thin.

### SR3: Positive gamma regime increases bounce probability
- **Evidence:** Positive regime: 47.2% bounce (N=324). Negative regime: 37.7% bounce (N=175)
- **N:** 499 | **Win Rate:** Pos: 47.2%, Neg: 37.7% | **Confidence:** HIGH
- **Action:** In positive gamma: trust bounces, use CONFIRM mode for extra safety. In negative gamma: expect bars to break, use LEVEL mode for breakout entries. Bars become breakout accelerators in negative gamma.

### SR4: Price travels from one fat gamma bar to the next most sessions
- **Evidence:** 57.9% of days price covered the distance between the two nearest fat bars. Avg bar distance: 17.0pts, avg range: 67.8pts
- **N:** 385 | **Win Rate:** 57.9% | **Confidence:** HIGH
- **Action:** Set TP at the next fat gamma bar in trade direction. The vacuum between bars has little gamma = price accelerates. This is L58 validated statistically.

### SR5: GammaFlip (zeroGamma) is a reliable directional pivot
- **Evidence:** Above gammaFlip + UP day: 53.7% (N=287). Below gammaFlip + DOWN day: 42.9% (N=84). Total accuracy: 51.2%
- **N:** 371 | **Win Rate:** 51.2% | **Confidence:** HIGH
- **Action:** Use gammaFlip as primary bias indicator. LONG bias above, SHORT bias below. This overrides other signals when clear.

### SR6: Price closes between callWall and putWall most sessions
- **Evidence:** 47.8% of sessions close between the walls (N=385)
- **N:** 385 | **Win Rate:** 47.8% | **Confidence:** HIGH
- **Action:** Use callWall as maximum TP for longs, putWall as maximum TP for shorts. Trades targeting beyond these walls have low probability.

### SR7: Negative VRP (IV > RV) predicts momentum (breakdowns), positive VRP predicts mean-reversion
- **Evidence:** VRP < -2: DOWN 34.4% (N=93). VRP > +2: UP 44.1% (N=145)
- **N:** 238 | **Win Rate:** Neg VRP DOWN: 34.4%, Pos VRP UP: 44.1% | **Confidence:** HIGH
- **Action:** VRP < -2: favor SHORT, do NOT fade momentum (L1 validated). VRP > +2: favor LONG, bounce plays. VRP close to 0: no directional edge.

### SR8: Support bars (positive gamma) bounce more than resistance bars (negative gamma)
- **Evidence:** Support bounce: 49.8% (N=498). Resistance bounce: 49.0% (N=1771)
- **N:** 2269 | **Win Rate:** Support: 49.8%, Resist: 49.0% | **Confidence:** HIGH
- **Action:** At support (positive gamma): LONG entries with CONFIRM mode. At resistance (negative gamma): expect break, use LEVEL mode for SHORT breakout below or rejection SHORT at the bar.

### SR9: High VIX (>25) reduces gamma bar reliability
- **Evidence:** VIX <15 avg bounce rate: 50.7% (N=35). VIX >25 avg bounce rate: 41.0% (N=24)
- **N:** 59 | **Win Rate:** Calm: 50.7%, Stress: 41.0% | **Confidence:** MEDIUM
- **Action:** When VIX >25, reduce confidence in gamma bar bounces. Widen SL by 50%. Prefer breakout entries over bounce entries. Use smaller position sizes.

### SR10: Bars near current price (<0.5% away) bounce more reliably than distant bars
- **Evidence:** Near bars (<0.5%): 39.4% bounce (N=33). Far bars (>2%): 45.8% bounce (N=707)
- **N:** 740 | **Win Rate:** Near: 39.4%, Far: 45.8% | **Confidence:** HIGH
- **Action:** Place orders at the nearest fat gamma bars to current price (L97/L102 validated). Far bars are less reliable because the gamma landscape may shift before price reaches them.

### SR11: Negative gamma regime expands daily range significantly
- **Evidence:** Negative gamma avg range: 1.788%. Positive gamma avg range: 0.744%. (N=243)
- **N:** 243 | **Win Rate:** Neg: 1.788%, Pos: 0.744% | **Confidence:** HIGH
- **Action:** In negative gamma: widen TP targets (range is larger), widen SL (more noise). In positive gamma: tighter targets are fine, bars hold. SCALP in positive gamma, INTRADAY/SWING in negative.

### SR12: DXY direction inversely affects GLD gamma bar behavior
- **Evidence:** DXY rising: GLD bounce rate 59.4% (N=83). DXY falling: GLD bounce rate 47.8% (N=87)
- **N:** 170 | **Win Rate:** DXY up: 59.4%, DXY down: 47.8% | **Confidence:** MEDIUM
- **Action:** When DXY is falling, GLD gamma bars are more reliable (gold supported). When DXY rising, GLD gamma bars break more often — reduce GLD long conviction.

### SR13: Wick rejection at support gamma bar predicts next-day continuation UP
- **Evidence:** Wick rejection long at support bars: next day UP 50.0% (N=28)
- **N:** 28 | **Win Rate:** 50.0% | **Confidence:** LOW
- **Action:** When intraday price wicks to a support gamma bar but closes above it with a long lower wick, this is a high-probability LONG setup. Enter LONG at close or next open.

### SR14: Body through a gamma bar (break) predicts next-day continuation in break direction
- **Evidence:** Body through down: next day DOWN 47.2% (N=195)
- **N:** 195 | **Win Rate:** 47.2% | **Confidence:** MEDIUM
- **Action:** When price opens above a gamma bar and closes below it (body through down), the bar is broken. Bias SHORT for next session. TP = next fat bar below. Do not try to long the same level again.

### SR15: Gamma regimes persist for multiple days — trend with them
- **Evidence:** Average streak lengths: negative: 1.9d, very_negative: 2.4d, neutral: 2.5d, positive: 4.0d
- **N:** 141 | **Win Rate:** N/A (persistence metric) | **Confidence:** MEDIUM
- **Action:** Once a regime is established, it tends to persist. Trade WITH the regime, not against it. Regime changes are the strongest reversal signals — act immediately on regime transitions.

### SR16: GLD fat bars (>50M) are significantly more reliable than thin bars (<5M)
- **Evidence:** GLD fat: 52.2% bounce (N=159). GLD thin: N/A bounce (N=0)
- **N:** 159 | **Win Rate:** Fat: 52.2%, Thin: N/A | **Confidence:** MEDIUM
- **Action:** For XAUUSD: only enter at GLD bars >50M for SWING/INTRADAY. >5M is minimum for SCALP. Bars <5M have no statistical edge.

### SR17: DIA fat bars (>30M) are more reliable than thin bars (<5M)
- **Evidence:** DIA fat: 48.1% bounce (N=54). DIA thin: 46.2% bounce (N=26)
- **N:** 80 | **Win Rate:** Fat: 48.1%, Thin: 46.2% | **Confidence:** MEDIUM
- **Action:** For US30: enter at DIA bars >30M for SWING, >5M for INTRADAY/SCALP.

### SR18: Wednesday and Thursday have slightly larger ranges (opex-related)
- **Evidence:** Mon avg range: 1.082%, Wed: 1.157%, Fri: 1.130%
- **N:** 385 | **Win Rate:** N/A (range metric) | **Confidence:** HIGH
- **Action:** Mid-week: slightly wider SL acceptable. Friday: tighter targets, potential for pinning at gamma bars near opex.


---

## Summary Statistics

- **Total trading days analyzed:** 399
- **Date range:** 2024-09-04 to 2026-04-10
- **Total gamma bar touches (all symbols):** 2269
- **Overall bounce rate:** 49.1%
- **SPX touches:** 795, bounce rate: 45.2%
- **QQQ touches:** 377, bounce rate: 45.4%
- **SPY touches:** 474, bounce rate: 53.0%
- **DIA touches:** 421, bounce rate: 54.4%
- **GLD touches:** 202, bounce rate: 52.0%
- **Level-to-level travel rate:** 57.9%
- **GammaFlip directional accuracy:** 51.2%
- **Close between walls:** 47.8%
- **Statistical rules generated:** 18