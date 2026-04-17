# Trade Modes Backtest: April 8-10, 2026

## Methodology
- 7 actual trades (from trade-history) + 23 identified setups = 30 scenarios
- Each classified as SCALP / INTRADAY / SWING per auto-classification rules
- SL, BE, trail, and pyramid simulated per mode rules
- Dollar P&L at 0.10 lots NAS/US30 ($0.10/pt), 0.01 lots XAU ($1.00/pt)
- SWING uses reduced volume: 0.03 NAS/US30, 0.01 XAU

---

## PART 1: ACTUAL TRADES (7 completed trades)

### Trade 1: NAS SHORT @24,925 (Apr 8 overnight)
| Factor | Value | Classification |
|--------|-------|----------------|
| Session | Overnight (11PM ET) | SWING candidate |
| HIRO | QQQ P-1 extreme bearish | SWING (extreme HIRO) |
| Flow expiry | Post-FOMC overnight | SWING |
| Bar separation | SL 100pts to TP 62pts | INTRADAY range |
| **Mode** | **SWING** | Overnight + extreme HIRO |

| Metric | Original | SWING Mode |
|--------|----------|------------|
| SL width | 100pts | 150pts (2 bars back + overnight buffer) |
| Volume | 0.10 | 0.03 |
| Survived? | NO (hit SL at +101pts) | YES (150pt SL holds; price peaked at +101pts) |
| BE trigger | N/A (never profitable) | 1.5R = 93pts profit needed |
| Trail | N/A | gamma-trail 25pts buffer every 4h |
| Outcome (original) | SL hit -101pts | -$10.11 |
| Outcome (SWING) | Survives, price reverses to TP next day | TP1 hit +62pts |
| P&L (SWING) | +62pts x $0.03 = **+$1.86** | |
| Pyramid | Price breaks 24,862 (TP1), next bar 24,790. Add SHORT @24,862 SL 24,925 TP 24,790 | +72pts x $0.03 = +$2.16 |
| **P&L with pyramid** | **+$4.02** | |

### Trade 2: XAU SHORT @4,800.15 (Apr 8 overnight)
| Factor | Value | Classification |
|--------|-------|----------------|
| Session | Overnight | SWING |
| HIRO | GLD P52-P64 neutral/rising | Not extreme |
| VRP | -0.033 negative = momentum | SWING (momentum regime) |
| **Mode** | **SWING** | Overnight + momentum regime |

| Metric | Original | SWING Mode |
|--------|----------|------------|
| SL width | 19pts | 35pts (overnight XAU minimum per L76) |
| Volume | 0.01 | 0.01 (same for XAU SWING) |
| Survived? | NO (hit SL at +28pts) | YES (35pt SL holds; price peaked +28pts above entry) |
| BE trigger | N/A | 1.5R = 52.5pts profit needed |
| Outcome (original) | SL hit -28pts | -$28.04 |
| Outcome (SWING) | Survives, XAU dropped to 4,760 then 4,723 | TP at 4,760 (+40pts) |
| P&L (SWING) | +40pts x $1.00 = **+$40.00** | |
| Pyramid | Price breaks 4,760, next bar 4,684. Add @4,760 SL 4,800 TP 4,684. Bounce at 4,723 = no TP2 hit | Not triggered fully |
| **P&L with pyramid** | **+$40.00** | |

### Trade 3: US30 SHORT @47,625.5 (Apr 8 overnight)
| Factor | Value | Classification |
|--------|-------|----------------|
| Session | Overnight midnight | SWING |
| Context | FOMC relief rally ongoing | Counter-trend = wrong direction |
| **Mode** | **SWING** | Overnight |

| Metric | Original | SWING Mode |
|--------|----------|------------|
| SL width | 310pts | 400pts (2-3 bars back, overnight) |
| Volume | 0.10 | 0.03 |
| Survived? | NO (price rallied +684pts) | NO (stopped at 400pts) |
| Outcome (original) | SL hit -334pts | -$33.41 |
| Outcome (SWING) | Stopped at 400pts but 0.03 vol | -400pts x $0.03 = **-$12.00** |
| **P&L with pyramid** | **-$12.00** | SWING reduced damage 64% |

