# SpotGamma Gamma Bar Backtest Results

**Generated:** 2026-04-13
**Data Range:** 2024-01-23 to 2026-04-10 (576 days with gamma data)
**MT5 Candle Data:** 589 daily, 13,446 hourly, 53,733 fifteen-min bars per CFD
**Total Touch Events:** 1,744 (NAS100: 1,060, US30: 325, XAUUSD: 359)

---

## ANALYSIS 1: BOUNCE vs BREAK at Gamma Bars (N=1,744)

### Overall Results
- **Bounce rate: 44.3%** (773/1,744)
- **Break rate: 55.7%** (971/1,744)
- Gamma bars are broken MORE often than they hold at the daily close level

### By CFD
| CFD | N | Bounce% | Break% |
|-----|---|---------|--------|
| NAS100 | 1,060 | 46.0% | 54.0% |
| US30 | 325 | 45.5% | 54.5% |
| XAUUSD | 359 | 37.9% | 62.1% |

RULE: XAUUSD gamma bars break 62% of the time -- significantly worse than NAS/US30
Evidence: 37.9% bounce rate vs 46% NAS100, 45.5% US30 (N=359)
Confidence: HIGH (N=359)
Action: Use wider SL and lower conviction on XAU gamma bar entries. Prefer SHORT direction at XAU bars.

### By Bar Type
| Type | N | Bounce% | Break% |
|------|---|---------|--------|
| Support (green) | 166 | 37.3% | 62.7% |
| Resistance (red) | 1,578 | 45.0% | 55.0% |

RULE: Support bars break 63% of the time; resistance bars break 55%
Evidence: Support 37.3% bounce (N=166), Resistance 45.0% bounce (N=1,578)
Confidence: HIGH (N=1,578 for resistance)
Action: Support bars are WEAKER than resistance bars. Don't trust support bars for LONG entries without strong confirmation (HIRO, institutional flow).

### By Gamma Size
| Gamma Size | N | Bounce% | Break% |
|------------|---|---------|--------|
| <500M | 1,433 | 44.5% | 55.5% |
| 500M-1B | 215 | 42.3% | 57.7% |
| 1B-2B | 70 | 47.1% | 52.9% |
| >2B | 26 | 38.5% | 61.5% |

RULE: Gamma bar SIZE does not significantly improve bounce rate at daily timeframe
Evidence: <500M: 44.5%, 500M-1B: 42.3%, 1B-2B: 47.1%, >2B: 38.5%
Confidence: MEDIUM (1B-2B N=70, >2B N=26)
Action: At daily resolution, fat bars don't bounce more. The edge is intraday (see Analysis 3).

### By Regime
| Regime | N | Bounce% | Break% |
|--------|---|---------|--------|
| Neutral | 250 | **54.8%** | 45.2% |
| Negative | 380 | 46.6% | 53.4% |
| Positive | 472 | 39.6% | 60.4% |
| Very Negative | 642 | 42.2% | 57.8% |

RULE: Neutral regime has the HIGHEST bounce rate (54.8%). Positive regime has the LOWEST (39.6%).
Evidence: Neutral 54.8% (N=250), Positive 39.6% (N=472)
Confidence: HIGH (N>250 all)
Action: In neutral regime, gamma bars work best as support/resistance. In positive regime, bars get BROKEN because dealer hedging creates gamma-assisted moves through levels. In very_negative, bars break 58% -- momentum regime.

RULE: Positive gamma regime = bars break more (60.4%)
Evidence: 39.6% bounce rate in positive regime (N=472)
Confidence: HIGH (N=472)
Action: Counter-intuitive: positive gamma doesn't mean bars hold better at daily level. The dealer hedging flow can push price through. Trade with the flow in positive gamma.

### By VRP (Volatility Risk Premium)
| VRP | N | Bounce% | Break% |
|-----|---|---------|--------|
| VRP < -0.02 | 457 | **36.1%** | **63.9%** |
| VRP -0.02 to 0 | 193 | 40.9% | 59.1% |
| VRP 0 to 0.02 | 251 | 47.4% | 52.6% |
| VRP > 0.02 | 736 | **49.0%** | 51.0% |

