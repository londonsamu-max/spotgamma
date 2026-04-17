# Setup Tracking Analysis — 1,956 Setups (March 25 - April 10, 2026)

## Dataset Summary

| Metric | Value |
|--------|-------|
| Total setups tracked | 1,956 |
| Resolved (win/loss) | 1,836 |
| Still open | 16 |
| Expired (no fill) | 104 (5.3%) |
| Overall win rate | 58.5% |
| Wins (TP1) | 1,037 |
| Wins (TP3) | 37 |
| Losses (SL) | 762 |
| Avg win | +103.3 pts |
| Avg loss | -108.6 pts |
| Expectancy/trade | +15.3 pts |
| Profit Factor | 1.34 |
| Avg win duration | 187 min |
| Avg loss duration | 157 min |
| Total P&L (pts) | +28,170 |

**NOTE: TP3 hits are rare (37/1074 = 3.4% of wins). 96.6% of wins exit at TP1.** This means the system is effectively a TP1 scalper. TP2/TP3 almost never get reached.

---

## 1. By Trade Type

| Type | N | Win Rate | Avg Win | Avg Loss | Total PnL | Avg R:R |
|------|---|----------|---------|----------|-----------|---------|
| **gamma** | 1,358 | **62.3%** | +86.9 | -112.9 | +15,755 | 1.36 |
| bounce | 229 | 46.7% | +189.1 | -97.9 | +8,292 | 2.79 |
| breakout | 124 | 49.2% | +141.2 | -124.1 | +797 | 2.64 |
| vanna_index | 59 | 42.4% | +193.1 | -112.1 | +1,014 | 3.63 |
| cross_asset | 35 | 51.4% | +137.1 | -62.5 | +1,405 | 2.37 |
| vanna_gold | 19 | 47.4% | +44.1 | -24.4 | +154 | 1.84 |
| refuge | small N | — | — | — | — | — |
| hiro_divergence | small N | — | — | — | — | — |
| im_exhaustion | small N | — | — | — | — | — |
| opex_pin | small N | — | — | — | — | — |

### Actionable Rules — Trade Type

- **RULE T1**: When trade type is `gamma`, win rate is 62.3% (N=1358). ACTION: This is the bread-and-butter. Gamma trades are the highest-volume AND highest-WR type. Prioritize gamma entries at fat bars over all other types.
- **RULE T2**: When trade type is `bounce`, win rate is only 46.7% (N=229) BUT avg win is +189.1 vs avg loss -97.9 = positive expectancy from R:R alone. ACTION: Accept lower WR on bounces because the R:R (2.79:1 avg) compensates. Do NOT filter out bounces for low WR.
- **RULE T3**: When trade type is `vanna_index`, win rate is 42.4% (N=59). ACTION: Vanna index trades are losers overall. Only take them when combined with a high-WR filter (see combo section). Never take vanna_index on US30 (see worst combos).
- **RULE T4**: When trade type is `breakout`, win rate is 49.2% (N=124). ACTION: Breakouts are coin-flips. Only take breakouts in confirmed high-WR combos (XAUUSD LONG breakout = 85% WR).
- **RULE T5**: When trade type is `cross_asset`, avg loss is only -62.5 pts (tightest of all types). ACTION: Cross-asset trades have built-in risk control. Good for capital preservation.

---

## 2. By CFD

| CFD | N | Win Rate | Avg Win | Avg Loss | Total PnL |
|-----|---|----------|---------|----------|-----------|
| **US30** | 491 | **68.4%** | +151.8 | -148.8 | **+27,954** |
| XAUUSD | 427 | 59.0% | +29.2 | -25.1 | +2,978 |
| NAS100 | 918 | 52.9% | +108.1 | -128.1 | -2,762 |

### Actionable Rules — CFD