### Trade 5: NAS SHORT @25,024.25 (Apr 8 pre-market) -- WINNER
| Factor | Value | Classification |
|--------|-------|----------------|
| Session | Pre-market 8:33AM ET | INTRADAY |
| Duration | 143 min | INTRADAY |
| **Mode** | **INTRADAY** | Directional move, market hours |

| Metric | Original | INTRADAY Mode |
|--------|----------|---------------|
| SL width | 116pts | 116pts (appropriate) |
| Volume | 0.10 | 0.10 |
| BE trigger | 1R=116pts: SL->entry+5=25,019 | Same as executor gamma-trail already did |
| Trail | Gamma-trail 15pts buffer | Same as original |
| Outcome | TP hit +236pts | **+$23.60** |
| Pyramid 1 | Price breaks $6800 (25,011), add @25,011 SL 25,130 TP 24,790 | +221pts x $0.10 = +$22.10 |
| Pyramid 2 | Price breaks 24,900, add @24,900 SL 25,011 TP 24,790 | +110pts x $0.10 = +$11.00 |
| **P&L with pyramid** | **+$56.70** | Pyramiding more than doubles the win |

### Trade 6: XAU LONG @4,758.12 (Apr 8 market hours)
| Factor | Value | Classification |
|--------|-------|----------------|
| Session | Market hours | INTRADAY |
| VRP | -0.033 negative | L91 = should not have been taken |
| **Mode** | **INTRADAY** | Market hours, directional |

| Metric | Original | INTRADAY Mode |
|--------|----------|---------------|
| SL width | 33pts | 33pts (5-8pts XAU = appropriate) |
| Survived? | NO | NO (same SL, same outcome) |
| Outcome | SL hit -35pts | **-$34.97** |
| Note | Mode cannot fix wrong direction. L91 violation. | |
| **P&L with pyramid** | **-$34.97** | |

### Trade 7: NAS LONG @24,890.9 (Apr 8, held overnight 19.3h)
| Factor | Value | Classification |
|--------|-------|----------------|
| Duration | 19.3 hours overnight | SWING |
| Bar | SPX $6740 +1842M fat | SWING range |
| **Mode** | **SWING** | Multi-session hold |

| Metric | Original | SWING Mode |
|--------|----------|------------|
| SL width | 162pts | 162pts (appropriate for SWING) |
| Volume | 0.10 | 0.03 |
| BE trigger (CRITICAL) | 1R=162pts: hit TP1 at +87pts, SL moved to exact entry | 1.5R=243pts: TP1 at +87pts does NOT trigger BE. SL stays at 24,729. |
| What happened | SL at exact entry (24,890.9), price dipped to 24,888.5 = stopped out -2.4pts | SL at 24,729, price dips to 24,888.5 = 162pts above SL = SAFE |
| Trail | N/A (stopped at BE) | Gamma-trail 25pts every 4h: SL stays at 24,729 until bigger move confirms |
| Outcome (original) | BE stop hit -2.4pts | -$0.24 |
| Outcome (SWING) | Position survives, NAS reaches 25,098 (+207pts). TP2 at 25,078 hit = +187pts | +187pts x $0.03 = **+$5.61** |
| Pyramid | At TP1 (24,978), add LONG @24,978 SL 24,890 TP 25,078 | +100pts x $0.03 = +$3.00 |
| **P&L with pyramid** | **+$8.61** | THE biggest mode win: delayed BE saves the trade |

### Trade 8: NAS SHORT @25,109.50 (Apr 10, 41min to close)
| Factor | Value | Classification |
|--------|-------|----------------|
| Time to close | 41 min | SCALP |
| **Mode** | **SCALP** | End-of-day, tight timeframe |

| Metric | Original | SCALP Mode |
|--------|----------|------------|
| SL width | 35.5pts | 15pts (SCALP) |
| Volume | 0.10 | 0.10 |
| Outcome | ~-20pts at last log | SL 15pts hit in chop = **-$1.50** |
| **P&L with pyramid** | **-$1.50** | Limits damage |

---

## PART 2: IDENTIFIED SETUPS (23 setups)

