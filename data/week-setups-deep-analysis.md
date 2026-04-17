# Deep Setup Analysis: April 8-10, 2026

## Methodology
Reconstructed from 898 decision log entries (cycles C228-C1131), trade-history.json, and executor-log.jsonl. Every price touch near a gamma bar was evaluated for entry viability using HIRO, tape, flow, VRP, and gamma sign data logged at that exact moment.

## Gamma Bars Available (from getAgentView snapshots)

### NAS100 (via SPX + QQQ + SPY)
| Bar | ETF Strike | Gamma (M) | Type | CFD Price | Role |
|-----|-----------|-----------|------|-----------|------|
| 1 | SPX $6740 | +1842 | GREEN support | ~24,790 | Major floor |
| 2 | SPX $6800 | +1582 | GREEN support | ~25,011 | Key wall |
| 3 | SPX $6810 | -897 | RED accelerator | ~25,047 | Breakout trigger |
| 4 | SPY $679 | +617 | GREEN support | ~25,050 | Hidden support |
| 5 | SPX $6820 | +876 | GREEN support | ~25,084 | Hedge wall |
| 6 | SPX $6825 | -1114 | RED accelerator | ~25,103 | Dense resistance |
| 7 | SPX $6830 | -1254 | RED accelerator | ~25,121 | Dense resistance |
| 8 | SPX $6865 | +1401 | GREEN support | ~25,250 | Call wall / ceiling |
| 9 | SPX $7000 | -1447 | RED accelerator | ~25,746 | Far accelerator |

### US30 (via DIA)
| Bar | ETF Strike | Gamma (M) | Type | CFD Price |
|-----|-----------|-----------|------|-----------|
| 1 | DIA $476 | +2 | GREEN | ~47,588 |
| 2 | DIA $480 | -3 | RED | ~47,988 |
| 3 | DIA $483 | +37 | GREEN support | ~48,288 |
| 4 | DIA $485 | -30 | RED accelerator | ~48,488 |
| 5 | DIA $490 | -4 | RED | ~48,988 |

### XAUUSD (via GLD)
| Bar | ETF Strike | Gamma (M) | Type | CFD Price |
|-----|-----------|-----------|------|-----------|
| 1 | GLD $420 | -7 | RED | ~4,573 |
| 2 | GLD $425 | +41 | GREEN support | ~4,628 |
| 3 | GLD $430 | +13 | GREEN support | ~4,684 |
| 4 | GLD $440 | +5 | GREEN support | ~4,793 |
| 5 | GLD $445 | +11 | GREEN support | ~4,847 |
| 6 | GLD $450 | +45 | GREEN support | ~4,902 |

---

## Price Ranges (from decision logs)

| Day | NAS100 | US30 | XAUUSD |
|-----|--------|------|--------|
| Apr 8 | 24,800 - 24,891 (logged range) | 47,728 - 47,831 | 4,705 - 4,723 |
| Apr 8 (full w/ trades) | ~24,775 - 25,026 | ~47,625 - 47,960 | ~4,723 - 4,828 |
| Apr 9 | 24,818 - 25,079 (261pts) | 47,697 - 48,309 (612pts!) | 4,741 - 4,800 (59pts) |
| Apr 10 | 25,040 - 25,226 (186pts) | 47,850 - 48,226 (376pts) | 4,732 - 4,794 (62pts) |

---

## APRIL 8 SETUPS (FOMC Day)

### SETUP #1: NAS100 LONG @ SPX $6740 (24,790) - FOMC SELLOFF BOUNCE
- Bar: SPX $6740 +1842M GREEN wall (fattest NAS bar)
- Time: ~18:55-19:08Z (2:55-3:08PM ET). NAS dropped from 24,891 to 24,800 over 30 min post-FOMC. Low was 24,800 at 19:08Z, within 10pts of the $6740 bar at 24,790.
- HIRO at touch: SPX P36 RISING +6 (buying!), but QQQ P-1 UNPRECEDENTED MAX BEARISH. DIA P26. 
- Tape: SPX/SPY BULL (retail buying dip). QQQ BEAR.
- VRP: +0.037 positive = mean reversion favors bounce.
- Flow: GLD PUT $285 LEAPS $84K hedge, SPX CALL $6760 0DTE $22K bullish. QQQ synthetic SHORT $39K.
- 0DTE magnet: 24,717 (pulling down further).
- L60 Score: 5 BOUNCE vs 5 BREAK = TIE. SPX improving overridden by QQQ extreme.
- Entry: 24,800 | SL: 24,750 (50pts, below vacuum) | TP: 24,900 (100pts, back to open)
- Outcome: NAS bounced from 24,800 to 24,838 by 19:18Z (+38pts), then continued to 24,811 at session end. Next day opened 24,861 and rallied to 25,079. If held overnight: +279pts to high.
- P&L (conservative intraday): +38pts = +$3.80 (0.10 lots)
- P&L (if held to next day TP 24,900): +100pts = +$10.00
- R:R: 2:1
- Why missed: Agent had LONG orders at SPX $6700 (24,630) and $6600 (24,244) -- 170pts and 556pts away. No order at the actual bar being tested ($6740 at 24,790). The L60 tied at 5-5 which made the agent hesitate, but VRP positive + SPX HIRO improving = should have been a LONG.
- Lesson: The FATTEST bar was 10pts from price and had no order on it.