RULE: VRP is THE most predictive factor for bounce vs break. VRP < -0.02 = 64% break rate.
Evidence: VRP<-0.02: 36.1% bounce (N=457), VRP>0.02: 49% bounce (N=736). Spread = 12.9 percentage points
Confidence: HIGH (N>190 all buckets)
Action: NEVER fade a gamma bar when VRP < -0.02. Go WITH the momentum. When VRP > 0.02, bars are ~coin flip -- confirmation needed.

### By VIX Level
| VIX Level | N | Bounce% | Break% |
|-----------|---|---------|--------|
| VIX < 15 | 65 | 38.5% | 61.5% |
| VIX 15-20 | 759 | 38.1% | 61.9% |
| VIX 20-25 | 529 | **50.5%** | 49.5% |
| VIX 25-35 | 291 | 48.1% | 51.9% |
| VIX > 35 | 69 | 53.6% | 46.4% |

RULE: High VIX (>20) = gamma bars work better as S/R. Low VIX (<20) = bars break 62%.
Evidence: VIX<20: 38.1% bounce (N=759), VIX>20: 50% bounce (N=889)
Confidence: HIGH (N>65 all)
Action: When VIX is low (<20), gamma bars are less reliable -- trend days break through them. When VIX spikes above 20, bars become real walls.

### Cross-Analysis: Support in Neutral Regime
| Combo | N | Bounce% |
|-------|---|---------|
| Support + Neutral regime | 28 | **64.3%** |
| Support + Negative | 31 | 22.6% |
| Support + Very Negative | 23 | 21.7% |
| Resistance + Neutral | 222 | 53.6% |
| Resistance + Negative | 349 | 48.7% |

RULE: Support bars in neutral regime bounce 64%. In negative/very_negative they break 78%.
Evidence: Neutral support bounce 64.3% (N=28) vs very_neg support bounce 21.7% (N=23)
Confidence: LOW (N=28 for neutral support), but directionally very clear
Action: ONLY trust support bars in neutral regime. In negative regime, support bars are traps -- price smashes through.

### Day Range Impact (NAS100)
| Range | N | Bounce% |
|-------|---|---------|
| 100-200pts | 34 | 41.2% |
| 200-400pts | 303 | 39.9% |
| >400pts | 723 | **48.8%** |

RULE: Wide-range days (>400pts NAS) have HIGHER bounce rates than narrow days
Evidence: >400pts: 48.8% bounce (N=723) vs 200-400pts: 39.9% (N=303)
Confidence: HIGH (N=723)
Action: On wide-range days, gamma bars provide better reversal points. Likely because price tests extremes and mean-reverts.

### Bounce Continuation (Next Day)
- Support bounce -> next day UP: **67.7%** (N=62)
- Resistance bounce -> next day DOWN: 37.2% (N=710)

RULE: Support bounces continue next day 68% of the time. Resistance bounces reverse next day 63%.
Evidence: Support bounce -> UP next day 67.7% (N=62), Resistance bounce -> DOWN next day 37.2% (N=710)
Confidence: HIGH (N=710 for resistance)
Action: If a support bar holds (bounce), BUY for a swing trade -- 68% chance of follow-through. If a resistance bar holds, DON'T assume the next day continues down -- 63% of the time price goes UP the next day anyway.

---

## ANALYSIS 2: Level-to-Level Speed (N=1,386)

### By CFD
| CFD | N | Avg Gap | Avg Hours |
|-----|---|---------|-----------|
| NAS100 | 851 | 118pts | 3.1h |
| US30 | 279 | 174pts | 3.5h |
| XAUUSD | 256 | 25pts | 4.1h |

### NAS100 Speed by Gap Size
| Gap | N | Avg Hours |
|-----|---|-----------|
| <50pts | 285 | **1.2h** |
| 50-100pts | 205 | 2.4h |
| 100-200pts | 223 | 4.3h |
| >200pts | 138 | 6.1h |

RULE: When price breaks a gamma bar, it reaches the next bar in ~3 hours average. Gaps <50pts take only 1.2 hours.
Evidence: 851 NAS level-to-level moves, avg 3.1h across all gaps
Confidence: HIGH (N=851)
Action: After a gamma bar break, set TP at the next fat bar. For close bars (<50pts), expect fast fills (1-2 hours). For wide gaps (>200pts), expect 6+ hours -- consider INTRADAY/SWING mode.