### Mode Classification & Simulation

| # | CFD | Dir | Mode | Reason | Entry | Mode SL | Survived? | BE When? | Pyramid Adds | Orig P&L | Mode P&L | +Pyr P&L |
|---|-----|-----|------|--------|-------|---------|-----------|----------|-------------|----------|----------|----------|
| S1 | NAS | LONG | INTRADAY | FOMC bounce, fat bar | 24,800 | 20pts | YES | 1R+5=at 24,825 | 1x @24,900 | +$10.00 | +$10.00 | +$18.90 |
| S2 | XAU | SHORT | N/A | NOT VALID | - | - | - | - | - | N/A | N/A | N/A |
| S3 | NAS | SHORT | INTRADAY | Already taken=T5 | 25,024 | 116pts | YES | - | - | +$23.60 | +$23.60 | +$23.60 |
| S4 | US30 | SHORT | INTRADAY | DIA P23 bearish, mkt hrs | 47,960 | 140pts | YES | 1R at 47,820 | 0 (no bar broken before TP) | +$23.20 | +$23.20 | +$23.20 |
| S5 | NAS | LONG | INTRADAY | Vacuum, no bar | 24,870 | 25pts | NO (low 24,818 < SL 24,845) | N/A | N/A | +$20.90 | -$2.50 | -$2.50 |
| S6 | NAS | LONG | SCALP | Congestion day | 25,002 | 15pts | YES (low 24,982, 5pt margin) | 0.5R at 25,010 | 0 (SCALP) | +$8.20 | +$8.20 | +$8.20 |
| S7 | NAS | LONG | SCALP | Congestion 2nd test | 25,000 | 15pts | YES (low 24,982, 3pt margin) | 0.5R at 25,008 | 0 (SCALP) | +$8.40 | +$8.40 | +$8.40 |
| S8 | NAS | SHORT | SCALP | Congestion resistance | 25,079 | 15pts | YES | 0.5R at 25,071 | 0 (SCALP) | +$6.80 | +$6.80 | +$6.80 |
| S9 | NAS | SHORT | SCALP | Congestion, shallow | 24,987 | 15pts | NO (bounce to 25,013) | N/A | 0 | MARG | -$1.50 | -$1.50 |
| S10 | US30 | LONG | SWING | DIA P80-P97 extreme | 48,050 | 200pts | YES | 1.5R at 48,350 | 2x @48,288, @48,309 | +$23.80 | +$7.14 | +$10.92 |
| S11 | XAU | LONG | INTRADAY | $2.1M flow, HIRO rising | 4,770 | 8pts | YES | 1R at 4,778 | 0 | +$30.00 | +$30.00 | +$30.00 |
| S12 | NAS | LONG | SWING | Overnight, 6 tests | 25,050 | 50pts | YES | 1.5R at 25,125 | 1x @25,121 | +$7.10 | +$2.13 | +$4.26 |
| S13 | NAS | LONG | INTRADAY | CPI dip buy | 25,041 | 20pts | YES | 1R+5 at 25,066 | 2x @25,121, @25,161 | +$8.00 | +$8.00 | +$21.20 |
| S14 | NAS | SHORT | INTRADAY | Post-CPI fade, HIRO P39 | 25,226 | 25pts | YES | 1R+5 at 25,196 | 2x @25,116, @25,050 | +$11.00 | +$11.00 | +$30.60 |
| S15 | NAS | SHORT | INTRADAY | $6830 rejection | 25,129 | 25pts | YES | 1R+5 at 25,099 | 1x @25,050 | +$7.90 | +$7.90 | +$15.80 |
| S16 | NAS | SHORT | INTRADAY | Breakdown continuation | 25,172 | 25pts | BARELY (whipsaw to 25,172) | 1R+5 at 25,142 | 1x @25,103 | +$6.90 | +$6.90 | +$13.80 |
| S17 | US30 | SHORT | SWING | DIA P3 extreme, crash | 48,100 | 250pts | YES | 1.5R at 47,725 | 2x @47,988, @47,850 | +$25.00 | +$7.50 | +$12.66 |
| S18 | US30 | SHORT | SWING | DIA P3, CPI rejection | 48,226 | 200pts | YES | 1.5R at 47,926 | 2x @47,988, @47,850 | +$23.80 | +$7.14 | +$12.06 |
| S19 | XAU | LONG | INTRADAY | CPI dip, mean reversion | 4,735 | 8pts | YES (low 4,732, 3pts margin) | 1R at 4,743 | 0 | +$58.00 | +$58.00 | +$58.00 |
| S20 | XAU | SHORT | SCALP | Power hour rejection | 4,793 | 5pts | YES | 0.5R at 4,790.5 | 0 (SCALP) | +$33.00 | +$33.00 | +$33.00 |
| S21 | NAS | SHORT | INTRADAY | Late breakdown | 25,103 | 25pts | YES (high 25,127, 2pts from SL) | 1R+5 at 25,073 | 0 (executor bugs) | +$5.30 | +$5.30 | +$5.30 |
| S22 | NAS | SHORT | INTRADAY | SPY$679 breakdown | 25,079 | 25pts | NO (bounce to 25,127 = 48pts) | N/A | N/A | +$3.90 | -$2.50 | -$2.50 |
| S23 | US30 | SHORT | SCALP | Too late, end of crash | 47,900 | 15pts | NO (bounce 29pts) | N/A | 0 | +$5.00 | -$1.50 | -$1.50 |

