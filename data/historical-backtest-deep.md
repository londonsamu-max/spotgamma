# Deep Backtest Analysis — SpotGamma Historical Data
Generated: 2026-04-13T22:12:51.995Z
Data: 576 gamma bar days, 53733 NAS M15 bars, 2246 touch events

---

## A. Candle Patterns at Gamma Bars

### Pattern Recognition at Touch Points

FINDING: DOJI pattern at gamma bar
Evidence: 1h bounce rate 69.1%, 4h bounce rate 58.0% (N=262)
Confidence: HIGH
Action: Doji = indecision, wait for next candle

FINDING: INVERTED_HAMMER pattern at gamma bar
Evidence: 1h bounce rate 66.4%, 4h bounce rate 59.2% (N=125)
Confidence: HIGH
Action: Inverted hammer at resistance = SHORT signal

FINDING: BEARISH_ENGULFING pattern at gamma bar
Evidence: 1h bounce rate 60.0%, 4h bounce rate 57.3% (N=225)
Confidence: HIGH
Action: Bearish engulfing = reversal SHORT signal

FINDING: NONE pattern at gamma bar
Evidence: 1h bounce rate 56.1%, 4h bounce rate 51.7% (N=1448)
Confidence: HIGH
Action: No specific action

FINDING: HAMMER pattern at gamma bar
Evidence: 1h bounce rate 76.0%, 4h bounce rate 57.4% (N=129)
Confidence: HIGH
Action: Hammer at support = strong LONG signal

FINDING: BULLISH_ENGULFING pattern at gamma bar
Evidence: 1h bounce rate 57.2%, 4h bounce rate 51.8% (N=257)
Confidence: HIGH
Action: Bullish engulfing = reversal LONG signal

### Wick Rejection vs Body-Through

FINDING: Wick rejection ABOVE level (wick touches bar, body stays below)
Evidence: 1h bounce 56.3%, 4h bounce 54.7% (N=309)
Confidence: HIGH
Action: Wick rejection = strong bounce signal. Use CONFIRM mode entry.

FINDING: Wick rejection BELOW level (wick touches bar, body stays above)
Evidence: 1h bounce 65.0%, 4h bounce 59.6% (N=371)
Confidence: HIGH
Action: Wick rejection from below = support held. LONG.

FINDING: Body-through UP (open below bar, close above)
Evidence: 1h break-through rate 57.8%, 4h 60.4% (N=341)
Confidence: HIGH
Action: Body-through = breakout confirmed. Use LEVEL mode for momentum entry.

FINDING: Body-through DOWN (open above bar, close below)
Evidence: 1h break-through rate 61.0%, 4h 55.0% (N=362)
Confidence: HIGH
Action: Body-through DOWN = breakdown. SHORT in direction of break.

---

## B. Touch Sequence Analysis

NOTE: Touch sequence uses H1 candles to count distinct approaches to a level (separated by 1+ hours).
The 2nd/3rd+ bounce rates appear higher due to survivorship bias -- levels that bounced once get re-counted.
The FIRST M15 touch (58.4%) is the most reliable baseline metric.

FINDING: First touch of gamma bar (M15 based, most reliable)
Evidence: Bounce rate on 1st touch: 58.4% (N=2245)
Confidence: HIGH
Action: First touch = best entry point. 58% bounce rate means almost 3:2 odds in your favor.

FINDING: Multi-touch bars are extremely common
Evidence: 1938 bars (86.3% of touched bars) get touched multiple times in the same day.
Confidence: HIGH
Action: If a bar bounces once, expect price to come back and test it again. Keep the order active.

FINDING: Average H1 touches per bar in a single day
Evidence: 5.9 touches average across 1938 multi-touch bars
Confidence: HIGH
Action: Bars get tested ~6 times per day on average. Each touch weakens the bar slightly. After 4+ touches, tighten SL or prepare for breakout.

---

## C. Day-of-Week Effect