### Speed by Regime
| Regime | N | Avg Hours |
|--------|---|-----------|
| Negative | 312 | **2.9h** |
| Very Negative | 554 | 3.1h |
| Neutral | 191 | 3.7h |
| Positive | 329 | 3.9h |

RULE: Negative regime = fastest level-to-level moves (2.9h avg)
Evidence: Negative 2.9h (N=312) vs Positive 3.9h (N=329)
Confidence: HIGH (N>190 all)
Action: In negative regime, expect faster moves between gamma bars. Tighter entries, quicker TP targets.

---

## ANALYSIS 3: Optimal SL/TP at Gamma Bars (N=1,744)

### Max Adverse Excursion (MAE) -- How far price goes AGAINST you after touching a gamma bar

#### NAS100 (N=1,060)
| Percentile | 5h Window |
|------------|-----------|
| P50 | 62pts |
| P80 | 167pts |
| P90 | 250pts |
| P95 | 360pts |

#### NAS100 by Gamma Bucket
| Bucket | N | MAE P50 | MAE P80 | MFE P50 | MFE P80 |
|--------|---|---------|---------|---------|---------|
| <500M | 751 | 59pts | 159pts | 115pts | 234pts |
| 500M-1B | 213 | 77pts | 195pts | 115pts | 228pts |
| 1B-2B | 70 | **52pts** | **134pts** | 112pts | 204pts |
| >2B | 26 | **46pts** | **124pts** | 117pts | 302pts |

RULE: FAT bars (>1B gamma) have LOWER adverse excursion -- they DO provide better protection intraday
Evidence: >1B MAE P80 = 134pts vs <500M MAE P80 = 159pts. >2B MAE P50 = 46pts vs <500M MAE P50 = 59pts
Confidence: MEDIUM (1B-2B N=70, >2B N=26)
Action: Fat bars = tighter SL works. At >1B bars, SL of 130-135pts covers 80% of adverse moves. At <500M bars, need 160pts.

RULE: Fat bars (>2B) have HIGHER favorable excursion -- better R:R
Evidence: >2B MFE P80 = 302pts vs <500M MFE P80 = 234pts
Confidence: LOW (N=26) but directionally strong
Action: Fat bars produce bigger moves in the favorable direction. Prioritize entry at the fattest bars for R:R.

#### NAS100 by Direction
| Direction | N | MAE P80 | MFE P50 | MFE P80 |
|-----------|---|---------|---------|---------|
| LONG | 529 | 187pts | 120pts | 228pts |
| SHORT | 531 | **137pts** | 110pts | **235pts** |

RULE: SHORT entries at gamma bars have lower MAE (137 vs 187pts) and similar MFE
Evidence: SHORT MAE P80=137pts vs LONG MAE P80=187pts (N~530 each)
Confidence: HIGH (N=529, 531)
Action: SHORT entries at gamma bars are more capital-efficient -- tighter SL works. LONG entries need wider SL to survive.

#### NAS100 by Regime
| Regime | N | MAE P80 | MFE P80 | Opt SL | Opt TP |
|--------|---|---------|---------|--------|--------|
| Positive | 28 | **77pts** | 175pts | 77pts | 111pts |
| Neutral | 115 | 157pts | 190pts | 157pts | 110pts |
| Negative | 300 | **131pts** | 222pts | 131pts | 135pts |
| Very Negative | 617 | 181pts | 251pts | 181pts | 151pts |

RULE: Positive regime = tightest SL (77pts covers 80% MAE), very_negative = widest (181pts)
Evidence: Positive MAE P80 = 77pts (N=28), Very_neg MAE P80 = 181pts (N=617)
Confidence: HIGH for very_negative (N=617), LOW for positive (N=28)
Action: In positive gamma regime, use tight SL (80pts NAS). In very_negative, need wide SL (180pts+) -- or use smaller position.

RULE: Very negative regime has the BEST favorable excursion (P80=251pts)
Evidence: Very_neg MFE P80 = 251pts vs Positive MFE P80 = 175pts
Confidence: HIGH (N=617)
Action: Very negative regime = biggest moves. If you catch the right direction, expect 150-250pts of favorable move.