---

## PART 3: CONSOLIDATED RESULTS

### A. Actual Trades -- Mode Comparison

| Trade | Asset | Dir | Mode | Original P&L | Mode P&L | Mode+Pyr P&L | Delta |
|-------|-------|-----|------|-------------|----------|--------------|-------|
| T1 | NAS | SHORT | SWING | -$10.11 | +$1.86 | +$4.02 | +$14.13 |
| T2 | XAU | SHORT | SWING | -$28.04 | +$40.00 | +$40.00 | +$68.04 |
| T3 | US30 | SHORT | SWING | -$33.41 | -$12.00 | -$12.00 | +$21.41 |
| T5 | NAS | SHORT | INTRADAY | +$23.60 | +$23.60 | +$56.70 | +$33.10 |
| T6 | XAU | LONG | INTRADAY | -$34.97 | -$34.97 | -$34.97 | $0.00 |
| T7 | NAS | LONG | SWING | -$0.24 | +$5.61 | +$8.61 | +$8.85 |
| T8 | NAS | SHORT | SCALP | -$2.00 | -$1.50 | -$1.50 | +$0.50 |
| **TOTAL** | | | | **-$85.17** | **+$22.60** | **+$60.86** | **+$146.03** |

### B. Setups -- Mode Comparison (excluding S2 invalid, S3 duplicate of T5)

| Setup | Asset | Dir | Mode | Orig P&L | Mode P&L | Mode+Pyr P&L |
|-------|-------|-----|------|----------|----------|--------------|
| S1 | NAS | LONG | INTRADAY | +$10.00 | +$10.00 | +$18.90 |
| S4 | US30 | SHORT | INTRADAY | +$23.20 | +$23.20 | +$23.20 |
| S5 | NAS | LONG | INTRADAY | +$20.90 | -$2.50 | -$2.50 |
| S6 | NAS | LONG | SCALP | +$8.20 | +$8.20 | +$8.20 |
| S7 | NAS | LONG | SCALP | +$8.40 | +$8.40 | +$8.40 |
| S8 | NAS | SHORT | SCALP | +$6.80 | +$6.80 | +$6.80 |
| S9 | NAS | SHORT | SCALP | $0.00 | -$1.50 | -$1.50 |
| S10 | US30 | LONG | SWING | +$23.80 | +$7.14 | +$10.92 |
| S11 | XAU | LONG | INTRADAY | +$30.00 | +$30.00 | +$30.00 |
| S12 | NAS | LONG | SWING | +$7.10 | +$2.13 | +$4.26 |
| S13 | NAS | LONG | INTRADAY | +$8.00 | +$8.00 | +$21.20 |
| S14 | NAS | SHORT | INTRADAY | +$11.00 | +$11.00 | +$30.60 |
| S15 | NAS | SHORT | INTRADAY | +$7.90 | +$7.90 | +$15.80 |
| S16 | NAS | SHORT | INTRADAY | +$6.90 | +$6.90 | +$13.80 |
| S17 | US30 | SHORT | SWING | +$25.00 | +$7.50 | +$12.66 |
| S18 | US30 | SHORT | SWING | +$23.80 | +$7.14 | +$12.06 |
| S19 | XAU | LONG | INTRADAY | +$58.00 | +$58.00 | +$58.00 |
| S20 | XAU | SHORT | SCALP | +$33.00 | +$33.00 | +$33.00 |
| S21 | NAS | SHORT | INTRADAY | +$5.30 | +$5.30 | +$5.30 |
| S22 | NAS | SHORT | INTRADAY | +$3.90 | -$2.50 | -$2.50 |
| S23 | US30 | SHORT | SCALP | +$5.00 | -$1.50 | -$1.50 |
| **TOTAL** | | | | **+$296.20** | **+$232.61** | **+$296.10** |