- **RULE C1**: US30 has the highest win rate (68.4%) AND highest total PnL (+27,954 pts). ACTION: US30 should receive EQUAL or MORE order allocation than NAS100. Never neglect US30.
- **RULE C2**: NAS100 is the ONLY CFD with NEGATIVE total PnL (-2,762 pts) despite 918 trades. ACTION: Apply stricter filters on NAS100 entries. NAS100 requires more confirmations or better regime alignment.
- **RULE C3**: XAUUSD has tight avg win/loss (+29.2/-25.1) and positive total PnL. ACTION: XAUUSD is steady but small. Good for diversification. Per-point value ($1/pt) means the +2,978 pts = ~$2,978 real value.

---

## 3. By Direction per CFD

| CFD + Direction | N | Win Rate | Avg Win | Avg Loss | Total PnL |
|-----------------|---|----------|---------|----------|-----------|
| **US30 SHORT** | 369 | **73.4%** | +145.1 | -180.0 | **+21,676** |
| XAUUSD LONG | 216 | 65.7% | +37.8 | -25.6 | +3,475 |
| NAS100 LONG | 455 | 62.6% | +109.3 | -149.4 | +5,751 |
| US30 LONG | 122 | 53.3% | +180.1 | -95.2 | +6,278 |
| XAUUSD SHORT | 211 | 52.1% | +18.1 | -24.7 | -497 |
| **NAS100 SHORT** | 463 | **43.4%** | +106.5 | -114.2 | **-8,514** |

### Actionable Rules — Direction

- **RULE D1**: US30 SHORT has 73.4% win rate (N=369). ACTION: US30 SHORT is the single best directional trade. Always have US30 SHORT orders ready at resistance/accelerator bars.
- **RULE D2**: NAS100 SHORT has only 43.4% WR and -8,514 total PnL (N=463). ACTION: NAS100 SHORT is the BIGGEST LOSER in the entire dataset. Apply extreme caution: only take NAS100 SHORT when regime is positive (see combo section) or with 5+ confirmations.
- **RULE D3**: XAUUSD LONG has 65.7% WR (N=216) vs XAUUSD SHORT at 52.1%. ACTION: XAUUSD has a clear LONG bias. Favor LONG setups in gold. SHORT gold only with strong bearish HIRO + institutional flow.
- **RULE D4**: US30 LONG has 53.3% WR but avg win is +180.1 (highest of any direction). ACTION: US30 LONG wins are BIG. Even at lower WR, the R:R makes it profitable (+6,278 total).

---

## 4. By Gamma Regime

| Regime | N | Win Rate | Avg Win | Avg Loss | Total PnL |
|--------|---|----------|---------|----------|-----------|
| **positive** | 690 | **69.6%** | +91.4 | -85.7 | **+25,877** |
| very_negative | 1,096 | 52.5% | +110.5 | -114.6 | +3,846 |
| negative | 42 | 40.5% | +180.5 | -171.4 | -1,215 |
| unknown | 8 | 25.0% | +219.5 | -129.5 | -338 |

### Actionable Rules — Regime

- **RULE R1**: Positive gamma regime has 69.6% WR (N=690) and +25,877 total PnL. ACTION: Positive gamma is the BEST regime to trade. When SPX is in positive gamma, be AGGRESSIVE with order count.
- **RULE R2**: Very negative gamma has only 52.5% WR (N=1096). ACTION: In very negative gamma, apply tighter entry criteria. The win rate barely beats a coin flip.
- **RULE R3**: Negative gamma (non-very) has 40.5% WR (N=42). ACTION: Pure negative gamma (not very_negative) is DANGEROUS. Reduce position sizing or skip.
- **RULE R4**: Unknown regime has 25% WR (N=8). ACTION: NEVER trade without knowing the regime. If regime data is unavailable, do NOT enter.

---

## 5. By IV Rank

| IV Bucket | N | Win Rate | Avg Win | Avg Loss | Total PnL |
|-----------|---|----------|---------|----------|-----------|
| mid (26-50) | 1,617 | **59.6%** | +101.6 | -115.2 | +22,704 |
| very high (76-100) | 154 | 51.3% | +57.6 | -32.3 | +2,130 |
| high (51-75) | 57 | 50.9% | +276.8 | -155.5 | +3,674 |
| low (0-25) | 8 | 25.0% | +219.5 | -129.5 | -338 |

### Actionable Rules — IV