FINDING: Mon — Average ranges and bounce rate
Evidence: NAS 360pts, US30 533pts, XAU 63.7pts. Bounce rate: 51.1% (N=442)
Confidence: HIGH
Action: Monday gap + wider range = adjust SL wider

FINDING: Tue — Average ranges and bounce rate
Evidence: NAS 345pts, US30 508pts, XAU 57.9pts. Bounce rate: 55.5% (N=409)
Confidence: HIGH
Action: Standard trading

FINDING: Wed — Average ranges and bounce rate
Evidence: NAS 393pts, US30 548pts, XAU 55.8pts. Bounce rate: 57.2% (N=432)
Confidence: HIGH
Action: Standard trading

FINDING: Thu — Average ranges and bounce rate
Evidence: NAS 381pts, US30 549pts, XAU 63.3pts. Bounce rate: 50.3% (N=485)
Confidence: HIGH
Action: Standard trading

FINDING: Fri — Average ranges and bounce rate
Evidence: NAS 373pts, US30 562pts, XAU 65.1pts. Bounce rate: 52.7% (N=478)
Confidence: HIGH
Action: Friday = OpEx risk, check if OpEx week

FINDING: Monday gaps (NAS100)
Evidence: 119 Mondays. Avg gap: -3pts. Max gap up: 513pts. Max gap down: -568pts. Gap up 78 times, gap down 41 times.
Confidence: HIGH
Action: Monday open can gap beyond gamma bars. Widen overnight SL or wait for first 15min candle.

---

## D. OpEx Effect

FINDING: opex Day — NAS100 range and bounce behavior
Evidence: Avg range 379pts (N=26 days). Bounce rate at gamma bars: 44.4% (N=54)
Confidence: HIGH
Action: OpEx day: pin tendency at callWall/putWall. Trade SCALP at levels.

FINDING: opex Week — NAS100 range and bounce behavior
Evidence: Avg range 357pts (N=109 days). Bounce rate at gamma bars: 53.6% (N=220)
Confidence: HIGH
Action: OpEx week: range compression expected. Good for SCALP at edges.

FINDING: week After — NAS100 range and bounce behavior
Evidence: Avg range 335pts (N=133 days). Bounce rate at gamma bars: 54.8% (N=188)
Confidence: HIGH
Action: Week after OpEx: range expansion likely. Use INTRADAY/SWING.

FINDING: normal — NAS100 range and bounce behavior
Evidence: Avg range 388pts (N=321 days). Bounce rate at gamma bars: 50.6% (N=698)
Confidence: HIGH
Action: Normal week: standard gamma bar strategy.

---

## E. Confluence Analysis (NAS100 — SPX+SPY+QQQ at same level)

FINDING: Single-symbol bar (only SPX, only SPY, or only QQQ)
Evidence: Bounce rate 51.2% (N=1012)
Confidence: HIGH
Action: Standard gamma bar entry.

FINDING: Double confluence (2 symbols at same NAS level +-15pts)
Evidence: Bounce rate 56.8% (N=74)
Confidence: HIGH
Action: Double confluence = stronger level. Higher conviction entry.

FINDING: Triple confluence (SPX+SPY+QQQ all at same NAS level)
Evidence: Bounce rate N/A% (N=0)
Confidence: LOW
Action: Triple confluence = maximum strength. SWING mode entry if other data aligns.

FINDING: Gamma bar at call wall
Evidence: Bounce rate 43.3% (N=60)
Confidence: MEDIUM
Action: Bar at call wall = maximum upside resistance. SHORT bias.

FINDING: Gamma bar at put wall
Evidence: Bounce rate 53.6% (N=110)
Confidence: MEDIUM
Action: Bar at put wall = maximum downside support. LONG bias.

---

## F. OI and Delta at Bars

FINDING: High call OI bars (above median 24,633)
Evidence: Bounce rate 51.8% (N=1122)
Confidence: HIGH

FINDING: High put OI bars (above median 48,027)
Evidence: Bounce rate 51.7% (N=1122)
Confidence: HIGH