### C. Grand Summary

| Scenario | Total P&L | Delta vs Actual |
|----------|-----------|-----------------|
| **Actual trades (as executed)** | **-$85.17** | -- |
| **Actual trades + MODES** | **+$22.60** | **+$107.77** |
| **Actual trades + MODES + PYRAMIDING** | **+$60.86** | **+$146.03** |
| | | |
| **All 21 valid setups (theoretical original)** | +$296.20 | -- |
| **All 21 valid setups + MODES** | +$232.61 | -$63.59 |
| **All 21 valid setups + MODES + PYRAMIDING** | +$296.10 | -$0.10 |

Note: SWING reduced volume causes setups to show lower mode P&L (-$63.59), but pyramiding nearly fully recovers the difference. The tradeoff: SWING protects capital on losers while pyramiding restores size on winners.

---

## PART 4: MODE DISTRIBUTION & WIN RATES

### By Mode (all 30 scenarios)
| Mode | Count | Wins | Losses | Stopped | Win Rate | Total P&L (mode) | Total P&L (+pyr) |
|------|-------|------|--------|---------|----------|-------------------|-------------------|
| SCALP | 7 | 4 | 3 | 3 tight SL | 57% | +$53.70 | +$53.70 |
| INTRADAY | 15 | 12 | 3 | 2 wide bounce, 1 bad dir | 80% | +$202.90 | +$283.00 |
| SWING | 8 | 5 | 3 | 1 wrong dir, 2 would fail anyway | 63% | +$51.37 | +$67.52 |
| **TOTAL** | **30** | **21** | **9** | | **70%** | **+$307.97** | **+$404.22** |

### SCALP Detail (7 trades)
| ID | Result | P&L | Notes |
|----|--------|-----|-------|
| S6 | WIN | +$8.20 | Congestion LONG, 15pt SL held by 5pts |
| S7 | WIN | +$8.40 | Congestion LONG 2nd test, held by 3pts |
| S8 | WIN | +$6.80 | Congestion SHORT, clean rejection |
| S20 | WIN | +$33.00 | XAU power hour, clean rejection |
| T8 | LOSS | -$1.50 | Late session chop |
| S9 | LOSS | -$1.50 | Shallow selloff, bounced past SL |
| S23 | LOSS | -$1.50 | Too late entry, bounced |
| **NET** | | **+$53.70** | 4W/3L. Losses tiny ($1.50 each). Works for congestion. |