### NAS100 SL/TP Win Rate Grid (5h window, N=1,060)

Best positive EV combinations for NAS100 (all bars):
| SL | TP | Win% | Loss% | EV/trade |
|----|-----|------|-------|----------|
| 10 | 100 | 14% | 80% | +5.7pts |
| 10 | 75 | 17% | 80% | +4.4pts |
| 10 | 50 | 20% | 80% | +1.8pts |
| 15 | 100 | 15% | 76% | +3.9pts |
| 15 | 75 | 19% | 76% | +2.5pts |
| 20 | 100 | 18% | 73% | +3.0pts |
| 25 | 100 | 19% | 69% | +2.0pts |

RULE: ONLY tight SL (10-15pts) with wide TP (75-100pts) produces positive EV for NAS100
Evidence: SL10/TP100 = +5.7pts EV, SL10/TP75 = +4.4pts EV (N=1,060)
Confidence: HIGH (N=1,060)
Action: The ONLY profitable strategy at gamma bars is: tight SL (10-15pts) + let winners run to 75-100pts. This means most trades get stopped out (80%) but winners are large enough to compensate.

### NAS100 FAT BARS (>1B gamma) SL/TP Grid (N=96)

Best positive EV combinations:
| SL | TP | Win% | Loss% | EV/trade |
|----|-----|------|-------|----------|
| 10 | 100 | 20% | 76% | **+12.2pts** |
| 15 | 100 | 24% | 70% | **+13.5pts** |
| 10 | 75 | 22% | 76% | +8.8pts |
| 15 | 75 | 26% | 70% | +9.1pts |
| 20 | 100 | 24% | 68% | **+10.4pts** |
| 25 | 100 | 25% | 66% | +8.6pts |
| 10 | 50 | 24% | 76% | +4.4pts |
| 15 | 50 | 30% | 70% | +4.6pts |

RULE: Fat bars (>1B) dramatically improve EV: +12-14pts/trade vs +4-6pts/trade for all bars
Evidence: SL15/TP100 at fat bars = +13.5pts EV vs SL15/TP100 at all bars = +3.9pts EV
Confidence: MEDIUM (N=96)
Action: PRIORITIZE entries at >1B gamma bars. SL 15pts, TP 100pts is optimal. Expected value is 3x better than at smaller bars.

### XAUUSD SL/TP Grid (N=359)

RULE: No positive EV combination exists for XAUUSD gamma bar entries at any SL/TP combo
Evidence: Best combo SL3/TP15 = +0.3pts EV (effectively zero). All others negative.
Confidence: HIGH (N=359)
Action: XAUUSD gamma bars alone are NOT sufficient edge for entry. Require additional confirmation (HIRO, institutional flow, DXY) before trading XAU at gamma levels.

### US30 SL/TP Grid (N=325)

RULE: US30 gamma bar entries have marginal positive EV only at SL10/TP100 (+1.6pts)
Evidence: SL10/TP100 = +1.6pts EV. Almost all other combos negative.
Confidence: HIGH (N=325)
Action: US30 gamma bars are weak edge. Very tight SL + wide TP is the only profitable approach, but EV is low. Need strong confirmation.

---

## ANALYSIS 4: Time-of-Day Effect

### Touch Frequency and Bounce Rate by Hour (UTC)
| Hour UTC | Touches | Bounce% | Avg NAS Range |
|----------|---------|---------|---------------|
| 1 (8PM ET) | 370 | 60% | 54pts |
| 4 (11PM ET) | 57 | **74%** | 41pts |
| 5 (12AM ET) | 39 | **77%** | 35pts |
| 15 (10AM ET) | 82 | 68% | 77pts |
| 16 (11AM ET) | 162 | 64% | 134pts |
| 17 (12PM ET) | 139 | 63% | 137pts |
| 21 (4PM ET) | 43 | **81%** | 85pts |
| 22 (5PM ET) | 66 | **77%** | 96pts |
| 23 (6PM ET) | 22 | **100%** | 59pts |

### Session Analysis
| Session | N | Bounce% |
|---------|---|---------|
| Market hours (13-20 UTC) | 615 | 62.0% |
| Pre-market (8-13 UTC) | 221 | 62.4% |
| Overnight (<8, >20 UTC) | 908 | 65.1% |

