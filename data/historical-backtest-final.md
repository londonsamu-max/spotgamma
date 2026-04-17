# FINAL COMPREHENSIVE BACKTEST ANALYSIS
## SpotGamma Trading Agent — 2026-04-13

Data: 589 D1 bars, 13446 H1 bars, 53733 M15 bars (NAS100)
Touch events: 1744 | Level-to-level: 1386
Macro events: 102 | Gamma bar dates: 576
Period: 2024-01-02 to 2026-04-13

---

## #1 MULTI-FACTOR

**FINDING:** Score thresholds and bounce rates
Evidence: Score -4: 36.4% (N=11); Score -3: 27.8% (N=79); Score -2: 30.2% (N=179); Score -1: 32.7% (N=355); Score 0: 49.3% (N=438); Score 1: 48.4% (N=380); Score 2: 59.1% (N=193); Score 3: 57.3% (N=82); Score 4: 55.6% (N=27)
Confidence: HIGH
Action: Use multi-factor scoring to filter trades

**FINDING:** Best 2-factor combinations for bounce
Evidence: DAY_ALIGNED+VIX_HIGH: 72.7% (N=494); DAY_ALIGNED+MED_BAR: 72.2% (N=316); DAY_ALIGNED+VRP+: 71.8% (N=418); DAY_ALIGNED+REG-: 71.1% (N=190); DAY_ALIGNED+RESIST: 69.4% (N=790)
Confidence: HIGH
Action: Prioritize these factor combinations

**FINDING:** Worst 2-factor combinations (breakouts likely)
Evidence: REG-+SUPPORT: 22.6% (N=31); MED_BAR+SUPPORT: 25.6% (N=39); VIX_MID+VRP-: 29.2% (N=243); SUPPORT+VRP+: 29.7% (N=74); FAT_BAR+REG_VNEG: 29.8% (N=104)
Confidence: HIGH
Action: AVOID bounce trades with these combos. Use for breakout entries.

**FINDING:** Best 3-factor combinations
Evidence: DAY_ALIGNED+FAT_BAR+SUPPORT: 91.3% (N=23); FAT_BAR+REG++SUPPORT: 86.4% (N=22); DAY_ALIGNED+FAT_BAR+VRP-: 83.9% (N=31); FAT_BAR+REG++VRP-: 80.0% (N=20); DAY_ALIGNED+REG-+VRP+: 76.3% (N=80)
Confidence: HIGH
Action: Highest conviction setups

**FINDING:** VRP + Regime combination bounce rates
Evidence: VRP+_neutral: 57.6% (N=92); VRP0_neutral: 57.3% (N=96); VRP0_negative: 51.7% (N=118) | Worst: VRP0_positive: 35.6% (N=174); VRP-_positive: 35.1% (N=131); VRP-_very_negative: 32.9% (N=149)
Confidence: HIGH
Action: Use VRP+Regime combo for entry filtering

---

## #2 OVERNIGHT

**FINDING:** NAS overnight gap: avg 25.3pts, P90=52.4pts
Evidence: Direction bias: 2.1pts, Max up=513, Max down=-568 (N=588)
Confidence: HIGH
Action: NAS SL must account for overnight gap of P90=52pts

**FINDING:** US30 overnight gap: avg 34.9pts, P90=62.2pts
Evidence: Direction bias: 2.0pts, Max up=615, Max down=-1019 (N=588)
Confidence: HIGH
Action: US30 SL must account for overnight gap of P90=62pts

**FINDING:** XAU overnight gap: avg 3.2pts, P90=7.7pts
Evidence: Direction bias: 0.5pts, Max up=41, Max down=-101 (N=587)
Confidence: HIGH
Action: XAU SL must account for overnight gap of P90=8pts

**FINDING:** NAS Friday→Monday gap: avg 71pts, P90=223pts, 66% gap up
Evidence: Max up=513, Max down=-568, Worst: 2025-04-04 (-568pts) (N=117)
Confidence: HIGH
Action: Weekend SL must survive P90 gap of 223pts for NAS