### SETUP #2: XAUUSD SHORT @ GLD $440 (4,793) - RISK-OFF ROTATION
- Bar: GLD $440 +5M GREEN support (small bar, but price action was at this level)
- Time: 18:35-19:02Z. XAU fell from 4,723 to 4,705 in 27 minutes (session low).
- HIRO at touch: GLD P52 neutral, then P64 RISING (institutional buying gold = risk-off). But VRP -0.033 NEGATIVE = momentum regime.
- Flow: GLD CALL $650 Mar2027 LEAPS straddle (massive move expected). GLD CALL $440 May $71K bullish.
- VRP: -0.033 NEGATIVE = DON'T GO LONG (L91).
- Entry: SHORT @ 4,723 (session low test) | SL: 4,760 (37pts) | TP: 4,684 (GLD $430 bar, 39pts)
- Outcome: XAU continued falling to 4,705 at 19:02Z. BUT then rallied back to 4,715 by session end. Next day hit 4,800 high. This was NOT a good short entry -- XAU was already at the low.
- P&L: Would have been stopped out at 4,760 = -$37.00
- Why agent was right to skip: VRP negative meant momentum, but XAU was already extended. No gamma bar to anchor SL. Actually the agent DID enter XAU LONG at 4,758 and SHORT at 4,800 overnight -- both were stopped out.
- Verdict: NOT A VALID SETUP. XAU lacked fat bars near price.

### SETUP #3: NAS100 SHORT @ SPX $6800 (25,011) - POST-FOMC FADE
- Bar: SPX $6800 +1582M GREEN wall. Price was ABOVE this level at 24,891 and falling toward it.
- Time: Price was at 24,891 at 18:35Z, 24,853 at 18:54Z, 24,800 at 19:08Z. It broke through $6800 (25,011) from above much earlier in the session (pre-FOMC rally had taken price above 25,000, then selloff began).
- HIRO: QQQ P8 then P4 then P-1 EXTREME BEARISH. SPX P36 stable.
- This was actually the winning trade the agent DID take: NAS SHORT @ 25,024 filled at 12:33Z with confirm mode candle rejection. Hit TP at 24,788 for +236pts.
- Verdict: ALREADY CAPTURED. The agent's best trade of the week.

### SETUP #4: US30 SHORT @ DIA $480 (47,988) - DIA BEARISH BREAKDOWN
- Bar: DIA $480 -3M RED accelerator (tiny bar). Price at 47,831 already below it.
- Time: US30 was falling all session from ~47,960 to 47,728.
- HIRO: DIA P28 bearish, then P23 FALLING.
- Problem: DIA bars were all tiny (<7M). Agent correctly identified "DIA bars too small, skip."
- However: DIA HIRO was P28 falling to P23 = strong bearish signal. US30 dropped 232pts intraday.
- Entry: SHORT @ 47,960 (near DIA $480 at 47,988) | SL: 48,100 (140pts) | TP: 47,588 (DIA $476, 372pts)
- Outcome: US30 dropped to 47,728 at 19:08Z = +232pts from 47,960
- P&L: +232pts = +$23.20 (0.10 lots)
- R:R: 2.6:1
- Why missed: DIA bars were deemed "too small" at <7M gamma. But DIA HIRO was screaming bearish (P23 falling). The bar SIZE threshold was too strict for US30.
- Lesson: For US30, even small DIA bars (+/-3M) can provide valid entries if HIRO is extreme. Lower the threshold for DIA.

---

## APRIL 9 SETUPS (Pre-CPI Congestion Day)

### SETUP #5: NAS100 LONG @ SPX $6800 (25,011) - PCE BOUNCE
- Bar: SPX $6800 +1582M GREEN wall (second fattest bar)
- Time: 13:28Z (9:28AM ET). NAS rallied from 24,880 to 24,901 at 13:28Z, touching the $6800 zone from below. Price oscillated between 24,850-24,931 from 13:24Z to 13:47Z.
- HIRO: SPX P51 neutral, QQQ P16 bearish (improving from P-3), DIA P47 neutral. By 13:31Z QQQ jumped P16 to P52.
- Tape: Flipped bullish (calls dominant 10K).
- Flow: MASSIVE 64K institutional LEAPS calls SPX $300+ Sep. Bullish.
- VRP: SPX -0.027 (slightly negative but mild).
- Entry: LONG @ 24,870 (near $6800 at 25,011 -- actually price was below the bar, approaching from below) 
- Problem: Price was 140pts BELOW the $6800 bar. The nearest bars to price were NOT fat enough.
- Actual useful bar: The 0DTE maxGEX was at SPX $6740 (NAS 24,785) -- price was ABOVE this.
- Better framing: NAS was in a vacuum between $6740 (24,785) and $6810 (25,047). No fat bars in the 24,870 zone.
- Verdict: WEAK SETUP due to no gamma bar at price. But price DID rally from 24,850 to 25,079. A 229pt move with no order within 200pts.

### SETUP #6: NAS100 LONG @ SPY $679 (25,050) - FIRST TEST
- Bar: SPY $679 +617M GREEN support
- Time: 16:45Z-16:55Z. NAS dropped from 25,027 to 25,002 testing SPY $679 level at ~25,000/25,050 zone. BOUNCED to 25,014.
- HIRO at touch: SPX P92 HIGH. QQQ P61 NEW LOW. DIA P90. GLD P56.
- Flow: Inst flow BULLISH +19.2M delta (divergence from HIRO). SPX CALL $6,825 SELL $127K opex pin.
- L60 Score: 1.5 BOUNCE vs 3.5 BREAK at first test.
- Entry: LONG @ 25,002 | SL: 24,960 (42pts, below SPY $679) | TP: 25,084 (SPX $6820, 82pts)
- Outcome: NAS bounced from 25,002 to 25,014 immediately. Continued choppy 25,000-25,034 for next 20 minutes. Eventually rallied to 25,079 at 19:00Z.
- P&L: +82pts to TP = +$8.20
- R:R: 1.95:1
- Why missed: Agent had orders at SPX $6865 (25,250 -- 248pts away) and $6740 (24,773 -- 229pts away). Nothing near the SPY $679 level where price was actually trading.
- Lesson: L97 violation. Nearest order was 229pts from price in a 116pt range day.