- **RULE IV1**: Mid IV (26-50) dominates the dataset and has the best WR at 59.6%. ACTION: Mid IV is the normal operating range. No special filter needed.
- **RULE IV2**: Very high IV (76-100) has tight avg loss (-32.3 pts). ACTION: In high IV, stops are tighter. This is XAUUSD-dominated. The tighter stops are good for risk management.
- **RULE IV3**: Low IV (<25) has 25% WR (N=8). ACTION: When IV rank is very low, setups fail. Avoid trading in ultra-low IV environments.

---

## 6. By Confirmation Count

| Confirmations | N | Win Rate | Avg Win | Avg Loss | Total PnL |
|---------------|---|----------|---------|----------|-----------|
| **5** | 405 | **75.8%** | +108.8 | -133.0 | **+20,355** |
| 6 | 1,057 | 55.6% | +86.0 | -107.1 | +369 |
| 2 | 45 | 57.8% | +198.7 | -78.6 | +3,673 |
| 1 | 12 | 58.3% | +101.4 | -130.0 | +60 |
| 4 | 160 | 46.3% | +127.7 | -90.6 | +1,657 |
| 3 | 154 | 45.5% | +162.9 | -114.2 | +1,817 |

### Actionable Rules — Confirmations

- **RULE CF1**: 5 confirmations has 75.8% WR (N=405) — the SWEET SPOT. ACTION: 5 confirmations is optimal. This is the magic number. Prioritize setups with exactly 5 confirmations.
- **RULE CF2**: 6 confirmations drops to 55.6% WR (N=1057). ACTION: More confirmations is NOT better. 6 confirmations likely includes contradictory signals that create noise. Do not assume "all green = good."
- **RULE CF3**: 3-4 confirmations have ~46% WR. ACTION: 3-4 confirmations is a danger zone. Not enough alignment. Either get to 5 or drop below 3 (where small sample shows OK WR but too few trades to trust).

**KEY INSIGHT: The relationship is NOT linear.** 5 is the peak. This suggests that when ALL 6 factors align, the setup is often in a "too obvious" state where the move has already happened. The 5-confirmation setups likely have one factor diverging, creating a genuine edge.

---

## 7. By Individual Confirmation Factor

| Factor | With | WR With | PnL With | Without | WR Without | PnL Without |
|--------|------|---------|----------|---------|------------|-------------|
| **hiro** | 1,486 | **61.4%** | +21,427 | 350 | 46.3% | +6,743 |
| vanna | 1,542 | 60.2% | +19,624 | 294 | 49.3% | +8,546 |
| level | 1,789 | 58.7% | +27,760 | 47 | 51.1% | +410 |
| regime | 1,734 | 58.9% | +25,274 | 102 | 52.0% | +2,896 |
| gex | 1,774 | 58.5% | +23,318 | 62 | 58.1% | +4,852 |
| tape | 1,246 | 54.4% | +6,068 | 590 | **67.1%** | +22,102 |

### Actionable Rules — Confirmations

- **RULE F1**: HIRO confirmation adds +15.1% WR (61.4% vs 46.3%). ACTION: HIRO is the MOST valuable single confirmation factor. NEVER enter without HIRO alignment.
- **RULE F2**: Tape confirmation REDUCES win rate (54.4% with tape vs 67.1% without). ACTION: Tape is actually a NEGATIVE signal. When tape agrees, it may indicate retail crowding. Consider tape as a CONTRARIAN indicator or reduce its weight.
- **RULE F3**: Vanna confirmation adds +10.9% WR. ACTION: Vanna is the second most valuable factor. Check vanna alignment before every entry.

---

## 8. By Session Time

| Session | N | Win Rate | Avg Win | Avg Loss | Total PnL |
|---------|---|----------|---------|----------|-----------|
| after_hours | 91 | **62.6%** | +111.7 | -111.1 | +2,587 |
| overnight | 701 | 59.2% | +108.7 | -102.4 | +15,849 |
| market_hours | 947 | 59.1% | +99.9 | -100.9 | +16,911 |
| **pre_market** | 97 | **43.3%** | +83.0 | **-193.9** | **-7,177** |