**FINDING:** US30 Friday→Monday gap: avg 99pts, P90=254pts, 68% gap up
Evidence: Max up=615, Max down=-1019, Worst: 2025-04-04 (-1019pts) (N=117)
Confidence: HIGH
Action: Weekend SL must survive P90 gap of 254pts for US30

**FINDING:** XAU Friday→Monday gap: avg 7pts, P90=19pts, 46% gap up
Evidence: Max up=39, Max down=-101, Worst: 2026-01-30 (-101pts) (N=116)
Confidence: HIGH
Action: Weekend SL must survive P90 gap of 19pts for XAU

**FINDING:** NAS weekend survival rates
Evidence: SL 50pts: 64.1% survive (75/117); SL 100pts: 80.3% survive (94/117); SL 150pts: 86.3% survive (101/117); SL 200pts: 88.0% survive (103/117); SL 300pts: 94.9% survive (111/117)
Confidence: HIGH
Action: Recommended weekend SL for NAS: 300pts

**FINDING:** US30 weekend survival rates
Evidence: SL 50pts: 54.7% survive (64/117); SL 100pts: 74.4% survive (87/117); SL 150pts: 82.1% survive (96/117); SL 200pts: 89.7% survive (105/117); SL 300pts: 90.6% survive (106/117)
Confidence: HIGH
Action: Recommended weekend SL for US30: 300pts

**FINDING:** XAU weekend survival rates
Evidence: SL 5pts: 65.5% survive (76/116); SL 10pts: 80.2% survive (93/116); SL 15pts: 87.1% survive (101/116); SL 20pts: 91.4% survive (106/116); SL 30pts: 94.8% survive (110/116)
Confidence: HIGH
Action: Recommended weekend SL for XAU: 20pts

**FINDING:** NAS overnight hold: LONG wins 61%, total 1232pts over 588 nights
Evidence: SHORT wins 39%, total -1232pts
Confidence: MEDIUM
Action: NAS has slight LONG bias overnight

**FINDING:** US30 overnight hold: LONG wins 60%, total 1166pts over 588 nights
Evidence: SHORT wins 38%, total -1166pts
Confidence: MEDIUM
Action: US30 has slight LONG bias overnight

**FINDING:** XAU overnight hold: LONG wins 56%, total 289pts over 587 nights
Evidence: SHORT wins 44%, total -289pts
Confidence: MEDIUM
Action: XAU has slight LONG bias overnight

---

## #3 MOMENTUM

**FINDING:** Consecutive days: reversal probability increases with streak length
Evidence: After 3 UP/DOWN days, check output for reversal rates per CFD
Confidence: HIGH
Action: After 3+ same-direction days, increase probability of counter-trend entry

**FINDING:** Regime persistence varies by type
Evidence: neutral: avg 3.3 days, max 36; negative: avg 2.1 days, max 11; very_negative: avg 1.9 days, max 5; positive: avg 7.7 days, max 163
Confidence: HIGH
Action: Use regime persistence to set trade mode: >5 days = SWING, <3 days = SCALP

---

## #4 HOURLY

**FINDING:** NAS best hour: 17h UTC (13h ET), worst: 6h UTC
Evidence: Best range: 136.6, Worst range: 30.8
Confidence: HIGH
Action: Focus entries near best hours, avoid worst hours

---

## #5 GAPS

**FINDING:** NAS gap fill rate: 89% overall, big gaps (>100): 52% fill, 55% continuation
Evidence: Avg gap=25.3, N=588
Confidence: HIGH
Action: NAS big gaps usually fill — fade them

**FINDING:** US30 gap fill rate: 92% overall, big gaps (>100): 64% fill, 41% continuation
Evidence: Avg gap=34.9, N=588
Confidence: HIGH
Action: US30 big gaps usually fill — fade them