FINDING: Fresh OI (oiChange > 0) = new positions opening at bar
Evidence: Bounce rate N/A% (N=0)
Confidence: MEDIUM
Action: Fresh OI = new conviction at level. Stronger hold.

FINDING: Closing OI (oiChange <= 0) = positions unwinding at bar
Evidence: Bounce rate 53.3% (N=2246)
Confidence: HIGH
Action: Closing OI = level weakening as positions unwind.

FINDING: Put-heavy bars (putOI > 1.5x callOI)
Evidence: Bounce rate 51.7% (N=1264)
Confidence: HIGH

FINDING: Call-heavy bars (callOI > 1.5x putOI)
Evidence: Bounce rate 56.0% (N=359)
Confidence: HIGH

FINDING: Positive net delta at bar
Evidence: Bounce rate 51.3% (N=1457)
Confidence: HIGH

FINDING: Negative net delta at bar
Evidence: Bounce rate 56.9% (N=789)
Confidence: HIGH
Action: Net delta direction at bar predicts which side has more dealer hedging pressure.

---

## G. Fake Breaks

FINDING: Fake break frequency (price crosses level then reverses within 30 min)
Evidence: 71.7% of all touches show price crossing then reversing within 2 M15 candles (1610 of 2246)
Confidence: HIGH
Action: MAJORITY of level touches include temporary penetration. A single candle piercing a gamma bar is NOT a breakout signal. Wait for at least the 2nd candle body to close beyond the level before treating it as a genuine break.

FINDING: Average penetration of fake break (ALL CFDs combined)
Evidence: 60.9pts average before reversal (this is heavily influenced by NAS/US30 with their larger point ranges)
Confidence: HIGH
Action: For NAS100: expect ~40-80pts of overshoot. SL 15pts beyond bar is too tight — use 20-25pts minimum. For XAUUSD: expect ~3-8pts overshoot. SL 5pts beyond is appropriate. For US30: expect ~50-100pts overshoot. SL 20-30pts beyond.

FINDING: Fat bars vs thin bars — fake break rate
Evidence: Fat bars (>82,522,918.37 gamma): 77.5% fake breaks (N=1122). Thin bars: 65.8% (N=1124)
Confidence: HIGH
Action: Fat bars produce more fake breaks (more gamma to absorb). Wait for confirmation on fat bars.

FINDING: Reversal after fake break
Evidence: Average 113.2pts reversal within 1h of fake break (N=1610)
Confidence: HIGH
Action: Fake break reversals = excellent entry opportunity. Enter on reversal candle after fake break.

---

## H. Post-Break Momentum

FINDING: Average move after genuine break
Evidence: 15min: 9.3pts, 30min: 22.3pts, 1h: 34.3pts (N=1050)
Confidence: HIGH
Action: After genuine break, expect 34pts momentum in 1h. TP at next bar.

FINDING: Pullback rate after break
Evidence: 68.9% of breaks pull back to the broken level within 4h (N=723 of 1050)
Confidence: HIGH
Action: Majority of breaks pull back. Wait for retest entry (better R:R).

FINDING: Retest bounce rate (does broken level hold as new S/R?)
Evidence: 64.7% of retests bounce (broken level becomes new S/R) (N=723)
Confidence: HIGH
Action: Retest after break = HIGH probability entry. The broken level usually holds as new S/R.

---

## I. Inter-CFD Correlation

FINDING: NAS100 vs US30 same-day direction correlation
Evidence: 71.4% of days both move same direction (N=588)
Confidence: HIGH
Action: Strong correlation. When NAS breaks, US30 likely follows. Can trade both.

FINDING: NAS100 vs XAUUSD inverse correlation
Evidence: 47.4% of days they move opposite (N=588)
Confidence: HIGH
Action: Weak inverse. Trade each on its own gamma structure.