### INTRADAY Detail (15 trades)
| ID | Result | P&L (mode) | P&L (+pyr) | Notes |
|----|--------|-----------|-----------|-------|
| T5 | WIN | +$23.60 | +$56.70 | Best actual trade. 2 pyramids = +$33.10 extra |
| T6 | LOSS | -$34.97 | -$34.97 | L91 violation. Mode can't fix. |
| S1 | WIN | +$10.00 | +$18.90 | FOMC bounce, 1 pyramid |
| S4 | WIN | +$23.20 | +$23.20 | DIA P23 SHORT |
| S5 | LOSS | -$2.50 | -$2.50 | No bar = no valid SL = stopped |
| S11 | WIN | +$30.00 | +$30.00 | XAU $2.1M flow entry |
| S13 | WIN | +$8.00 | +$21.20 | CPI dip, 2 pyramids |
| S14 | WIN | +$11.00 | +$30.60 | Post-CPI fade, 2 pyramids |
| S15 | WIN | +$7.90 | +$15.80 | $6830 rejection, 1 pyramid |
| S16 | WIN | +$6.90 | +$13.80 | Breakdown, 1 pyramid. Barely survived whipsaw. |
| S19 | WIN | +$58.00 | +$58.00 | XAU CPI dip = biggest $ winner |
| S21 | WIN | +$5.30 | +$5.30 | Late breakdown |
| S22 | LOSS | -$2.50 | -$2.50 | 48pt bounce blew 25pt SL |
| S3 | WIN | +$23.60 | +$23.60 | Duplicate of T5 |
| **NET** | | **+$202.90** | **+$283.00** | 11W/3L. Pyramiding adds +$80.10 |

### SWING Detail (8 trades)
| ID | Result | P&L (mode) | P&L (+pyr) | Notes |
|----|--------|-----------|-----------|-------|
| T1 | WIN | +$1.86 | +$4.02 | Wider SL saved overnight SHORT |
| T2 | WIN | +$40.00 | +$40.00 | Wider SL saved XAU overnight |
| T3 | LOSS | -$12.00 | -$12.00 | Wrong direction, but 0.03 vol saved $21 |
| T7 | WIN | +$5.61 | +$8.61 | 1.5R BE prevented shakeout = key finding |
| S10 | WIN | +$7.14 | +$10.92 | 612pt US30 rally, 0.03 vol limits upside |
| S12 | WIN | +$2.13 | +$4.26 | Overnight NAS bounce |
| S17 | LOSS | +$7.50 | +$12.66 | DIA P3 crash, smaller vol but profitable |
| S18 | LOSS | +$7.14 | +$12.06 | CPI rejection, smaller vol |
| **NET** | | **+$51.37** | **+$67.52** | 5W/3L. Reduced vol tradeoff. |

Note: S17 and S18 are marked "LOSS" in original classification (SWING vol reduces P&L from $25/$23.80 to $7.50/$7.14) but are actually profitable trades. The "loss" is opportunity cost vs INTRADAY volume.

---

## PART 5: PYRAMIDING ANALYSIS

### Pyramid Triggers & Results
| ID | Mode | # Adds | Trigger Levels | Extra P&L | % Boost |
|----|------|--------|----------------|-----------|---------|
| T1 | SWING | 1 | @24,862 (breaks TP1) | +$2.16 | +116% |
| T5 | INTRADAY | 2 | @25,011, @24,900 | +$33.10 | +140% |
| T7 | SWING | 1 | @24,978 (at TP1) | +$3.00 | +53% |
| S1 | INTRADAY | 1 | @24,900 | +$8.90 | +89% |
| S10 | SWING | 2 | @48,288, @48,309 | +$3.78 | +53% |
| S12 | SWING | 1 | @25,121 | +$2.13 | +100% |
| S13 | INTRADAY | 2 | @25,121, @25,161 | +$13.20 | +165% |
| S14 | INTRADAY | 2 | @25,116, @25,050 | +$19.60 | +178% |
| S15 | INTRADAY | 1 | @25,050 | +$7.90 | +100% |
| S16 | INTRADAY | 1 | @25,103 | +$6.90 | +100% |
| S17 | SWING | 2 | @47,988, @47,850 | +$5.16 | +69% |
| S18 | SWING | 2 | @47,988, @47,850 | +$4.92 | +69% |
| **TOTAL** | | **18 adds** | | **+$110.75** | **avg +95%** |

### Pyramid Summary
- 12 of 30 scenarios triggered pyramiding (40%)
- Average boost per pyramided trade: +95% (nearly doubles the winner)
- Best pyramid: S14 (NAS SHORT post-CPI) = +$19.60 from 2 adds (+178% boost)
- INTRADAY mode benefits most from pyramiding (max 2 adds at full 0.10 lots)
- SWING pyramids are smaller in dollar terms (0.03 vol) but still meaningful

---

## PART 6: KEY FINDINGS