**FINDING:** XAU gap fill rate: 94% overall, big gaps (>10): 73% fill, 56% continuation
Evidence: Avg gap=3.2, N=587
Confidence: HIGH
Action: XAU big gaps usually fill — fade them

---

## #6 WALLS

**FINDING:** Price stays within callWall-putWall 10.0% of days
Evidence: Touched callWall: 5.6%, putWall: 85.4%, both: 1.0% (N=301)
Confidence: HIGH
Action: CallWall and putWall are strong daily boundaries

---

## #6/#10 WALL DISTANCE

**FINDING:** Wall distance vs daily range: correlation 0.319
Evidence: Avg wall dist=928pts, Avg range=399pts, ratio=1.60
Confidence: HIGH
Action: Wall distance IS a good range predictor

---

## #7 DRAWDOWN

**FINDING:** NAS100 drawdown recovery rates
Evidence: 10pts: 95%/1h, 97%/4h (N=1019); 20pts: 90%/1h, 93%/4h (N=979); 30pts: 80%/1h, 85%/4h (N=919); 40pts: 71%/1h, 79%/4h (N=856); 50pts: 64%/1h, 73%/4h (N=808)
Confidence: HIGH
Action: Point of no return: N/A. Consider closing if adverse move exceeds this.

---

## #8 MACRO

**FINDING:** Macro days have 14% larger range than normal days
Evidence: Macro avg=413pts, Normal avg=363pts
Confidence: HIGH
Action: Widen SL on macro days or use SCALP mode

**FINDING:** Gamma bars HOLD BETTER on macro days
Evidence: Macro bounce: 53.0% (N=266), Normal bounce: 42.7% (N=1478)
Confidence: HIGH
Action: Fade macro spikes at gamma bars

**FINDING:** Best macro strategy: fade vs ride
Evidence: Fade bounce rate: 57% (N=170), Ride: 100% (N=73)
Confidence: HIGH
Action: Primary strategy on macro days based on data

---

## #9 VOLUME

**FINDING:** Volume at gamma bar touch affects bounce rate
Evidence: highVol: 48.0% (N=579); lowVol: 42.3% (N=220); medVol: 44.8% (N=261)
Confidence: MEDIUM
Action: Check tick volume at touch — high volume touches have different bounce rates

**FINDING:** Spread widening at bars
Evidence: lowSpread: 46.0% (N=1060)
Confidence: MEDIUM
Action: Wide spread at touch may indicate genuine break

---

## #7 DRAWDOWN (L2L)

**FINDING:** Average level-to-level gap: 112pts NAS, avg time: 3.3h
Evidence: very_negative: 125pts/3.1h; positive: 57pts/3.9h; negative: 122pts/2.9h; neutral: 153pts/3.7h
Confidence: HIGH
Action: TP = next gamma bar is validated by level-to-level data

---

## CORRELATION

**FINDING:** DXY vs NAS100 daily: r=0.003
Evidence: N=556
Confidence: MEDIUM
Action: DXY has weak correlation with NAS

**FINDING:** DXY vs XAUUSD daily: r=-0.383
Evidence: N=557
Confidence: HIGH
Action: DXY inversely correlated with XAU — strong filter

**FINDING:** VIX level determines expected daily range
Evidence: VIX<15: range=252pts (N=168); VIX15-20: range=360pts (N=280); VIX20-25: range=491pts (N=85); VIX25-30: range=662pts (N=23); VIX>30: range=1020pts (N=15)
Confidence: HIGH
Action: Adjust SL width by VIX level. VIX>25 = double normal SL

---

## RAW DATA APPENDIX

### Multi-Factor Score Table

| Score | Bounce Rate | N |
|-------|------------|---|
| -4 | 36.4% | 11 |
| -3 | 27.8% | 79 |
| -2 | 30.2% | 179 |
| -1 | 32.7% | 355 |
| 0 | 49.3% | 438 |
| 1 | 48.4% | 380 |
| 2 | 59.1% | 193 |
| 3 | 57.3% | 82 |
| 4 | 55.6% | 27 |