RULE: Overnight touches have the HIGHEST bounce rate (65.1%) but these are intraday bounces, not daily
Evidence: Overnight 65.1% (N=908), Market hours 62% (N=615)
Confidence: HIGH (N=908)
Action: Note: Analysis 4 uses MFE>MAE as "bounce" (intraday measure), different from Analysis 1 (daily close). Overnight bars do bounce intraday but less likely to hold at daily close. Best intraday bounce hours: 21-23 UTC (4-6PM ET, after-hours) and 4-5 UTC (11PM-12AM ET, Asian session).

RULE: Opening hour (14:30 UTC / 9:30AM ET) has lower bounce rate (53%) while 10AM-12PM ET window has 64-68% bounce rate
Evidence: Hour 14: 53% (N=49), Hours 15-17: 64-68% (N=383)
Confidence: HIGH (N=383)
Action: Avoid entries right at market open (9:30-10AM ET). Wait for the 10AM-12PM ET window where gamma bars are more reliable.

---

## ANALYSIS 5: Regime Prediction

### NAS100 Daily Direction by Regime
| Regime | N | Up% | Avg Change | Avg Range |
|--------|---|-----|------------|-----------|
| Neutral | 184 | 58.7% | +35pts | 372pts |
| Very Negative | 26 | 57.7% | +93pts | **786pts** |
| Positive | 155 | 54.8% | -3pts | **294pts** |
| Negative | 67 | 49.3% | -18pts | 515pts |

RULE: Very negative regime = biggest daily moves (786pts avg range) and slightly bullish bias (57.7% up)
Evidence: Very_neg avg range 786pts (N=26) vs Positive avg range 294pts (N=155)
Confidence: LOW for very_neg (N=26), HIGH for positive/neutral (N>150)
Action: Very negative regime is the highest opportunity regime (biggest range) with slight upward bias. Positive regime = smallest range (294pts), hardest to trade.

RULE: Negative regime + VRP negative = 63% up days (counter-intuitive)
Evidence: Negative regime, VRP<0: 63.2% up (N=19)
Confidence: LOW (N=19) but interesting signal
Action: When both regime and VRP are negative, the market has been oversold -- 63% chance of bounce day. Contrarian LONG opportunity.

### XAU Direction
| Regime | N | Up% | Avg Change |
|--------|---|-----|------------|
| Positive | 377 | 56.0% | +4.4pts |
| Neutral | 53 | 62.3% | +5.2pts |

RULE: XAUUSD has persistent bullish bias (56-62% up days) regardless of regime
Evidence: Positive regime 56% up (N=377), Neutral 62.3% up (N=53)
Confidence: HIGH (N=377)
Action: Default LONG bias for XAUUSD. Only go SHORT with strong bearish confirmation.

---

## ANALYSIS 6: VIX/DXY Correlation

### VIX Level vs Gamma Bar Effectiveness
| VIX Level | N | Bounce% |
|-----------|---|---------|
| VIX < 15 | 65 | 38.5% |
| VIX 15-20 | 759 | 38.1% |
| VIX 20-25 | 529 | **50.5%** |
| VIX 25-35 | 291 | 48.1% |
| VIX > 35 | 69 | 53.6% |

RULE: Gamma bars are ~50% more reliable when VIX > 20 vs VIX < 20
Evidence: VIX<20: 38.1% bounce (N=759), VIX>20: 50.1% bounce (N=889)
Confidence: HIGH (N=759, 889)
Action: When VIX < 20, gamma bars are unreliable (38% bounce). When VIX > 20, bars become real support/resistance (50% bounce). Adjust conviction accordingly.

### VIX Term Structure
| Structure | N | Bounce% |
|-----------|---|---------|
| Contango (normal) | 1,275 | 43.1% |
| Backwardation (fear) | 438 | 47.5% |

RULE: Backwardation (VIX > VIX3M) slightly improves gamma bar reliability (+4.4%)
Evidence: Backwardation 47.5% vs Contango 43.1%
Confidence: HIGH (N=438, 1,275)
Action: In backwardation (elevated fear), gamma bars work slightly better as S/R. Combined with VIX > 20, this creates the best conditions for gamma bar trading.