### Actionable Rules — Session

- **RULE S1**: Pre-market has 43.3% WR AND the worst avg loss (-193.9 pts). ACTION: Pre-market setups are DANGEROUS. The avg loss is nearly DOUBLE market hours. Either skip pre-market or use much wider SLs. The problem is likely that gamma bars shift at open, invalidating pre-market entries.
- **RULE S2**: Overnight has 59.2% WR and +15,849 total PnL (N=701). ACTION: Overnight trading IS profitable with the fat-bar rule (L76). Continue allowing overnight entries.
- **RULE S3**: After-hours has the highest WR at 62.6% (N=91). ACTION: After-hours has genuine edge — likely because institutional positioning from the close holds. Valid trading window.

---

## 9. By Entry Mode

| Mode | N | Win Rate | Avg Win | Avg Loss | Total PnL |
|------|---|----------|---------|----------|-----------|
| **ENTRADA** | 1,371 | **61.6%** | +87.4 | -111.5 | +15,009 |
| NO_OPERAR | 195 | 51.3% | +170.6 | -107.8 | +6,823 |
| VIGILANCIA | 270 | 48.1% | +154.8 | -98.5 | +6,338 |

### Actionable Rules — Entry Mode

- **RULE E1**: ENTRADA (direct entry) has 61.6% WR. ACTION: When the system says ENTRADA, trust it. This is the highest WR entry mode.
- **RULE E2**: NO_OPERAR setups still win 51.3% with avg win +170.6. ACTION: "No trade" signals that get entered anyway are profitable due to large wins. The system may be too conservative in labeling NO_OPERAR.

---

## 10. By Score Bucket

| Score | N | Win Rate | Avg Win | Avg Loss | Total PnL |
|-------|---|----------|---------|----------|-----------|
| **25-50** | 862 | **64.4%** | +99.8 | -116.3 | **+19,678** |
| 51-75 | 760 | 54.7% | +93.9 | -107.6 | +2,035 |
| 76-90 | 120 | 52.5% | +144.0 | -90.9 | +3,892 |
| 91-100 | 94 | 42.6% | +186.3 | -90.5 | +2,566 |

### Actionable Rules — Score

- **RULE SC1**: Low score (25-50) has the HIGHEST win rate at 64.4% (N=862). ACTION: Counter-intuitive but confirmed — low-score setups win more often. The scoring system may be INVERTED or the "obvious" high-score setups attract crowding.
- **RULE SC2**: High score (91-100) has the LOWEST win rate at 42.6%. ACTION: Do NOT prioritize high-score setups. They appear to be "too perfect" setups where the move is already priced in.

**KEY INSIGHT**: The score is anti-correlated with win rate. This demands a review of the scoring algorithm. The factors that increase score may be backward-looking (confirming a move that already happened) rather than forward-looking.

---

## 11. By Risk:Reward Ratio

| R:R | N | Win Rate | Avg Win | Avg Loss | Total PnL |
|-----|---|----------|---------|----------|-----------|
| 1.5-2.0 | 370 | **61.9%** | +90.7 | -73.4 | **+10,430** |
| <1.5 | 1,189 | 60.9% | +93.2 | -123.6 | +10,013 |
| 2.0-3.0 | 109 | 47.7% | +183.9 | -112.8 | +3,133 |
| 3.0+ | 168 | 41.1% | +189.9 | -85.9 | +4,595 |

### Actionable Rules — R:R

- **RULE RR1**: R:R 1.5-2.0 is the sweet spot: 61.9% WR with tight losses (-73.4 avg). ACTION: Target 1.5-2.0 R:R. This range has the best expectancy per trade (+28.2 pts avg).
- **RULE RR2**: R:R 3.0+ has only 41.1% WR. ACTION: Very high R:R setups fail more often — the TP is too far. Reduce TP ambition. Use TP1 at next gamma bar (which naturally gives 1.5-2.0 R:R).
- **RULE RR3**: R:R <1.5 still works at 60.9% WR but avg loss is -123.6. ACTION: Sub-1.5 R:R is acceptable IF win rate is high (gamma type in positive regime). But the larger avg loss means drawdowns are deeper.