### SETUP #7: NAS100 LONG @ SPY $679 (25,000) - SECOND TEST (STRONGER BOUNCE)
- Bar: SPY $679 +617M GREEN support
- Time: 17:05Z. NAS dropped to 25,000 for second test. SPX HIRO P95 4th consecutive high.
- HIRO: SPX P95 EXTREME BULLISH rising. QQQ P48. DIA P83.
- Flow: MONSTER VIX $1.49M straddle + $705K downside = BULLISH Jun. QQQ CALL $586 $120K.
- L60 Score: 4 BOUNCE vs 2 BREAK.
- Entry: LONG @ 25,000 | SL: 24,960 (40pts) | TP: 25,084 (SPX $6820, 84pts)
- Outcome: Price bounced immediately from 25,000 to 25,020 (+20), then continued to 25,079 session high at 19:00Z.
- P&L: +84pts = +$8.40 to TP
- R:R: 2.1:1
- Why missed: Same as Setup #6. No order near price.

### SETUP #8: NAS100 SHORT @ SPX $6830 (25,121) - RESISTANCE REJECTION
- Bar: SPX $6830 -1254M RED accelerator (dense resistance)
- Time: 17:45Z-18:10Z. NAS broke above 25,053 (SPX $6825) and tested $6830 at 25,057 (17:50Z), 25,065 (17:55Z), 25,073 (18:10Z). The $6830 bar at 25,121 was never quite reached -- price peaked at 25,079 at 19:00Z.
- HIRO: SPX P104-P110 EXTREME. But momentum was decelerating.
- Flow: Institutional shifted from 10.7:1 bullish to 0.41:1 BEARISH by 18:05Z. Distribution pattern.
- Actually price was 42pts BELOW the $6830 bar. The level conversion had the bar at ~25,121 but price peaked at 25,079.
- Entry: SHORT @ 25,079 (session high) | SL: 25,130 (51pts above $6830) | TP: 25,011 (SPX $6800, 68pts)
- Outcome: NAS reversed from 25,079 to 25,054 by 19:25Z, continued to 24,982 low at 20:27Z.
- P&L: +68pts to $6800 TP = +$6.80. If held to 24,982 = +97pts = +$9.70
- R:R: 1.3:1 (marginal)
- Why missed: Agent was watching for SHORT@$6865 which was 171pts above. The actual resistance was $6830 zone. Institutional flow was screaming distribution (10.7:1 to 0.41:1 bearish flip) but agent did not place an order at $6830.
- Lesson: $6830 -1254M was a MASSIVE red bar. Orders should have been at EVERY bar, not just the $6865 call wall.

### SETUP #9: NAS100 SHORT @ SPX $6820 (25,084) - POWER HOUR REJECTION
- Bar: SPX $6820 +876M GREEN support (but acting as resistance on retest from above)
- Time: 20:27Z (4:27PM ET power hour). NAS crashed from 25,054 to 24,987. SPX HIRO P96 biggest drop of session.
- HIRO: SPX P96 (-5 BIGGEST DROP SESSION). SPY tape -100 MAX BEARISH.
- Flow: $4.1M institutional RANGE bet but net bearish shift.
- This was a BREAKDOWN of $6820, not a rejection. Price broke through support.
- Entry: SHORT @ 24,987 (break below $6820/SPY$679) | SL: 25,020 (33pts) | TP: 24,946 ($6800 support, 41pts)
- Outcome: NAS dropped to 24,982 at 20:35Z (session low), bounced to 25,013 at 20:42Z. Then choppy.
- P&L: Only +5pts to actual low. Marginal. Would likely have been stopped out on the bounce.
- R:R: 1.2:1
- Verdict: MARGINAL SETUP. The selloff was real but shallow (only -5pts below entry before bounce). L69 congestion zone killed momentum.

### SETUP #10: US30 LONG @ DIA $483 (48,288) - DIA RALLY
- Bar: DIA $483 +37M GREEN support (fattest DIA bar)
- Time: US30 rallied from 47,697 at 13:09Z to 48,309 at 19:00Z = +612pts. It crossed DIA $483 (48,288) at approximately 17:15Z upward.
- HIRO: DIA P80 RISING +33 at 13:31Z, then P83, P97 by power hour. EXTREME BULLISH.
- Flow: DIA institutional CALL $493 BUY $167K x3 fills.
- Entry: LONG @ 48,050 (near DIA $480 zone, earlier in the rally) | SL: 47,900 (150pts) | TP: 48,288 (DIA $483, 238pts)
- Outcome: US30 rallied to 48,309 (+259pts from 48,050)
- P&L: +238pts to TP = +$23.80
- R:R: 1.6:1
- Why missed: Agent said "DIA bars tiny <7M, skip" early in session. But DIA $483 had +37M gamma -- this was NOT tiny. And DIA HIRO was P80+ screaming bullish. Zero orders placed on US30 all day.
- Lesson: DIA $483 +37M was a valid bar. DIA HIRO P80+ was a screaming signal. US30 moved 612pts with zero orders.