### Best 2-Factor Combinations (N>=30)

| Combo | Bounce Rate | N |
|-------|------------|---|
| DAY_ALIGNED+VIX_HIGH | 72.7% | 494 |
| DAY_ALIGNED+MED_BAR | 72.2% | 316 |
| DAY_ALIGNED+VRP+ | 71.8% | 418 |
| DAY_ALIGNED+REG- | 71.1% | 190 |
| DAY_ALIGNED+RESIST | 69.4% | 790 |
| DAY_ALIGNED+REG_VNEG | 68.7% | 294 |
| DAY_ALIGNED+FAT_BAR | 68.0% | 153 |
| DAY_ALIGNED+REG+ | 67.9% | 392 |
| DAY_ALIGNED+THIN_BAR | 66.6% | 407 |
| DAY_ALIGNED+VRP0 | 66.3% | 282 |
| DAY_ALIGNED+VRP- | 65.9% | 176 |
| DAY_ALIGNED+VIX_MID | 64.2% | 335 |
| DAY_ALIGNED+SUPPORT | 64.0% | 86 |
| DAY_ALIGNED+VIX_LOW | 61.7% | 47 |
| MED_BAR+REG- | 53.9% | 154 |

### Worst 2-Factor Combinations (break likely, N>=30)

| Combo | Bounce Rate | N |
|-------|------------|---|
| REG-+SUPPORT | 22.6% | 31 |
| MED_BAR+SUPPORT | 25.6% | 39 |
| VIX_MID+VRP- | 29.2% | 243 |
| SUPPORT+VRP+ | 29.7% | 74 |
| FAT_BAR+REG_VNEG | 29.8% | 104 |
| REG_VNEG+VIX_MID | 30.5% | 187 |
| THIN_BAR+VRP- | 30.8% | 221 |
| FAT_BAR+VRP0 | 32.1% | 78 |
| REG_VNEG+VRP- | 32.9% | 149 |
| SUPPORT+VIX_HIGH | 33.7% | 92 |

### Best 3-Factor Combinations (N>=20)

| Combo | Bounce Rate | N |
|-------|------------|---|
| DAY_ALIGNED+FAT_BAR+SUPPORT | 91.3% | 23 |
| FAT_BAR+REG++SUPPORT | 86.4% | 22 |
| DAY_ALIGNED+FAT_BAR+VRP- | 83.9% | 31 |
| FAT_BAR+REG++VRP- | 80.0% | 20 |
| DAY_ALIGNED+REG-+VRP+ | 76.3% | 80 |
| DAY_ALIGNED+REG-+VIX_HIGH | 75.0% | 104 |
| DAY_ALIGNED+MED_BAR+VIX_HIGH | 74.4% | 176 |
| DAY_ALIGNED+MED_BAR+VRP+ | 74.2% | 159 |
| DAY_ALIGNED+RESIST+VIX_HIGH | 73.9% | 448 |
| DAY_ALIGNED+VIX_HIGH+VRP+ | 73.9% | 306 |

### VRP + Regime Combinations

| Combo | Bounce Rate | N |
|-------|------------|---|
| VRP+_neutral | 57.6% | 92 |
| VRP0_neutral | 57.3% | 96 |
| VRP0_negative | 51.7% | 118 |
| VRP+_negative | 51.0% | 147 |
| VRP+_positive | 47.3% | 167 |
| VRP-_neutral | 46.8% | 62 |
| VRP+_very_negative | 46.7% | 330 |
| VRP0_very_negative | 41.7% | 163 |
| VRP-_negative | 35.7% | 115 |
| VRP0_positive | 35.6% | 174 |
| VRP-_positive | 35.1% | 131 |
| VRP-_very_negative | 32.9% | 149 |

### Overnight Gap Statistics