---

## 12. By Duration

| Duration | N | Win Rate | Avg PnL |
|----------|---|----------|---------|
| <30 min | 327 | 59.0% | +11.0 |
| 30-120 min | 737 | 56.3% | -3.5 |
| 2-6 hours | 540 | 57.0% | +15.1 |
| **6-24 hours** | 232 | **68.1%** | **+81.6** |

### Actionable Rules — Duration

- **RULE DU1**: Trades lasting 6-24 hours have 68.1% WR and +81.6 avg PnL. ACTION: Let winning trades RUN. Do not exit prematurely. The longer-duration trades are the most profitable.
- **RULE DU2**: Trades lasting 30-120 min have -3.5 avg PnL. ACTION: This is the "chop zone." Price oscillates around entry. Consider wider entry tolerance or patience.

---

## 13. Regime + Direction Cross-Reference

| Regime + Direction | N | Win Rate | Total PnL | Avg PnL |
|--------------------|---|----------|-----------|---------|
| **positive + SHORT** | 493 | **71.6%** | **+21,974** | +44.6 |
| positive + LONG | 197 | 64.5% | +3,902 | +19.8 |
| very_negative + LONG | 564 | 61.7% | +11,503 | +20.4 |
| very_negative + SHORT | 532 | 42.7% | -7,656 | -14.4 |
| negative + LONG | 29 | 51.7% | -291 | -10.0 |
| **negative + SHORT** | 13 | **15.4%** | **-924** | -71.1 |

### Actionable Rules — Regime + Direction

- **RULE RD1**: Positive gamma + SHORT = 71.6% WR (N=493). ACTION: In positive gamma, dealers absorb buying = price gets pinned. SHORT entries at resistance/call walls are the highest-probability trade in the dataset.
- **RULE RD2**: Very negative + SHORT = 42.7% WR, -7,656 total PnL. ACTION: In very negative gamma, do NOT short. The market is already falling — shorting into accelerating declines catches reversals. Go LONG instead (61.7% WR).
- **RULE RD3**: Negative + SHORT = 15.4% WR (N=13). ACTION: ABSOLUTE WORST combo. NEVER short in pure negative gamma. Dealers amplify upward moves in negative gamma when a squeeze triggers.

---

## TOP 10 BEST Combinations (by win rate, N >= 8)

| Rank | Combination | WR | N | Avg PnL | Total PnL |
|------|-------------|-----|---|---------|-----------|
| 1 | **gamma + US30 + LONG + positive** | **95.7%** | 23 | +118.7 | +2,729 |
| 2 | **gamma + US30 + LONG** | **93.5%** | 31 | +115.3 | +3,573 |
| 3 | vanna_index + NAS100 + SHORT + very_neg | 90.9% | 11 | +201.0 | +2,211 |
| 4 | breakout + XAUUSD + LONG | 85.0% | 20 | +45.5 | +910 |
| 5 | breakout + XAUUSD + LONG + very_neg | 85.0% | 20 | +45.5 | +910 |
| 6 | **gamma + US30 + positive** | **82.3%** | 328 | +73.8 | +24,208 |
| 7 | gamma + US30 + SHORT + positive | 81.3% | 305 | +70.4 | +21,479 |
| 8 | gamma + US30 | 81.2% | 341 | +71.4 | +24,337 |
| 9 | US30 + SHORT + positive | 80.5% | 318 | +69.8 | +22,191 |
| 10 | gamma + US30 + SHORT | 80.0% | 310 | +67.0 | +20,764 |

### Actionable Rules — Best Combos