### DXY Impact on XAUUSD
| DXY Direction | N | XAU Bounce% |
|---------------|---|-------------|
| DXY Rising | 182 | **42.9%** |
| DXY Falling | 172 | 33.1% |

RULE: When DXY is falling, XAUUSD gamma bars break even MORE (67% break rate)
Evidence: DXY falling: 33.1% bounce (N=172) vs DXY rising: 42.9% bounce (N=182)
Confidence: HIGH (N=172, 182)
Action: DXY falling = gold trending up = gamma bars get broken in the UP direction. Don't SHORT XAU at resistance bars when DXY is falling. DXY rising = bars hold better (43% bounce) -- consider fading extremes.

---

## Statistical Trading Rules (N >= 100 only)

1. **VRP is the #1 predictor of bounce vs break.** VRP < -0.02 = 64% break rate (N=457). VRP > 0.02 = 49% bounce (N=736). NEVER fade gamma bars when VRP is strongly negative.

2. **VIX > 20 makes gamma bars 50% more reliable.** VIX<20 bounce rate = 38% (N=759). VIX>20 bounce rate = 50% (N=889). Adjust position sizing based on VIX.

3. **Neutral regime = best gamma bar trading environment.** 54.8% bounce rate (N=250) vs 39.6% in positive (N=472). Range-bound markets respect gamma levels.

4. **Support bars are weaker than resistance bars.** Support bounce = 37.3% (N=166). Resistance bounce = 45% (N=1,578). Don't trust green bars without confirmation.

5. **SHORT entries have better risk profile than LONG at gamma bars.** SHORT MAE P80 = 137pts vs LONG MAE P80 = 187pts (N~530 each). Tighter SL works on shorts.

6. **Level-to-level moves average 3 hours.** NAS100 breaks through a bar and reaches the next bar in avg 3.1h (N=851). Close bars (<50pts) = 1.2h.

7. **Negative regime = fastest level-to-level moves.** 2.9h average (N=312) vs 3.9h in positive (N=329). Trade breakouts more aggressively in negative regime.

8. **Optimal NAS100 entry: SL 10-15pts, TP 75-100pts.** Only tight SL + wide TP produces positive EV. SL10/TP100 = +5.7pts EV (N=1,060). Most trades get stopped out (80%) but winners are large.

9. **Fat bars (>1B gamma) produce 3x better EV.** SL15/TP100 at fat bars = +13.5pts EV vs +3.9pts at all bars (N=96 vs 1,060). PRIORITIZE fat bar entries.

10. **XAUUSD gamma bars have NO positive EV alone.** No SL/TP combo produces positive expected value (N=359). Always require additional confirmation for XAU entries.

11. **Very negative regime = biggest opportunity.** Average NAS range 786pts (N=26) vs 294pts in positive (N=155). Highest potential but need widest SL (181pts P80 MAE).

12. **Support bounces continue next day 68%.** When a support bar holds, next day is UP 67.7% (N=62). Valid swing signal.

13. **Avoid 9:30-10AM ET entries.** Opening hour bounce rate = 53% vs 64-68% at 10AM-12PM ET (N=383). Wait for price discovery.

14. **DXY falling = XAU breaks bars upward 67%.** DXY down + XAU: only 33% bounce (N=172). Don't SHORT XAU at resistance when DXY is falling.

15. **Backwardation slightly improves bar reliability.** VIX > VIX3M: 47.5% bounce (N=438) vs contango: 43.1% (N=1,275).

16. **Wide-range days (>400pts NAS) have higher bounce rates.** 48.8% bounce (N=723) vs 39.9% on 200-400pt days (N=303). Mean-reversion works on volatile days.

17. **XAUUSD has persistent bullish bias.** 56% up days in positive regime (N=377). Default LONG bias for gold.

18. **Resistance bounces DON'T predict next day.** 63% of the time price goes UP the next day after a resistance bounce (N=710). Don't hold resistance fades overnight.

19. **Positive regime has tightest MAE.** NAS P80 MAE = 77pts in positive gamma (N=28 -- low sample). But directionally clear: positive gamma dampens moves.

20. **Very negative regime has best MFE.** NAS P80 MFE = 251pts (N=617). The biggest favorable moves happen in very negative regime -- if you catch the direction.