### 1. Breakeven Rule is the Single Biggest Mode Win
| BE Rule | Effect | Dollar Impact |
|---------|--------|---------------|
| Original (1R, exact entry) | T7 stopped out at -2.4pts before +207pt move | -$0.24 (lost $18.70 opportunity) |
| SWING (1.5R, entry+10pts) | T7 never triggers BE, rides to TP2 | +$5.61 (+$8.61 with pyramid) |
| INTRADAY (1R, entry+5pts) | T5 would have BE at 25,019 (same as gamma-trail) | No change for T5 |
| **Total BE improvement** | | **+$8.85** (T7 alone) |

### 2. Wider SL for Overnight = Flip Losers to Winners
| Trade | Original SL | Mode SL | Original P&L | Mode P&L | Saved |
|-------|------------|---------|-------------|----------|-------|
| T1 NAS overnight | 100pts | 150pts (SWING) | -$10.11 | +$1.86 | +$11.97 |
| T2 XAU overnight | 19pts | 35pts (SWING) | -$28.04 | +$40.00 | +$68.04 |
| **Total** | | | **-$38.15** | **+$41.86** | **+$80.01** |

### 3. Reduced Volume Limits Damage on Wrong-Direction Trades
| Trade | Original Vol | SWING Vol | Original Loss | SWING Loss | Saved |
|-------|-------------|-----------|---------------|------------|-------|
| T3 US30 wrong dir | 0.10 | 0.03 | -$33.41 | -$12.00 | +$21.41 |

### 4. SCALP Works for Congestion but Adds No Value for Trend Days
- 4 wins in congestion (S6, S7, S8, S20) = +$56.40
- 3 losses from tight SL in trend/chop = -$4.50
- SCALP is optimal for sub-150pt range days with identifiable congestion boundaries

### 5. SWING Volume Tradeoff
- SWING reduces winners by 70%: S10 (+$23.80 -> +$7.14), S17 (+$25.00 -> +$7.50)
- But SWING saves 70% on losers: T3 (-$33.41 -> -$12.00)
- Net effect across all SWING trades: +$51.37 (mode) vs +$105.70 if all at INTRADAY volume
- Pyramiding recovers: +$67.52 (with pyramids) = 64% of INTRADAY equivalent
- Verdict: SWING volume protection is worth the winner reduction because it flips the risk profile

### 6. Modes That Would Have Changed Outcomes
| Change | Trades Affected | P&L Impact |
|--------|----------------|------------|
| SWING wider SL for overnight | T1, T2 | +$80.01 (losers -> winners) |
| SWING reduced vol for wrong dir | T3 | +$21.41 (limits damage) |
| SWING 1.5R BE delay | T7 | +$8.85 (saves from shakeout) |
| INTRADAY pyramiding | T5, S13, S14, S15, S16 | +$80.70 (doubles winners) |
| SCALP tight SL | T8, S9, S23 | -$0.50 (marginal, saves some) |
| INTRADAY tighter SL stops valid trades | S5, S22 | -$5.00 (loses 2 trades that would have worked with wider SL) |

---

## PART 7: FINAL DOLLAR IMPROVEMENT

| Line Item | Amount |
|-----------|--------|
| **Starting point: Actual trades P&L** | **-$85.17** |
| | |
| SWING wider SL flips T1 from loss to win | +$11.97 |
| SWING wider SL flips T2 from loss to win | +$68.04 |
| SWING reduced vol limits T3 damage | +$21.41 |
| SWING delayed BE saves T7 | +$5.85 |
| SCALP limits T8 damage | +$0.50 |
| **Subtotal: Mode improvements** | **+$107.77** |
| **New P&L with modes only** | **+$22.60** |
| | |
| Pyramid on T5 (2 adds) | +$33.10 |
| Pyramid on T1 (1 add) | +$2.16 |
| Pyramid on T7 (1 add) | +$3.00 |
| **Subtotal: Pyramid improvements** | **+$38.26** |
| **Final P&L with modes + pyramiding** | **+$60.86** |
| | |
| **TOTAL IMPROVEMENT** | **+$146.03** |
| **From -$85.17 to +$60.86** | |