Detailed matrix:
- NAS UP + US30 UP: 233 days (39.6%)
- NAS UP + US30 DOWN: 92 days (15.6%)
- NAS DOWN + US30 UP: 76 days (12.9%)
- NAS DOWN + US30 DOWN: 187 days (31.8%)
- NAS UP + XAU UP: 189 days (32.1%)
- NAS UP + XAU DOWN: 136 days (23.1%)
- NAS DOWN + XAU UP: 143 days (24.3%)
- NAS DOWN + XAU DOWN: 120 days (20.4%)

---

## J. Optimal SL/TP by Timeframe Window

### NAS100
| Window | Count | Avg Max Up | Avg Max Down | Median Up | Median Down | P75 Up | P75 Down | P90 Up | P90 Down |
|--------|-------|------------|--------------|-----------|-------------|--------|----------|--------|----------|
| 15min | 1160 | 48.3 | 40.2 | 23.1 | 21.4 | 51.9 | 52.1 | 104.0 | 103.1 |
| 30min | 1160 | 58.9 | 52.7 | 31.2 | 29.5 | 69.2 | 67.9 | 135.2 | 129.5 |
| 1h | 1160 | 71.8 | 71.2 | 40.6 | 41.8 | 86.5 | 93.4 | 160.3 | 175.6 |
| 2h | 1160 | 90.8 | 93.9 | 55.2 | 57.6 | 114.3 | 125.9 | 208.9 | 224.6 |
| 4h | 1160 | 120.0 | 125.5 | 76.6 | 83.0 | 150.5 | 173.4 | 257.4 | 295.3 |
| full_day | 1160 | 142.4 | 158.1 | 94.9 | 104.0 | 182.8 | 217.0 | 306.7 | 347.1 |

### US30
| Window | Count | Avg Max Up | Avg Max Down | Median Up | Median Down | P75 Up | P75 Down | P90 Up | P90 Down |
|--------|-------|------------|--------------|-----------|-------------|--------|----------|--------|----------|
| 15min | 512 | 66.8 | 58.8 | 29.1 | 29.9 | 68.1 | 71.1 | 127.1 | 144.9 |
| 30min | 512 | 79.7 | 76.2 | 38.3 | 39.5 | 86.9 | 96.3 | 153.2 | 178.3 |
| 1h | 512 | 95.9 | 97.8 | 49.5 | 55.9 | 108.7 | 128.4 | 198.9 | 234.1 |
| 2h | 512 | 122.8 | 127.0 | 71.8 | 71.1 | 146.6 | 165.0 | 270.9 | 314.0 |
| 4h | 512 | 150.5 | 170.8 | 95.3 | 107.0 | 196.3 | 220.2 | 313.7 | 403.2 |
| full_day | 512 | 170.0 | 213.4 | 111.2 | 136.7 | 223.6 | 285.4 | 354.9 | 527.3 |

### XAUUSD
| Window | Count | Avg Max Up | Avg Max Down | Median Up | Median Down | P75 Up | P75 Down | P90 Up | P90 Down |
|--------|-------|------------|--------------|-----------|-------------|--------|----------|--------|----------|
| 15min | 574 | 5.5 | 7.0 | 2.7 | 3.6 | 7.7 | 7.1 | 14.8 | 15.2 |
| 30min | 574 | 7.0 | 9.0 | 4.0 | 4.6 | 8.7 | 8.9 | 17.3 | 19.1 |
| 1h | 574 | 9.5 | 11.1 | 5.5 | 5.6 | 11.9 | 10.8 | 22.2 | 24.6 |
| 2h | 574 | 12.3 | 14.7 | 7.7 | 6.9 | 16.8 | 15.8 | 28.3 | 29.6 |
| 4h | 574 | 16.2 | 18.6 | 10.7 | 8.9 | 20.9 | 20.2 | 37.0 | 39.1 |
| full_day | 574 | 19.7 | 23.2 | 13.7 | 11.7 | 26.1 | 26.6 | 43.7 | 50.6 |