- **RULE BEST1**: gamma + US30 + LONG + positive regime = 95.7% WR (N=23). ACTION: This is the HOLY GRAIL setup. When positive gamma AND DIA gamma bars show a LONG entry on US30, take it with maximum confidence.
- **RULE BEST2**: gamma + US30 in ANY direction + positive regime = 82.3% WR (N=328). ACTION: US30 gamma trades in positive regime are ALMOST ALWAYS winners. Prioritize these above ALL other setups.
- **RULE BEST3**: breakout + XAUUSD + LONG = 85% WR (N=20). ACTION: Gold breakouts to the upside are extremely reliable. When GLD breaks through a gamma bar upward, take the LONG.
- **RULE BEST4**: US30 + SHORT + positive regime = 80.5% WR (N=318). ACTION: High-volume, high-WR. The backbone of profitability. Always have US30 SHORT orders at DIA resistance bars during positive gamma.

---

## TOP 10 WORST Combinations (AVOID)

| Rank | Combination | WR | N | Avg PnL | Total PnL |
|------|-------------|-----|---|---------|-----------|
| 1 | **bounce + NAS100 + SHORT + negative** | **10.0%** | 10 | -73.3 | -733 |
| 2 | NAS100 + SHORT + negative | 15.4% | 13 | -71.1 | -924 |
| 3 | negative + SHORT | 15.4% | 13 | -71.1 | -924 |
| 4 | vanna_index + conf 3-4 | 16.7% | 18 | -43.1 | -777 |
| 5 | vanna_index + score mid | 17.6% | 17 | -54.4 | -925 |
| 6 | vanna_index + US30 + SHORT + very_neg | 20.0% | 10 | -49.8 | -498 |
| 7 | bounce + US30 + LONG + positive | 25.0% | 8 | -18.4 | -148 |
| 8 | vanna_index + US30 + very_neg | 29.2% | 24 | -20.2 | -484 |
| 9 | breakout + US30 + SHORT | 30.0% | 10 | -3.9 | -39 |
| 10 | US30 + SHORT + very_negative | 30.0% | 50 | -7.7 | -384 |

### Actionable Rules — Worst Combos

- **RULE WORST1**: bounce + NAS100 + SHORT + negative gamma = 10% WR. ACTION: NEVER short NAS100 on a bounce setup in negative gamma. This is the worst trade in the dataset.
- **RULE WORST2**: ANY SHORT in negative gamma = 15.4% WR. ACTION: HARD BLOCK on shorts in negative gamma regime. No exceptions.
- **RULE WORST3**: vanna_index trades with 3-4 confirmations = 16.7% WR. ACTION: Vanna trades need either very few (pure signal) or very many (5+) confirmations. The 3-4 range is the worst.
- **RULE WORST4**: vanna_index + US30 = 31.4% WR (N=35). ACTION: NEVER trade vanna signals on US30. Vanna is for NAS100 and XAUUSD only.
- **RULE WORST5**: US30 + SHORT + very_negative = 30.0% WR (N=50). ACTION: US30 SHORT only works in POSITIVE gamma. In very_negative gamma, US30 shorts are losers.
- **RULE WORST6**: gamma + NAS100 + SHORT + very_negative = 40.6% WR (N=377), -14,106 total PnL. ACTION: This is the BIGGEST P&L DESTROYER. 377 trades losing -14,106 pts total. NAS100 SHORT in very negative gamma is where most money is lost.

---

## BIGGEST P&L DESTROYERS (by total PnL)

| Rank | Combination | Total PnL | N | WR | Avg PnL |
|------|-------------|-----------|---|-----|---------|
| 1 | **gamma + NAS100 + SHORT + very_neg** | **-14,106** | 377 | 40.6% | -37.4 |
| 2 | gamma + NAS100 + very_neg | -9,399 | 734 | 53.4% | -12.8 |
| 3 | NAS100 + SHORT + conf 5+ | -8,691 | 415 | 43.9% | -20.9 |
| 4 | very_negative + SHORT | -7,656 | 532 | 42.7% | -14.4 |
| 5 | NAS100 + SHORT + very_neg | -6,992 | 446 | 44.6% | -15.7 |

**KEY INSIGHT**: NAS100 SHORT in very_negative gamma is responsible for the MAJORITY of all losses in the system. Fixing this single filter would turn the system from +28K total PnL to +42K.

---

## 14. Skew Bias