### SETUP #11: XAUUSD LONG @ GLD $440 (4,793) - GOLD RALLY
- Bar: GLD $440 +5M GREEN (small)
- Time: XAU rallied from 4,741 at 13:11Z to 4,800 at 19:00Z = +59pts. Crossed GLD $440 (4,793) at approximately 16:35Z.
- HIRO: GLD P56 neutral, rising to P63 session peak at 19:15Z.
- Flow: GLD $2.1M ATM straddle at $439 at 16:08Z. GLD CALL $440 BUY $273K. LEAPS bullish.
- VRP: -0.033 negative (L91 says don't go LONG). But GLD HIRO was improving.
- Entry: LONG @ 4,770 (near GLD $440) | SL: 4,745 (25pts) | TP: 4,800 (30pts)
- Outcome: XAU hit 4,800 at 19:00Z = +30pts from entry
- P&L: +30pts = +$30.00 (0.01 lots, $1/pt)
- R:R: 1.2:1 (marginal with VRP negative)
- Why missed: L91 cancellation. GLD VRP -0.033 = don't go LONG. But the flow was massively bullish ($2.1M straddle + $273K calls). HIRO was improving.
- Lesson: VRP negative was correct as a warning, but $2.1M institutional flow at $440 should have overridden. When institutional flow is 10x normal, VRP becomes secondary.

---

## APRIL 10 SETUPS (CPI Day - THE BIG DAY)

### SETUP #12: NAS100 LONG @ SPX $6810/SPY $679 (25,047-25,050) - OVERNIGHT SUPPORT TEST
- Bar: SPX $6810 -897M RED + SPY $679 +617M GREEN (dual level)
- Time: 06:40Z-08:50Z. Price tested this zone SIX TIMES overnight:
  - 06:40Z: NAS 25,060 (13pts above)
  - 06:50Z: NAS 25,057 (10pts above)
  - 07:15Z: NAS 25,058 (11pts above)
  - 08:05Z: NAS 25,057 (10pts above)
  - 08:15Z: NAS 25,049 (2pts above -- AT the level!)
  - 08:50Z: NAS 25,049 (AT level again!)
- HIRO: Not available overnight (data stale). Using end-of-day snapshot: SPX P94, HIRO bearish trend.
- VRP: +0.037 positive = mean reversion.
- Entry: LONG @ 25,050 (at SPY $679) | SL: 25,010 (40pts, below SPX $6800) | TP: 25,121 (SPX $6830, 71pts)
- Outcome: From 08:50Z test at 25,049, NAS bounced to 25,081 at 09:20Z (+32pts spike). Then at CPI (12:30Z) spiked to 25,161.
- P&L: +71pts to TP = +$7.10. If held through CPI: +111pts = +$11.10
- R:R: 1.8:1
- Why missed: Agent had LONG@SPX $6800 (25,011) = 39pts BELOW the actual support level. The $6810/$679 zone was where price was bouncing, not $6800. Agent noted "810 RED 10pts!" multiple times but never placed an order there.
- Lesson: The SPY $679 GREEN (+617M) was the real support, not SPX $6800. Price bounced 6 times from this exact level. An order AT SPY $679 would have filled multiple times.

### SETUP #13: NAS100 LONG @ SPX $6810/SPY $679 - CPI DIP BUY
- Bar: SPX $6810 -897M RED + SPY $679 +617M GREEN
- Time: 08:50Z-09:00Z. Post-CPI initial reaction muted. NAS dropped to 25,041 at 08:55Z (BELOW SPY $679) then immediately bounced.
- CPI released at 08:30Z. NAS at 25,058. Dropped to 25,041 by 08:55Z.
- Entry: LONG @ 25,041 (CPI dip to support) | SL: 25,000 (41pts) | TP: 25,121 (SPX $6830, 80pts)
- Outcome: NAS rallied from 25,041 to 25,161 at CPI+60min, then to 25,226 session high.
- P&L: +80pts to TP1 = +$8.00. If held to session high: +185pts = +$18.50
- R:R: 1.95:1
- Why missed: Agent was waiting for LONG@SPX $6800 (25,011) which was 30pts lower. Price bounced 30pts above the order level. The actual support was SPY $679 zone, not SPX $6800.

### SETUP #14: NAS100 SHORT @ SPX $6865 (25,250) - THE BIG MISS (ALREADY DOCUMENTED)
- Bar: SPX $6865 +1401M GREEN wall (call wall ceiling)
- Time: 15:24Z. NAS reached 25,226 (1pt from entry at 25,227). CONFIRM mode blocked fill.
- HIRO: SPX P39 BEARISH (crashed from P50). Tape -17 bearish.
- Flow: Institutions selling resumed. HIRO P50 to P39 in 30 minutes.
- Entry: SHORT @ 25,226 | SL: 25,340 (114pts) | TP: 25,116 (110pts)
- Outcome: NAS crashed from 25,226 to 25,040 (-186pts)
- P&L: +110pts to TP1 = +$11.00. Full move: +186pts = +$18.60
- R:R: ~1:1 on original plan, but actual move was 1.6:1
- Why missed: CONFIRM mode required candle rejection. Switched to LEVEL 5 min later but price had already fallen 45pts. ALREADY DOCUMENTED in previous analysis.

### SETUP #15: NAS100 SHORT @ SPX $6830 (25,121) - POST-CPI FADE
- Bar: SPX $6830 -1254M RED accelerator
- Time: 12:30Z-14:05Z. CPI spike took NAS to 25,161 at 12:30Z. It oscillated between 25,129-25,172 for 90 minutes, repeatedly touching the $6830 zone (25,121).
  - 14:05Z: NAS 25,129 (8pts above $6830)
  - 14:10Z: NAS 25,111 (10pts below $6830 -- BROKE IT)
- HIRO: P38 BEARISH for 8 consecutive cycles by 14:00Z.
- Tape: +25 bullish but fading.
- Flow: Institutions selling.
- Entry: SHORT @ 25,129 (at $6830 zone, confirmation of rejection) | SL: 25,180 (51pts) | TP: 25,050 (SPY $679, 79pts)
- Outcome: NAS broke below 25,111 at 14:10Z, crashed to 25,040 session low by late session.
- P&L: +79pts to TP = +$7.90
- R:R: 1.5:1
- Why missed: Agent had no order at $6830. Only order was SHORT@$6865 (126pts above). The $6830 rejection was visible for 90 minutes with bearish HIRO confirming.

### SETUP #16: NAS100 SHORT @ SPX $6825 (25,103) - BREAKDOWN CONTINUATION
- Bar: SPX $6825 -1114M RED accelerator
- Time: 14:10Z-14:45Z. NAS dropped below $6830 to 25,111, continued to 25,103 ($6825 zone). Bounced to 25,172 at 13:45Z (whipsaw). Then SOLD OFF HARD.
- HIRO: P38 bearish, briefly P50 (fake recovery), then crashed to P39 again by 15:01Z.
- The whipsaw makes this harder. NAS went 25,111 -> 25,172 -> 25,111 in 60 minutes.
- Entry: SHORT @ 25,172 (rejection of reclaim attempt) | SL: 25,210 (38pts) | TP: 25,103 (SPX $6825, 69pts)
- Outcome: NAS dropped from 25,172 to 25,040 = +132pts
- P&L: +69pts to TP = +$6.90
- R:R: 1.8:1
- Why missed: Agent still had only the SHORT@$6865 order. No orders at intermediate levels.

### SETUP #17: US30 SHORT @ DIA $480 (47,988) - THE CRASH
- Bar: DIA $480 -3M RED accelerator
- Time: US30 crashed from 48,226 at 12:31Z to 47,850 at 17:29Z = -376pts. It broke below DIA $480 (47,988) at approximately 13:50Z.
- HIRO: DIA P3-P6 EXTREME BEARISH all day Apr 10. The agent noted "DIA P3 EXTREME BEARISH."
- Tape: Bearish.
- Flow: CPI initially bullish but US30 diverged -- NAS rallied while US30 sold.
- Entry: SHORT @ 48,100 (at market open when DIA HIRO was P3) | SL: 48,300 (200pts, above DIA $483 support) | TP: 47,588 (DIA $476, 512pts)
- Outcome: US30 crashed to 47,850 at 17:29Z = +250pts from entry
- P&L: +250pts = +$25.00
- R:R: 1.25:1 (to actual low), much better if DIA $476 hit (2.56:1)
- Why missed: Agent placed US30 orders very late (16:32Z with the 18-order expansion). By then US30 had already crashed 300pts. DIA HIRO was P3 from market open but agent had ZERO US30 orders for the first 3 hours of trading.
- Lesson: DIA HIRO P3 is the MOST EXTREME bearish possible. This alone justified a SHORT order immediately at open. A 376pt crash was completely predictable from the HIRO reading.

### SETUP #18: US30 SHORT @ DIA $483 (48,288) - EARLY REJECTION
- Bar: DIA $483 +37M GREEN support
- Time: US30 peaked at 48,226 at 12:31Z (just below DIA $483 at 48,288). This was the CPI spike high. Never reclaimed.
- HIRO: DIA P3 extreme bearish at open.
- Entry: SHORT @ 48,226 (CPI spike rejection below DIA $483) | SL: 48,350 (124pts, above $483 bar + buffer) | TP: 47,988 (DIA $480, 238pts)
- Outcome: US30 went straight down from 48,226 to 47,850 = -376pts
- P&L: +238pts to TP = +$23.80. Full move: +376pts = +$37.60
- R:R: 1.9:1 (to TP), 3.0:1 (full move)
- Why missed: No US30 orders at all during this period. Agent was 100% focused on NAS.

### SETUP #19: XAUUSD LONG @ 4,732-4,742 - CPI GOLD DIP
- Bar: GLD $430 +13M GREEN support at ~4,684 (52pts below). No fat bar at the 4,732-4,742 zone.
- Time: 08:45Z-08:55Z. XAU crashed from 4,750 to 4,732-4,733 post-CPI (session low).
- HIRO: Not updated yet at CPI release.
- VRP: Was positive for SPX/DIA but negative for GLD.
- Entry: LONG @ 4,735 | SL: 4,710 (25pts) | TP: 4,793 (GLD $440, 58pts)
- Outcome: XAU bounced from 4,732 to 4,794 session high at 14:30Z = +62pts
- P&L: +58pts to TP = +$58.00 (0.01 lots, $1/pt -- THIS IS THE BIGGEST DOLLAR WINNER)
- R:R: 2.3:1
- Why missed: Agent had XAU LONG@GLD $450 at 4,902 = 170pts above price. No bar near 4,732. The nearest bar was GLD $430 at 4,684, 48pts below price. However, the XAU session low bounce was tradeable even without a fat bar -- CPI reaction + mean reversion signal.
- Lesson: XAU had the best dollar P&L opportunity of the day. GLD bars were all far from price. Need intermediate GLD bars or alternative entry triggers for gold.

### SETUP #20: XAUUSD SHORT @ GLD $440 (4,793) - POWER HOUR GOLD REJECTION  
- Bar: GLD $440 +5M GREEN support (small)
- Time: 14:25Z-14:30Z. XAU peaked at 4,794 at 14:30Z (new session high), exactly at GLD $440 (4,793). Then reversed.
- HIRO: GLD P55 (neutral). Tape bearish.
- Entry: SHORT @ 4,793 (at GLD $440 rejection) | SL: 4,810 (17pts) | TP: 4,760 (33pts)
- Outcome: XAU dropped from 4,794 to 4,757 at 16:22Z = -37pts from peak
- P&L: +33pts to TP = +$33.00
- R:R: 1.9:1
- Why missed: No XAU order at GLD $440. Agent had LONG@GLD $450 (4,902) -- 109pts above price.

### SETUP #21: NAS100 SHORT @ SPX $6825 (25,103) - LATE SESSION BREAKDOWN
- Bar: SPX $6825 -1114M RED accelerator
- Time: 16:22Z. NAS at 25,113. Agent placed 9 orders. HIRO P35 BEARISH.
- By 16:32Z: NAS crashed to 25,066 and agent placed 18 orders. Then executor bugs prevented fills.
- Entry: SHORT @ 25,103 (at $6825 breakdown) | SL: 25,145 (42pts) | TP: 25,050 (SPY $679, 53pts)
- Outcome: NAS oscillated 25,066-25,127 for 2 hours due to executor bugs. Eventually SHORT filled at 25,109 at 19:12Z.
- P&L: Uncertain (position was open at session end with -$0.09 P&L)
- Why partially missed: Executor bugs. 18 orders placed at 16:32Z but bugs prevented processing for ~2.5 hours.

### SETUP #22: NAS100 LONG @ SPX $6820 (25,084) - BOUNCE FROM SUPPORT
- Bar: SPX $6820 +876M GREEN support
- Time: 16:22Z. Agent logged "NAS approaching LONG@6820(29pts)." NAS at 25,113, dropping toward 25,084.
- HIRO: P35 BEARISH. Tape bearish.
- L60 Score: BREAK favored (HIRO bearish + tape bearish + flow bearish).
- This should have been a SHORT (L100 flip) not a LONG. Agent actually DID apply L100 and flipped SPY $679 LONG to SHORT.
- Entry: SHORT @ 25,079 (at SPY $679 breakdown) | SL: 25,120 (41pts) | TP: 25,011 (SPX $6800, 68pts)
- Outcome: NAS bottomed at 25,040 then bounced to 25,127. Would have hit TP at 25,011? No -- NAS never reached 25,011 during this period (low was 25,040).
- P&L: Partial profit +39pts to the low = +$3.90. TP would not have been reached.
- Lesson: L100 flip was CORRECT conceptually, but executor bugs prevented the fill.

### SETUP #23: US30 SHORT @ DIA $480 (47,988) - CONTINUED CRASH
- Bar: DIA $480 -3M RED accelerator
- Time: 16:32Z. US30 at 47,852. Already BELOW DIA $480. Agent placed 4 US30 orders in the 18-order batch.
- HIRO: DIA P3 EXTREME.
- Entry: SHORT @ 47,900 (any entry after break below $480) | SL: 48,050 (150pts) | TP: 47,588 (DIA $476, 312pts)
- Outcome: US30 dropped to 47,850 at 17:29Z = only -50pts more from 47,900.
- P&L: +50pts = +$5.00 (most of the move already happened)
- R:R: 0.3:1 (terrible -- the crash was mostly done)
- Verdict: TOO LATE. The agent placed US30 orders 3 hours into a 376pt crash.

---

## SUMMARY TABLE: ALL SETUPS

| # | Day | CFD | Dir | Level | Bar | Entry | TP | P&L | R:R | Status |
|---|-----|-----|-----|-------|-----|-------|-----|-----|-----|--------|
| 1 | Apr 8 | NAS | LONG | SPX $6740 | +1842M | 24,800 | 24,900 | +$10.00 | 2:1 | MISSED (no order at fattest bar) |
| 2 | Apr 8 | XAU | SHORT | - | - | 4,723 | 4,684 | -$37.00 | - | NOT VALID (no bar, already extended) |
| 3 | Apr 8 | NAS | SHORT | SPX $6800 | +1582M | 25,024 | 24,788 | +$23.60 | 2:1 | TAKEN (best trade of week) |
| 4 | Apr 8 | US30 | SHORT | DIA $480 | -3M | 47,960 | 47,588 | +$23.20 | 2.6:1 | MISSED (DIA bars "too small") |
| 5 | Apr 9 | NAS | LONG | - | vacuum | 24,870 | 25,079 | +$20.90 | - | MISSED (no bar at price) |
| 6 | Apr 9 | NAS | LONG | SPY $679 | +617M | 25,002 | 25,084 | +$8.20 | 1.95:1 | MISSED (order 229pts away) |
| 7 | Apr 9 | NAS | LONG | SPY $679 | +617M | 25,000 | 25,084 | +$8.40 | 2.1:1 | MISSED (order 229pts away) |
| 8 | Apr 9 | NAS | SHORT | SPX $6830 | -1254M | 25,079 | 25,011 | +$6.80 | 1.3:1 | MISSED (order at $6865 only) |
| 9 | Apr 9 | NAS | SHORT | SPX $6820 | +876M | 24,987 | 24,946 | MARGINAL | 1.2:1 | MARGINAL (shallow, L69 congestion) |
| 10 | Apr 9 | US30 | LONG | DIA $483 | +37M | 48,050 | 48,288 | +$23.80 | 1.6:1 | MISSED (zero US30 orders) |
| 11 | Apr 9 | XAU | LONG | GLD $440 | +5M | 4,770 | 4,800 | +$30.00 | 1.2:1 | MISSED (VRP override) |
| 12 | Apr 10 | NAS | LONG | SPY $679 | +617M | 25,050 | 25,121 | +$7.10 | 1.8:1 | MISSED (order below at $6800) |
| 13 | Apr 10 | NAS | LONG | SPY $679 | +617M | 25,041 | 25,121 | +$8.00 | 1.95:1 | MISSED (CPI dip buy) |
| 14 | Apr 10 | NAS | SHORT | SPX $6865 | +1401M | 25,226 | 25,116 | +$11.00 | 1:1 | MISSED (CONFIRM mode) |
| 15 | Apr 10 | NAS | SHORT | SPX $6830 | -1254M | 25,129 | 25,050 | +$7.90 | 1.5:1 | MISSED (no order at $6830) |
| 16 | Apr 10 | NAS | SHORT | SPX $6825 | -1114M | 25,172 | 25,103 | +$6.90 | 1.8:1 | MISSED (no order at $6825) |
| 17 | Apr 10 | US30 | SHORT | DIA $480 | -3M | 48,100 | 47,588 | +$25.00 | 1.25:1 | MISSED (zero US30 orders at open) |
| 18 | Apr 10 | US30 | SHORT | DIA $483 | +37M | 48,226 | 47,988 | +$23.80 | 1.9:1 | MISSED (no US30 orders) |
| 19 | Apr 10 | XAU | LONG | - | (no bar) | 4,735 | 4,793 | +$58.00 | 2.3:1 | MISSED (order 170pts above) |
| 20 | Apr 10 | XAU | SHORT | GLD $440 | +5M | 4,793 | 4,760 | +$33.00 | 1.9:1 | MISSED (no XAU order near price) |
| 21 | Apr 10 | NAS | SHORT | SPX $6825 | -1114M | 25,103 | 25,050 | +$5.30 | 1.3:1 | PARTIAL (executor bugs) |
| 22 | Apr 10 | NAS | SHORT | SPY $679 | +617M | 25,079 | 25,011 | +$3.90 | 1.7:1 | MISSED (executor bugs) |
| 23 | Apr 10 | US30 | SHORT | DIA $480 | -3M | 47,900 | 47,588 | +$5.00 | 0.3:1 | TOO LATE (3h into crash) |

---

## AGGREGATE ANALYSIS

### By CFD Performance
| CFD | Valid Setups | Missed | Taken | Potential P&L |
|-----|-------------|--------|-------|---------------|
| NAS100 | 14 | 12 | 1 (Trade 3) | +$126.10 missed |
| US30 | 5 | 5 | 0 | +$100.80 missed |
| XAUUSD | 3 | 3 | 0 | +$121.00 missed |
| **TOTAL** | **22** | **20** | **1** | **+$347.90 missed** |

### By Failure Category
| Category | Count | $ Lost | Examples |
|----------|-------|--------|---------|
| No order near price (L97) | 10 | $160.10 | Setups 1, 6, 7, 8, 12, 13, 15, 16, 19, 20 |
| US30 neglected entirely | 4 | $77.80 | Setups 4, 10, 17, 18 |
| Executor bugs | 2 | $9.20 | Setups 21, 22 |
| CONFIRM mode blocked | 1 | $11.00 | Setup 14 |
| VRP override (debatable) | 1 | $30.00 | Setup 11 |
| Too late entry | 1 | $5.00 | Setup 23 |
| Already taken | 1 | +$23.60 | Setup 3 |
| Not valid | 2 | $0 | Setups 2, 9 |

### Top 5 Most Costly Misses
1. **SETUP #19: XAU LONG CPI dip** = +$58.00 (no GLD bar near price)
2. **SETUP #20: XAU SHORT $440 rejection** = +$33.00 (no order near price)
3. **SETUP #17: US30 SHORT at open** = +$25.00 (zero US30 orders, DIA P3 ignored)
4. **SETUP #18: US30 SHORT CPI rejection** = +$23.80 (zero US30 orders)
5. **SETUP #10: US30 LONG rally** = +$23.80 (zero US30 orders Apr 9)

### The US30 Problem
US30 was the most neglected CFD:
- Apr 9: US30 rallied 612pts (47,697 to 48,309). ZERO orders placed. DIA HIRO was P80+ bullish.
- Apr 10: US30 crashed 376pts (48,226 to 47,850). DIA HIRO P3 extreme bearish. Orders placed 3 hours late.
- Combined missed P&L from US30 alone: **+$100.80**
- Root cause: Agent dismissed DIA bars as "too small" despite DIA $483 having +37M gamma (above the 10M threshold in CLAUDE.md).

### The XAU Problem
XAU had excellent setups but no orders near price:
- Apr 10 CPI dip (4,732) = 170pts from nearest order at GLD $450 (4,902)
- Apr 10 $440 rejection (4,793) = exactly at GLD $440 bar but no order there
- GLD bars are spread too far apart (55pts between $430 and $440 = 108pts in CFD). Need more intermediate coverage.
- Combined missed P&L from XAU: **+$121.00** -- the HIGHEST per-CFD miss

### The Congestion Problem (Apr 9)
- NAS oscillated in a 116pt range (24,982-25,098) for the ENTIRE session
- SPY $679 (+617M) was tested 4 times and bounced every time
- SPX $6830 (-1254M) was tested repeatedly and held as resistance
- The band was: SPY $679 (25,050) to SPX $6830 (25,121) = 71pts
- 4 orders placed: nearest was SHORT@$6865 at 25,250 = 152pts above range top
- The agent logged "L69 congestion" 14+ times but never placed orders at the congestion boundaries

---

## SYSTEMIC ROOT CAUSES

### 1. Order Distance Problem
Average distance of nearest order from price:
- Apr 9: 152pts (in a 116pt range) -- ZERO CHANCE of fill
- Apr 10 pre-18-order batch: 69pts (LONG@$6800) -- reasonable but still missed
- Apr 10 morning: 115pts average for SHORT@$6865 -- too far

**Fix**: Mandate orders within 30pts of current price at ALL times. If no gamma bar exists within 30pts, use the nearest bar regardless of size.

### 2. CFD Bias Problem
Order distribution over 3 days:
- NAS100: ~85% of all orders
- US30: ~10% (mostly late Apr 10)
- XAUUSD: ~5% (mostly cancelled or overnight)

US30 had 612pt and 376pt moves with near-zero coverage. XAU had $121 in missed P&L.

**Fix**: EQUAL coverage. Every cycle must have orders on ALL 3 CFDs. US30 uses DIA bars (lower threshold: 5M instead of 10M). XAU uses GLD bars (lower threshold: 3M).

### 3. The "Fat Bar Only" Bias
The agent insisted on bars >1000M for NAS entries. But:
- SPY $679 (+617M) was THE key level -- bounced 10+ times across 3 days
- SPX $6825 (-1114M) and $6830 (-1254M) were repeatedly the actual resistance
- DIA $483 (+37M) was a valid US30 level
- The threshold prevented orders at perfectly valid structural levels

**Fix**: Lower thresholds: NAS >300M, US30 >5M, XAU >3M. Any bar that price reacts to repeatedly is valid regardless of gamma size.

### 4. CONFIRM Mode Default
The biggest single miss (Setup #14, +$18.60) was caused by CONFIRM mode on a with-trend entry. L83 already says LEVEL mode default. But the agent used CONFIRM for the SHORT@$6865 anyway.

**Fix**: Enforce L83 strictly. CONFIRM only for counter-trend. All other entries = LEVEL.

### 5. Late Reaction to HIRO Extremes
DIA HIRO P3 at market open Apr 10 = most extreme bearish reading possible. Agent placed zero US30 orders for 3 hours. By the time 18 orders were placed, US30 had already crashed 300pts.

**Fix**: HIRO extreme readings (<P10 or >P90) should trigger IMMEDIATE order placement within 5 minutes, regardless of bar size.

---

## POTENTIAL P&L IF ALL VALID SETUPS WERE TAKEN

Conservative estimate (taking only the 15 highest-confidence setups with R:R >= 1.5:1):

| Setup | P&L |
|-------|-----|
| #1 NAS LONG $6740 | +$10.00 |
| #3 NAS SHORT $6800 (TAKEN) | +$23.60 |
| #4 US30 SHORT $480 | +$23.20 |
| #6 NAS LONG SPY$679 | +$8.20 |
| #7 NAS LONG SPY$679 | +$8.40 |
| #10 US30 LONG $483 | +$23.80 |
| #12 NAS LONG SPY$679 overnight | +$7.10 |
| #13 NAS LONG CPI dip | +$8.00 |
| #14 NAS SHORT $6865 | +$11.00 |
| #15 NAS SHORT $6830 | +$7.90 |
| #16 NAS SHORT $6825 | +$6.90 |
| #17 US30 SHORT $480 | +$25.00 |
| #18 US30 SHORT $483 | +$23.80 |
| #19 XAU LONG CPI dip | +$58.00 |
| #20 XAU SHORT $440 | +$33.00 |
| **TOTAL** | **+$301.50** |
| Minus actual losses | -$106.73 |
| **Theoretical net** | **+$194.77** |

Even with a realistic 50% win rate on these setups: **+$67.02 net** vs actual **-$50.61**

---

## ACTIONABLE RECOMMENDATIONS (PRIORITY ORDER)

1. **MANDATORY: Orders on ALL 3 CFDs every cycle.** US30 and XAU cannot be zero-coverage ever again.
2. **MANDATORY: At least one order within 50pts of NAS price, $5 of XAU, 150pts of US30 at all times.**
3. **Lower bar thresholds**: NAS >300M (was >500M), US30 >5M (was >10M), XAU >3M (was >20M for some entries).
4. **HIRO extreme = immediate orders**: <P10 or >P90 triggers order placement within 1 cycle.
5. **LEVEL mode enforced**: CONFIRM only when L60 score explicitly says counter-trend AND HIRO is extreme opposite.
6. **Congestion boundaries get orders**: When L69 congestion detected, place LONG at bottom boundary + SHORT at top boundary.
7. **XAU needs more bars**: Request GLD bars at $1 intervals (not $5) near price, or use alternative entry triggers.
8. **Fix executor before next session**: Field name standardization complete. Add health check.
9. **Breakeven SL = entry + 5pts**: Prevents shakeouts like Trade 7.
10. **US30 DIA bars now use DIA-only (L98)**: Ensure the endpoint returns DIA bars properly.