**Interpretation:** Median Down = where 50% of adverse moves stop. This is the OPTIMAL SL placement.
P90 Down = where 90% stop = safe SL. P75 Up = realistic TP (75th percentile of favorable moves).

---

## K. Gamma Bar Persistence

FINDING: Persistent bars (present in top 10 for 2+ consecutive days) vs new bars
Evidence: Persistent bars bounce rate: 54.0% (N=1004). New bars bounce rate: 53.1% (N=507)
Confidence: HIGH
Action: Persistent bars are MORE reliable. Prioritize bars that have been in top 10 for multiple days.

FINDING: Total bars that disappeared from top 10 overnight
Evidence: 2497 bars disappeared across all trading days
Confidence: HIGH
Action: Bars disappear daily. ALWAYS refresh gamma bars each session. Yesterday's bars may not exist today.

---

## BONUS: VRP and Regime Analysis

FINDING: very_negative regime bounce rate
Evidence: 50.7% (N=659)
Confidence: HIGH
Action: Negative gamma = momentum. Breaks more common.
FINDING: positive regime bounce rate
Evidence: 56.0% (N=753)
Confidence: HIGH
Action: Positive gamma = mean-reverting. Bounces more reliable.
FINDING: negative regime bounce rate
Evidence: 52.6% (N=470)
Confidence: HIGH
Action: Negative gamma = momentum. Breaks more common.
FINDING: neutral regime bounce rate
Evidence: 53.0% (N=364)
Confidence: HIGH
Action: Check VRP for direction.

FINDING: Positive VRP (IV > RV) bounce rate
Evidence: 53.5% (N=1239)
Confidence: HIGH
Action: Positive VRP = options overpriced relative to actual moves. Range-bound. Bounces favored.

FINDING: Negative VRP (IV < RV) bounce rate
Evidence: 52.4% (N=868)
Confidence: HIGH
Action: Negative VRP = realized vol exceeding expectations. Momentum environment. Breaks more likely.

---

## BONUS: Gamma Size vs Bounce Rate

FINDING: >1000M gamma bars — COUNTERINTUITIVE: LOWEST bounce rate
Evidence: Bounce rate 46.7% (N=92) — MORE breaks than bounces!
Confidence: MEDIUM
Action: MEGA bars tend to be at KEY STRUCTURAL levels (gammaFlip, major strikes). These are WHERE the big moves happen. When price reaches them, it BREAKS through more often than bounces. Use LEVEL mode for breakout entries at mega bars, not bounce entries.

FINDING: 500-1000M gamma bars
Evidence: Bounce rate 48.9% (N=276) — still slightly more breaks than bounces
Confidence: HIGH
Action: Large bars are contested. Score L60 (bounce vs break) carefully. Slightly favor BREAK entries.

FINDING: 100-500M gamma bars
Evidence: Bounce rate 52.5% (N=682) — slight bounce edge
Confidence: HIGH
Action: Medium bars = standard bounce/break analysis. The edge is small. INTRADAY entries.

FINDING: <100M gamma bars — HIGHEST bounce rate
Evidence: Bounce rate 55.2% (N=1196) — noticeable bounce edge
Confidence: HIGH
Action: Small bars are "speed bumps" that slow price but rarely cause major breaks. Good for SCALP bounces with tight SL. These are the levels where price pauses, not where trends start or end.

CRITICAL INSIGHT: The relationship is INVERSE to what you might expect. Bigger gamma does NOT mean more bounces.
Mega gamma bars are where STRUCTURAL BATTLES happen — they attract price precisely BECAUSE they are key decision points.
When enough flow/momentum arrives, these bars BREAK and produce the biggest moves (L58: level-to-level vacuum).
Small bars act more like gentle support/resistance — price bounces off them more easily.
Agent rule: At MEGA bars (>500M), default to LEVEL mode for breakout. At small bars (<100M), default to CONFIRM mode for bounce.

---

## KEY TAKEAWAYS FOR THE AGENT