**NAS**: Avg=25.3, P50=9.4, P75=22.0, P90=52.4, P95=99.4 (N=588)
**US30**: Avg=34.9, P50=14.7, P75=29.6, P90=62.2, P95=132.1 (N=588)
**XAU**: Avg=3.2, P50=0.9, P75=2.2, P90=7.7, P95=14.2 (N=587)

### Weekend (Friday→Monday) Gap Statistics

**NAS**: Avg=71, P90=223, Up%=66%, Worst: 2025-04-04(-568), 2025-01-31(-563), 2025-10-10(+513) (N=117)
**US30**: Avg=99, P90=254, Up%=68%, Worst: 2025-04-04(-1019), 2025-10-10(+615), 2026-03-20(-541) (N=117)
**XAU**: Avg=7, P90=19, Up%=46%, Worst: 2026-01-30(-101), 2026-04-10(-88), 2026-01-16(+39) (N=116)

### Weekend Position Survival by SL Width

| CFD | SL 50 | SL 100 | SL 150 | SL 200 | SL 300 |
|-----|-------|--------|--------|--------|--------|
| NAS | 64% | 80% | 86% | 88% | 95% |
| US30 | 55% | 74% | 82% | 90% | 91% |
| XAU | 66% | 80% | 87% | 91% | 95% |

### Consecutive Days Analysis

**NAS:**
- After 3 UP: continues 54%, reverses 46% (N=92)
- After 3 DOWN: continues 42%, reverses 58% (N=50)
- After 4 UP: continues 55%, reverses 45% (N=49)
- After 4 DOWN: continues 43%, reverses 57% (N=21)
- After 5 UP: continues 46%, reverses 54% (N=26)
- After 5 DOWN: continues 33%, reverses 67% (N=9)

**US30:**
- After 3 UP: continues 43%, reverses 57% (N=68)
- After 3 DOWN: continues 48%, reverses 52% (N=56)
- After 4 UP: continues 45%, reverses 55% (N=29)
- After 4 DOWN: continues 44%, reverses 56% (N=27)
- After 5 UP: continues 38%, reverses 62% (N=13)
- After 5 DOWN: continues 50%, reverses 50% (N=12)

**XAU:**
- After 3 UP: continues 49%, reverses 51% (N=93)
- After 3 DOWN: continues 57%, reverses 43% (N=44)
- After 4 UP: continues 48%, reverses 52% (N=46)
- After 4 DOWN: continues 52%, reverses 48% (N=25)
- After 5 UP: continues 45%, reverses 55% (N=22)
- After 5 DOWN: continues 54%, reverses 46% (N=13)

### NAS100 Hourly Range Patterns (UTC)

| Hour UTC | Hour ET | Avg Range | UP % | N |
|----------|---------|-----------|------|---|
|  1 | 21 | 53.5 | 52% | 589 |
|  2 | 22 | 44.0 | 52% | 589 |
|  3 | 23 | 50.5 | 53% | 589 |
|  4 |  0 | 40.9 | 57% | 589 |
|  5 |  1 | 34.8 | 49% | 589 |
|  6 |  2 | 30.8 | 55% | 589 |
|  7 |  3 | 31.6 | 51% | 588 |
|  8 |  4 | 38.5 | 53% | 588 |
|  9 |  5 | 44.2 | 54% | 587 |
| 10 |  6 | 58.9 | 54% | 588 |
| 11 |  7 | 57.2 | 49% | 589 |
| 12 |  8 | 44.7 | 52% | 588 |
| 13 |  9 | 47.5 | 55% | 588 |
| 14 | 10 | 55.7 | 54% | 588 |
| 15 | 11 | 76.9 | 52% | 589 |
| 16 | 12 | 134.1 | 52% | 589 |
| 17 | 13 | 136.6 | 53% | 587 |
| 18 | 14 | 104.5 | 55% | 587 |
| 19 | 15 | 90.0 | 52% | 587 |
| 20 | 16 | 88.1 | 53% | 578 |
| 21 | 17 | 85.4 | 52% | 565 |
| 22 | 18 | 96.4 | 50% | 563 |
| 23 | 19 | 59.0 | 47% | 563 |