| Skew | N | Win Rate | Total PnL |
|------|---|----------|-----------|
| **neutral** | 74 | **75.7%** | +1,689 |
| put_skew | 1,762 | 57.8% | +26,481 |

### Actionable Rules — Skew

- **RULE SK1**: Neutral skew has 75.7% WR (N=74). ACTION: When skew is neutral (not put-heavy), setups are significantly more reliable. Neutral skew means balanced options positioning = cleaner price action at gamma bars.

---

## 15. Alt vs Primary Setups

| Type | N | Win Rate | Avg Win | Total PnL |
|------|---|----------|---------|-----------|
| Primary (isAlt=false) | 1,667 | **59.3%** | +94.7 | +19,873 |
| Alt (isAlt=true) | 169 | 50.9% | +202.4 | +8,297 |

### Actionable Rules — Alt

- **RULE ALT1**: Primary setups have higher WR (59.3% vs 50.9%). ACTION: Prioritize primary setups. Alt setups are valid but less reliable.
- **RULE ALT2**: Alt wins are BIGGER (+202.4 vs +94.7 avg). ACTION: Alt setups catch larger moves when they work. They are contrarian plays with higher reward.

---

## 16. Daily Performance

| Date | N | Win Rate | Total PnL |
|------|---|----------|-----------|
| 2026-04-10 | 51 | **84.3%** | +468 |
| 2026-04-07 | 497 | 64.4% | +11,743 |
| 2026-04-08 | 289 | 63.0% | -2,074 |
| 2026-03-26 | 116 | 60.3% | +7,295 |
| 2026-03-31 | 56 | 60.7% | +5,206 |
| 2026-04-06 | 456 | 59.9% | +6,303 |
| 2026-03-25 | 8 | 50.0% | +195 |
| 2026-04-01 | 45 | 42.2% | +889 |
| 2026-03-27 | 167 | 41.9% | +770 |
| 2026-03-30 | 50 | 40.0% | -301 |
| 2026-04-02 | 56 | 39.3% | -791 |
| 2026-04-05 | 43 | 37.2% | -1,532 |

**NOTE**: April 8 had 63% WR but NEGATIVE PnL (-2,074). This means losses were much larger than wins that day — likely a few big SL hits wiping out many small wins.

---

## 17. Playbook Cross-Reference

| Regime | Setup Tracking WR | Playbook SPX WR | Match? |
|--------|-------------------|-----------------|--------|
| Positive gamma | 69.6% | 56.2% | DIVERGENT: Setup tracking significantly outperforms playbook |
| Negative gamma | 52.0% | 66.7% | DIVERGENT: Setup tracking significantly underperforms playbook |

### Analysis

The playbook (2,823 days of SPX data) shows negative gamma with 66.7% win rate (for SPX daily returns), but setup tracking shows only 52.0% WR for trades in negative gamma. This divergence likely occurs because:

1. **Playbook measures daily direction, not trade entries.** A 66.7% up-day rate in negative gamma does NOT mean trades entered at gamma bars win 66.7% of the time.
2. **The agent's SHORT bias in negative gamma destroys results.** The agent shorts aggressively in negative gamma (532 shorts at 42.7% WR), but the playbook shows most negative gamma days are UP days (66.7%).
3. **Positive gamma outperformance** (69.6% vs 56.2%) suggests the agent's gamma bar precision adds edge in stable regimes but struggles in volatile ones.

**ACTION**: The playbook's negative gamma = bullish signal should be used MORE. When in negative gamma, the agent should favor LONG entries (61.7% WR in very_negative) and AVOID shorts (42.7% WR). The playbook confirms this with 66.7% up-day probability.

---

## 18. Missing Data Factors

The following LIVE data factors are NOT captured in setup-tracking.json and could significantly improve analysis:

| Missing Factor | Why It Matters | How to Complement |
|----------------|---------------|-------------------|
| **Real-time HIRO values** (percentile) | HIRO is the #1 confirmation factor (+15.1% WR boost). Knowing exact HIRO percentile at entry would reveal optimal HIRO thresholds. | Add `hiroPercentile` per symbol at tracking time |
| **Tape score at entry** | Tape is counter-intuitively negative. Knowing the actual score (-100 to +100) would clarify whether extreme tape (>80) is the problem. | Add `tapeScore` per symbol at tracking time |
| **Institutional flow direction** | Flow analysis (L52) is the edge. Concentrated premium data at entry would validate flow-based entries. | Add `netDelta` and `topInstitutionalTrade` at tracking time |
| **VRP at entry** | VRP overrides regime (L1, L16). Not having VRP in tracking means the agent cannot quantify its impact. | Add `vrp` (iv30 - rv30) at tracking time |
| **Gamma bar magnitude** | A +500M bar is different from a +3,000M bar. Bar size likely correlates with hold strength. | Add `gammaSize` (raw gamma) at tracking time |
| **Price distance from bar** | Entry precision matters. Was price exactly at the bar or 20pts away? | Add `distFromBar` in points at tracking time |
| **Market session explicitly** | Current session is inferred from timestamp. Explicit session (pre/open/post/overnight) would be more reliable. | Add `marketSession` at tracking time |
| **Day of week** | Some days may have consistent patterns (e.g., Monday reversals, Friday pins). | Add `dayOfWeek` at tracking time |
| **Macro event proximity** | Setups near CPI/FOMC/NFP may behave differently. | Add `nearMacroEvent` boolean + name at tracking time |

---

## EXECUTIVE SUMMARY — Top 10 Rules for the Agent

1. **US30 is king.** 68.4% WR, +27,954 pts. Always have US30 orders. Never neglect it.
2. **NAS100 SHORT in very_negative gamma is the #1 money destroyer.** -14,106 pts from 377 trades. BLOCK this combo or require extreme confirmation.
3. **Positive gamma + SHORT = 71.6% WR.** The best regime-direction combo. Be aggressive.
4. **5 confirmations is the sweet spot (75.8% WR).** Not 6, not 4. Exactly 5.
5. **HIRO is the most valuable confirmation (+15.1% WR).** Never enter without HIRO.
6. **Tape is NEGATIVELY correlated with wins.** When tape agrees, win rate drops. Use tape as contrarian signal.
7. **Pre-market is a trap.** 43.3% WR, -193.9 avg loss. Either skip or use much wider SLs.
8. **Score is anti-correlated with WR.** Low scores (25-50) win at 64.4%. High scores (91-100) win at 42.6%. The scoring system needs inversion.
9. **R:R 1.5-2.0 is optimal.** High R:R (3+) trades fail more (41.1% WR). Use TP1 at next gamma bar.
10. **In negative/very_negative gamma, go LONG not SHORT.** Very_neg LONG = 61.7% WR. Very_neg SHORT = 42.7% WR. The playbook confirms: 66.7% of negative gamma days are UP.

---

## FILTER RULES FOR agent-orders.json

Based on this analysis, the agent should apply these filters before placing orders:

```
BLOCK (do not place order):
- NAS100 + SHORT + very_negative regime  (WR=40.6%, -14,106 PnL)
- ANY SHORT + negative regime            (WR=15.4%)
- vanna_index + US30                     (WR=31.4%)
- pre_market entries without wide SL     (WR=43.3%, avgLoss=-193.9)
- unknown regime                         (WR=25.0%)

REDUCE SIZE (half volume):
- NAS100 + SHORT (any regime)            (WR=43.4%, -8,514 PnL)
- vanna_index + conf 3-4                 (WR=16.7%)
- R:R > 3.0                             (WR=41.1%)
- Score > 90                            (WR=42.6%)

FULL SIZE + HIGH PRIORITY:
- gamma + US30 + positive regime         (WR=82.3%, +24,208 PnL)
- US30 + SHORT + positive regime         (WR=80.5%, +22,191 PnL)
- breakout + XAUUSD + LONG              (WR=85.0%)
- 5 confirmations                        (WR=75.8%)
- XAUUSD + LONG + very_negative         (WR=72.9%)

ALWAYS HAVE READY:
- US30 orders (both directions in positive gamma)
- XAUUSD LONG orders
- NAS100 LONG orders (not SHORT unless positive gamma)
```