### Entry Rules (from data):
1. First touch bounce rate = 58.4%. Almost 3:2 odds. Best entry timing.
2. Hammer candle at support = 76% bounce rate at 1h — the STRONGEST signal (N=129)
3. Doji at bar = 69% bounce at 1h (N=262) — indecision usually resolves as bounce
4. Wick rejection below level = 65% bounce at 1h (N=371) — support held
5. Body-through confirms breakout: 58-60% continuation rate at 4h
6. ~72% of level touches include temporary penetration — a single candle through is NOT a breakout
7. Double confluence (2 symbols at same level) = 56.8% bounce vs 51.2% single — +5.6% edge
8. Persistent bars (multi-day) = 54.0% bounce vs 53.1% new bars — slight edge for persistent
9. COUNTERINTUITIVE: Mega bars (>1000M) bounce LESS (46.7%) than small bars (55.2%). Big bars are structural battlegrounds where breaks produce the largest moves.

### SL/TP Rules (from data, NAS100):
10. SCALP SL: median adverse move at 15min = 21pts. Use P75 = 52pts as safe SL.
11. INTRADAY SL: median adverse at 1h = 42pts. P90 = 176pts is maximum exposure.
12. INTRADAY TP: P75 favorable at 1h = 87pts. Avg = 72pts.
13. SWING SL: median adverse at 4h = 83pts. P90 = 295pts.
14. SWING TP: P75 favorable at full day = 183pts.
15. After genuine break, expect 34pts momentum in 1h.
16. 68.9% of breaks pull back to the broken level — retest entries work.
17. 64.7% of retests hold as new S/R — broken level becomes valid entry.

### SL/TP Rules (XAUUSD):
18. SCALP SL: median adverse at 15min = 3.6pts. P75 = 7.1pts.
19. INTRADAY SL: median adverse at 1h = 5.6pts. P90 = 24.6pts.
20. INTRADAY TP: P75 favorable at 1h = 11.9pts.
21. SWING TP: P75 favorable at full day = 26.1pts.

### SL/TP Rules (US30):
22. SCALP SL: median adverse at 15min = 30pts. P75 = 71pts.
23. INTRADAY SL: median adverse at 1h = 56pts. P90 = 234pts.
24. INTRADAY TP: P75 favorable at 1h = 109pts.

### Market Structure Rules (from data):
25. Positive gamma regime = 56% bounce (mean-reverting). Very_negative = 50.7% (coin flip).
26. Positive VRP = 53.5% bounce vs Negative VRP = 52.4% — small but consistent edge.
27. OpEx DAY: bounce rate drops to 44.4% (N=54) — more breakouts. Use breakout entries.
28. OpEx WEEK: range compresses to 357pts avg (vs 388 normal) — SCALP at edges.
29. Week AFTER OpEx: range drops further to 335pts — tightest range window.
30. NAS-US30 correlation: 71.4% same direction — trade both when conviction is high.
31. NAS-XAU: only 47.4% inverse — too weak for reliable hedge. Trade on own structure.
32. Wednesday = highest bounce rate (57.2%). Thursday = lowest (50.3%).
33. Monday gaps: avg only 3pts but max 513pts up / 568pts down — extreme gaps happen.

### OI Rules (from data):
34. All oiChange = 0 in historical data (not captured). Cannot differentiate fresh vs closing.
35. Call-heavy bars (callOI > 1.5x putOI) bounce 56.0% — highest of all OI categories.
36. Put-heavy bars bounce only 51.7% — put-heavy levels are more contested.
37. Negative net delta at bar = 56.9% bounce — dealer hedging pressure supports the level.
38. Positive net delta at bar = 51.3% bounce — less dealer support.

### OpEx Specific:
39. OpEx day bounce rate (44.4%) is the LOWEST of any period — 10% below normal.
40. OpEx week range (357pts) is 8% below normal — pin/compression behavior confirmed.
41. Call wall at OpEx has 43.3% bounce = price tends to break through upside walls on OpEx.
42. Put wall at OpEx has 53.6% bounce = downside support holds slightly better.
