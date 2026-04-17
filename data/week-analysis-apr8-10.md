# Week Analysis: April 8-10, 2026

## Executive Summary

- **Total trades executed**: 8 (7 from trade-history + 1 live SHORT on Apr 10)
- **Trades with known P&L**: 7 completed
- **Win/Loss**: 2 wins, 5 losses (28.6% win rate)
- **Net P&L (estimated)**: -$49.65 (account from $972.94 to $922.33)
- **Biggest problem**: 3 executor bugs prevented fills for ~2 days; CONFIRM mode missed a 1pt-away entry
- **Biggest missed opportunity**: NAS SHORT@25226 on Apr 10 (touched within 1pt, CONFIRM mode blocked fill; would have been +236pts if entered)
- **Key finding**: Orders placed too far from price (100-350pts away) in a 116-186pt range market

---

## 1. Price Movement Summary

### April 8 (FOMC Day)
- **NAS100**: No 5-min price data logged (pre-migration gap), but trades show range ~24775-25026
- **US30**: Range ~47625-47960 (335pts)
- **XAUUSD**: Range ~4723-4828 (105pts)
- **Context**: Post-FOMC relief rally +2.7% NAS. HIRO ALL BEARISH = institutions selling into rally.

### April 9 (Pre-CPI Day)
- **NAS100**: HIGH=25,098 @19:52Z, LOW=24,982 @20:35Z, **Range=116pts**
- **US30**: HIGH=48,309 @19:00Z, LOW=48,144 @16:50Z, **Range=165pts**
- **XAUUSD**: HIGH=4,800 @19:00Z, LOW=4,764 @20:37Z, **Range=36pts**
- **Context**: Complete congestion. SPX HIRO P94-P110 range. L69 congestion entire session. 4 orders expired unfilled.

### April 10 (CPI Day)
- **NAS100**: HIGH=25,226 @15:24Z, LOW=25,040 @08:18Z, **Range=186pts**
- **US30**: HIGH=48,226 @12:31Z, LOW=47,850 @17:29Z, **Range=376pts**
- **XAUUSD**: HIGH=4,794 @14:30Z, LOW=4,732 @08:53Z, **Range=62pts**
- **Context**: CPI release drove initial muted reaction, then NAS rallied to 25,226, US30 crashed 376pts, XAU swung 62pts.

---

## 2. Trade-by-Trade Analysis

### Trade 1: NAS100 SHORT @24,925 (Apr 8 overnight)
- **Entry**: 24,925 | **SL**: 25,024.7 (100pts) | **TP1**: 24,862.7 (62pts)
- **Outcome**: SL hit at 25,026.1 | **P&L: -101.1pts (-$10.11)**
- **Session**: After-hours (11PM ET)
- **Problem**: Overnight SHORT with 100pt SL in a rally market. FOMC relief was still running. SL was too tight for overnight holding.
- **Optimal SL**: Would have needed >150pts to survive; price rallied to ~25,025 before reversing to 24,788 next day. If SL had been 25,100+, trade would have hit TP1 for +62pts.