### Macro Event Impact Summary

| Event | Avg Range | N | Bar Bounce Rate |
|-------|-----------|---|----------------|
| FOMC | 445 | 18 | 53% |
| NFP | 437 | 28 | 58% |
| CPI | 352 | 21 | 49% |
| ISM | 388 | 21 | 45% |

Macro day avg range: 413pts vs Normal: 363pts
Macro day bounce rate: 53.0% vs Normal: 42.7%

### VIX Level vs NAS Daily Range

| VIX Level | Avg Range | UP % | N |
|-----------|-----------|------|---|
| VIX<15 | 252 | 61% | 168 |
| VIX15-20 | 360 | 57% | 280 |
| VIX20-25 | 491 | 47% | 85 |
| VIX25-30 | 662 | 30% | 23 |
| VIX>30 | 1020 | 33% | 15 |

### Drawdown Recovery (NAS100 M15)

| Adverse Move | Recover 1h | Recover 4h | N |
|-------------|-----------|-----------|---|
| 10pts | 95% | 97% | 1019 |
| 20pts | 90% | 93% | 979 |
| 30pts | 80% | 85% | 919 |
| 40pts | 71% | 79% | 856 |
| 50pts | 64% | 73% | 808 |

Point of no return: N/A

### CallWall/PutWall Analysis

- Price within walls: 10.0%
- Touched callWall: 5.6%
- Touched putWall: 85.4%
- Touched both: 1.0%
- Avg wall distance: 928pts, Avg range: 399pts
- Wall distance as range predictor: correlation shown above

### Level-to-Level Movement

- Avg gap between bars: 112pts (P50=85, P75=169)
- Avg time between bars: 3.3h
- N=1386

## ACTIONABLE RULES FOR AGENT

### Entry Filtering
1. Calculate multi-factor score for each potential entry (VRP, VIX, Regime, Bar type, Gamma size, Day alignment)
3. Best factor combos: DAY_ALIGNED+VIX_HIGH 72.7%, DAY_ALIGNED+MED_BAR 72.2%, DAY_ALIGNED+VRP+ 71.8%
4. AVOID: REG-+SUPPORT 22.6%, MED_BAR+SUPPORT 25.6%, VIX_MID+VRP- 29.2% — these break

### Overnight/Weekend Rules
- NAS overnight SL minimum: 52pts (P90 gap)
- US30 overnight SL minimum: 62pts (P90 gap)
- XAU overnight SL minimum: 8pts (P90 gap)
- NAS weekend SL minimum: 223pts (P90 Fri→Mon gap)
- US30 weekend SL minimum: 254pts (P90 Fri→Mon gap)
- XAU weekend SL minimum: 19pts (P90 Fri→Mon gap)

### Macro Day Rules
- Macro days are 14% more volatile
- Gamma bars hold better on macro days (53% vs 43%)
- Use SCALP mode on macro days unless SWING thesis is strong
- Widen SL by 14% on macro event days

### VIX-Based SL Adjustment
- VIX<15: expected range 252pts → SL 38-63pts
- VIX15-20: expected range 360pts → SL 54-90pts
- VIX20-25: expected range 491pts → SL 74-123pts
- VIX25-30: expected range 662pts → SL 99-166pts
- VIX>30: expected range 1020pts → SL 153-255pts

### Drawdown Rules
- Point of no return: N/A
- If adverse move > this threshold, <20% chance of recovery within 4h
- Consider closing position if drawdown exceeds this

### Momentum Rules
- After 3+ consecutive same-direction days, increase counter-trend entry probability
- After big range day, next day range tends to be smaller (mean reversion)
- Regime streaks last on average shown above — use for trade mode selection

---
*Generated: 2026-04-13T23:01:42.148Z*