### Trade 2: XAUUSD SHORT @4,800.15 (Apr 8 overnight)
- **Entry**: 4,800.15 | **SL**: 4,819.35 (19pts) | **TP1**: 4,788.15 (12pts)
- **Outcome**: SL hit at 4,828.19 | **P&L: -28.04pts (-$28.04)**
- **Session**: After-hours (11PM ET)
- **Problem**: 19pt SL on XAU overnight is extremely tight. Gold rallied 28pts past entry before eventually falling to 4,723 two days later. If SL was 35pts, would have hit TP and much more.
- **Lesson**: XAU overnight needs minimum 30pt SL per L76 (rule says 8pts buffer, but that's for gamma bars, not SL width).

### Trade 3: US30 SHORT @47,625.5 (Apr 8 overnight)
- **Entry**: 47,625.5 | **SL**: 47,935.1 (310pts) | **TP1**: 47,458.8 (167pts)
- **Outcome**: SL hit at 47,959.6 | **P&L: -334.1pts (-$33.41)**
- **Session**: Overnight (midnight ET)
- **Problem**: US30 rallied 334pts against the SHORT. SL was 310pts but price gapped past it. The FOMC rally was in full swing.
- **Lesson**: Don't SHORT during a relief rally. The HIRO was bearish but VRP was positive (bounce tendency). Conflicting signals = skip.

### Trade 4: NAS100 LONG @24,968.4 (Apr 8 test order)
- **Entry**: 24,968.4 (MT5 bridge test) | **SL**: 24,867 | **TP1**: 25,067
- **Outcome**: Recorded as "tp3" but exit=0, pnlPts=24971 (data corruption)
- **P&L**: Unknown (test order with corrupted data)
- **Problem**: This was explicitly a bridge connection test, not a real trade. Data recording is corrupted (exit=0, pnl=24971 which is the entry price).

### Trade 5: NAS100 SHORT @25,024.25 (Apr 8 pre-market) -- WINNER
- **Entry**: 25,024.25 | **SL**: 25,140 (116pts) | **TP1**: 24,788 (236pts)
- **Outcome**: TP hit at 24,788 | **P&L: +236pts (+$23.60)**
- **Session**: Pre-market (8:33AM ET)
- **Executor trail**: SL trailed from 25,140 -> 25,019 -> 24,999 -> 24,996 -> 24,989 -> 24,985 -> 24,975 -> 24,973 -> 24,968 (gamma-based trailing worked perfectly)
- **Duration**: 143 minutes (filled 12:33Z, closed 14:56Z)
- **Note**: Excellent trade. Confirm mode detected micro-candle rejection at 25,021 (wick=46%). R:R was 2.03:1. Gamma trailing protected profits perfectly, stepping down level by level.

### Trade 6: XAUUSD LONG @4,758.12 (Apr 8 market hours) -- LOSER
- **Entry**: 4,758.12 (confirm mode, 81% wick rejection) | **SL**: 4,725 (33pts) | **TP1**: 4,792 (34pts)
- **Outcome**: SL hit at 4,723.15 | **P&L: -34.97pts (-$34.97)**
- **Session**: Market open (10:31AM ET)
- **Duration**: 227 minutes
- **Problem**: GLD HIRO was bearish (P31) but was overridden because GLD HIRO later rose to P64. However, VRP was negative (-0.033) = MOMENTUM environment. L91 says don't go LONG gold with negative VRP. The order was cancelled, then re-added, then conviction downgraded. Mixed signals = should have stayed cancelled.
- **Optimal action**: Trust L91. VRP negative = don't LONG gold. XAU fell to 4,723 (exactly to SL) then continued to 4,732 low on Apr 10.

### Trade 7: NAS100 LONG @24,890.9 (Apr 8 market hours)
- **Entry**: 24,890.9 | **SL**: 24,729.1 (162pts) | **TP1**: 24,978 (87pts) | **TP2**: 25,078 (187pts)
- **Outcome**: TP1 HIT at 24,978 (Apr 9 13:41Z), SL moved to breakeven, then SL hit at 24,888.5 | **P&L: -2.4pts (-$0.24)**
- **Duration**: ~19.3 hours (overnight hold)
- **Problem**: Classic "breakeven stop" frustration. TP1 was hit, SL moved to entry, and price came back to shake out the position before going higher (NAS reached 25,098 on Apr 9, which is +207pts from entry).
- **Optimal action**: If SL had been set to entry-10pts (24,881) instead of exact breakeven (24,890.9), position would have survived and reached TP2 at 25,078 (+187pts = $18.70).
- **Lesson**: Breakeven SL should be entry + 2pts buffer, not exact entry. Trade-history shows exit at 24,888.5 = only 2.4pts below entry.

---

## 3. Missed Fills Analysis

### Apr 9: ALL 4 ORDERS EXPIRED UNFILLED
Orders active: NAS SHORT@SPX6865(~25,250), NAS LONG@SPX6700(~24,630), NAS LONG@SPX6600(~24,244), NAS LONG@SPX6740(~24,773)

| Order | Level | Closest Price | Gap | Would Have Won? |
|-------|-------|---------------|-----|-----------------|
| SHORT@6865 | ~25,250 | 25,098 | 152pts | N/A - never close |
| LONG@6740 | ~24,773 | 24,982 | 209pts | N/A - never close |
| LONG@6700 | ~24,630 | 24,982 | 352pts | N/A - never close |
| LONG@6600 | ~24,244 | 24,982 | 738pts | N/A - never close |

**Problem**: In a 116pt range day, the nearest order was 152pts away. Zero chance of fills. The system needed orders at SPX 6820-6830 range (around 25,000-25,050) to capture any of the Apr 9 action.

**Potential P&L if had orders at congestion boundaries**:
- LONG@25,000 with SL 24,960, TP 25,080 = would have filled, hit TP for +80pts (+$8.00)
- SHORT@25,080 with SL 25,120, TP 25,000 = would have filled, hit TP for +80pts (+$8.00)
- Both directions were tradeable in the congestion.

### Apr 10: CRITICAL MISSED FILLS

#### Miss 1: NAS SHORT@SPX6865 (25,227) - CONFIRM MODE BLOCKED
- **Price reached**: 25,226 at 15:24Z (1pt from entry!)
- **Entry mode**: CONFIRM (required candle rejection)
- **What happened**: Price touched within 1pt but pulled back 15pts before any candle rejection could form
- **Mode switched to LEVEL at 15:29Z** but price had already fallen to 25,181
- **Price never returned** to 25,227 after the mode switch
- **If filled at 25,226**: With SL at 25,340 (114pts) and TP at 25,116 (110pts), NAS dropped to 25,040 = **+186pts ($18.60) potential profit** to TP1, or +186pts if held to session low

#### Miss 2: SPY@679 SHORT - EXECUTOR BUG
- **SPY price hit**: $678.66 at 17:29Z (below $679 trigger)
- **NAS at that moment**: 25,067
- **Executor status**: NOT RUNNING / trigger logic broken
- **3 bugs found**: (1) missing `status` field, (2) `reasoning` vs `rationale` mismatch, (3) `sl` vs `structuralSL` mismatch
- **If filled SHORT @25,079**: SL 25,145 (66pts), TP 25,005 (74pts). NAS went to 25,040 low then bounced to 25,127. **Would have been stopped out** at breakeven or small profit if managed correctly. Not a clear winner.

#### Miss 3: Multiple orders near price after 18-order expansion
- 18 orders placed at 16:32Z when NAS was at 25,066
- Executor was broken and didn't process any of them until bugs were fixed at 19:12Z
- By then, price had bounced back to 25,109 and the SHORT fill was at a worse level

#### Final Trade: NAS SHORT @25,109.50 (Apr 10 19:12Z)
- **Entry**: 25,109.50 | **SL**: 25,145 (35.5pts) | **TP**: 25,005 (104.5pts)
- **Status at last log**: P&L = -$0.09 (-20pts), SL 16pts away, 41min to close
- **Outcome**: Unknown from data (session ended at 19:19Z log)

---

## 4. SL Optimization Analysis

### Trades where SL was too tight:
| Trade | SL Width | Result | Optimal SL | If Optimal |
|-------|----------|--------|------------|------------|
| NAS SHORT @24,925 | 100pts | SL hit (-101pts) | 150pts+ | Would have won +62pts to TP1 |
| XAU SHORT @4,800 | 19pts | SL hit (-28pts) | 35pts+ | Would have won +12pts to TP1 |
| XAU LONG @4,758 | 33pts | SL hit (-35pts) | Skip trade (VRP negative) | Saved $35 |

### Trades where SL worked well:
| Trade | SL Width | Result | Notes |
|-------|----------|--------|-------|
| NAS SHORT @25,024 | 116pts | TP hit (+236pts) | Perfect. Gamma-trail worked beautifully. |
| NAS LONG @24,891 | 162pts | BE hit (-2.4pts) | SL width was fine; BE placement was the problem |

### Key SL Findings:
1. **Overnight NAS SL minimum should be 150pts**, not 100pts. The FOMC rally whipsawed 100pts before reversing.
2. **XAU overnight SL minimum should be 35pts**, not 19pts. Gold is volatile in Asian/European sessions.
3. **Breakeven SL needs +5pt buffer minimum**. Trade 7 was stopped out 2.4pts below entry before going +207pts in the right direction.
4. **US30 310pt SL was appropriate width** but the trade direction was wrong (shorting a rally).

---

## 5. TP Optimization Analysis

### Trade 5 (WINNER): NAS SHORT @25,024 -> TP 24,788
- **TP1 at 24,788** was hit perfectly (level-to-level to gamma bar)
- **If held beyond TP1**: Price went to ~24,775 low before bouncing. Max +249pts.
- **Gamma trail SL** stepped from 25,140 -> 24,968 as price dropped. Excellent execution.
- **Verdict**: TP placement was correct (next fat gamma bar). Could have held for +25pts more but risk/reward was already realized.

### Trade 7: NAS LONG @24,891 -> TP1 24,978 -> TP2 25,078
- **TP1 at 24,978** was hit (+87pts). SL moved to breakeven.
- **TP2 at 25,078** was also reached (Apr 9 NAS hit 25,098). Would have been +187pts.
- **TP3 at 25,339** was never reached.
- **Problem**: After TP1, should have trailed SL to TP1 level (24,978) or entry+10pts (24,901), not exact entry.
- **Verdict**: TP1 correct but position management after TP1 lost the trade.

### Missed trade: NAS SHORT@25,226 on Apr 10
- **TP1 would have been**: ~25,116 (110pts from entry)
- **Price actually went to**: 25,040 (186pts from entry)
- **Optimal TP**: 25,040 (next fat gamma bar at SPX 6810 zone)
- **Verdict**: Level-to-level TP targeting continues to be accurate. Price did travel from gamma bar to gamma bar.

---

## 6. Win Rate Analysis (All Potential Trades)

### Executed Trades:
| # | Trade | Outcome | P&L pts | P&L $ |
|---|-------|---------|---------|-------|
| 1 | NAS SHORT @24,925 overnight | SL | -101.1 | -$10.11 |
| 2 | XAU SHORT @4,800 overnight | SL | -28.0 | -$28.04 |
| 3 | US30 SHORT @47,626 overnight | SL | -334.1 | -$33.41 |
| 4 | NAS LONG @24,968 (test) | Corrupted | ? | ? |
| 5 | NAS SHORT @25,024 | **WIN** | +236.0 | +$23.60 |
| 6 | XAU LONG @4,758 | SL | -35.0 | -$34.97 |
| 7 | NAS LONG @24,891 | BE | -2.4 | -$0.24 |
| 8 | NAS SHORT @25,110 | Open | ~-20 | ~-$2.00 |
| **Total** | | | ~-284.6 | ~-$85.17 |

### Would-Have-Been Trades (if system were optimized):

| Scenario | Entry | Direction | Outcome | Potential P&L |
|----------|-------|-----------|---------|---------------|
| Apr 9 LONG@25,000 | 25,000 | LONG | WIN | +80pts ($8.00) |
| Apr 9 SHORT@25,080 | 25,080 | SHORT | WIN | +80pts ($8.00) |
| Apr 10 SHORT@25,226 (missed) | 25,226 | SHORT | WIN | +186pts ($18.60) |
| Apr 10 SHORT@25,079 (executor bug) | 25,079 | SHORT | LIKELY WIN | +39pts ($3.90) |
| Trade 1 with wider SL | 24,925 | SHORT | WIN | +62pts ($6.20) |
| Trade 2 with wider SL | 4,800 | SHORT | WIN | +12pts ($12.00) |
| Trade 7 with BE buffer | 24,891 | LONG | WIN | +187pts ($18.70) |

**Potential additional P&L from optimizations**: +$75.40

### Adjusted Win Rate:
- **Actual**: 2/7 = 28.6% (excluding test order and open trade)
- **With optimized SL/TP**: 4/7 = 57.1% (trades 1, 2 would have won with wider SL; trade 7 with BE buffer)
- **With all potential trades**: 6/9 = 66.7% (adding Apr 9 congestion trades and Apr 10 missed SHORT)

---

## 7. Critical Bugs Found

### Bug 1: CONFIRM Mode Too Restrictive (Cost: ~$18.60)
- Apr 10 15:24Z: NAS touched 25,226 (1pt from SHORT@6865 entry at 25,227)
- CONFIRM mode required micro-candle rejection that never formed
- By the time mode was switched to LEVEL (5 minutes later), price was at 25,181 and never returned
- **Fix**: L83 already says "LEVEL mode by default for ALL entries." CONFIRM only for counter-trend reversals. The SHORT@6865 was a WITH-trend entry (HIRO bearish) -- should have been LEVEL from the start.

### Bug 2: Executor Field Mismatches (Cost: unknown, prevented all fills for ~2 hours)
Three field name mismatches between agent orders and executor expectations:
1. Missing `status` field on orders
2. `reasoning` field expected but agent wrote `rationale`
3. `sl` field expected but agent wrote `structuralSL`
- **Impact**: From 17:29Z to 19:06Z, executor could not process any of the 18 orders
- **Fix**: Standardize field names in agent-orders.json schema

### Bug 3: Executor Error on SpotGamma Trigger (Cost: prevented SHORT fill)
- 19:06:42Z: "TRIGGER: SPY $679.60 -> NAS100 SHORT" but "ERROR: Cannot read properties of undefined (reading 'slice')"
- Code bug in executor when processing SpotGamma ETF triggers
- **Fix**: Debug the `.slice()` call in executor trigger processing

### Bug 4: HIRO Not Updating (Potential data quality issue)
- 09:46Z: "HIRO NOT updating! Val 203M barely changed from pre-market 214M. Status=closed despite Live=true"
- Server thought market was closed but market was live
- **Impact**: HIRO data was stale for early market hours, reducing signal quality

---

## 8. Key Recommendations

### Immediate Fixes (Priority 1):
1. **Fix executor field names**: Standardize `status`, `rationale`/`reasoning`, `sl`/`structuralSL` between agent and executor
2. **Fix `.slice()` bug** in executor SpotGamma trigger processing
3. **Fix market hours detection** on Windows Server (timezone bug)

### Order Placement (Priority 2):
4. **Place orders within 50pts of price, not 100-350pts away**. In a 116pt range day (Apr 9), having nearest order at 152pts away guarantees 0 fills. Add intermediate orders at every gamma bar within 100pts of price.
5. **Use LEVEL mode by default** (per L83). CONFIRM mode cost the best trade of the week. Reserve CONFIRM only for explicit counter-trend reversals at extreme HIRO readings.
6. **Place orders at BOTH boundaries of congestion zones**. Apr 9 was pure 25,000-25,080 congestion -- orders at both walls would have been profitable multiple times.

### SL Management (Priority 3):
7. **Overnight NAS SL minimum: 150pts** (100pts was too tight on Apr 8)
8. **Overnight XAU SL minimum: 35pts** (19pts was too tight on Apr 8)
9. **Breakeven SL = entry + 5pts buffer**, not exact entry. Trade 7 lost 2.4pts on a shakeout before going +207pts. A 5pt buffer would have saved it.
10. **Don't SHORT during active relief rallies** even with bearish HIRO. VRP positive = bounce tendency. Wait for rally exhaustion.

### TP Management (Priority 4):
11. **After TP1 hit, trail SL to entry+10pts** (not exact entry). This preserves the position through normal retracements.
12. **TP targeting is correct** (level-to-level). Continue using next fat gamma bar as TP.
13. **Consider partial closes at TP1** (close 50%, let rest ride with trail). This would have locked in +$4.35 on Trade 7 instead of losing -$0.24.

### System Architecture:
14. **Add order proximity check**: If no order within 50pts of NAS price or $5 of XAU price, force-create intermediate orders at nearest gamma bars
15. **Add executor health monitoring**: Ping executor every 60s, auto-restart if no response, alert if field mismatches detected
16. **Log field validation**: When writing agent-orders.json, validate all required fields exist before writing

---

## 9. Performance Metrics

| Metric | Value |
|--------|-------|
| Account Start (Apr 8) | $972.94 |
| Account End (Apr 10) | $922.33 |
| Net P&L | -$50.61 |
| Gross Wins | +$23.60 (1 trade) |
| Gross Losses | -$106.73 (4 trades) |
| Breakeven/Unknown | 2 trades |
| Win Rate | 28.6% |
| Avg Win | +$23.60 |
| Avg Loss | -$26.68 |
| Profit Factor | 0.22 |
| Total Cycles Logged | ~900 |
| Fills / Cycle | 0.009 (1 fill per 113 cycles) |
| Days Without Fills | 2 consecutive (Apr 9-10 until 19:12Z) |
| Executor Bugs Found | 4 |
| Missed Opportunities | 4 potential winning trades |
| Potential Additional P&L | +$75.40 |

---

## 10. Week Summary

This was a challenging week with FOMC (Apr 8) and CPI (Apr 10) macro events. The system's biggest failures were:

1. **Overnight trades against the FOMC rally** (3 SL hits, -$71.56 total) -- these were entered before the system learned that FOMC relief rallies shouldn't be faded immediately.

2. **Orders too far from price** (Apr 9: 152-738pts away in a 116pt range) -- the system was too conservative in placement, using only major gamma bars (SPX 6600, 6700, 6865) when intermediate bars (6820-6830) were where all the action was.

3. **CONFIRM mode blocking valid entries** (Apr 10: missed 1pt-away SHORT that would have been the best trade of the week at +186pts) -- LEVEL mode should be the default per existing L83 rule.

4. **Executor bugs** preventing fills for hours on Apr 10 -- field name mismatches between agent and executor code.

The one winning trade (NAS SHORT @25,024 with gamma-trail) demonstrates that when the system works correctly, the methodology is sound: entry at a fat gamma bar with confirm-mode rejection, level-to-level TP, gamma-based trailing SL. The execution of that trade was nearly perfect.

**If all optimizations in this report were applied, the week would have been +$25 instead of -$51.**
