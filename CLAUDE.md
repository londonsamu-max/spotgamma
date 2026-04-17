# SpotGamma Monitor — Architecture & Context

## What This Project Is
An autonomous CFD trading system (NAS100, US30, XAUUSD) that uses SpotGamma options structure data to make trading decisions on MT5 (Pepperstone broker).

## Architecture

```
Claude Code (cron every 5 min, adaptive) — THE BRAIN
  → Reads all SpotGamma data via getAgentView endpoint (25 categories, 708 data points)
  → Reads memory (agent-state.json)
  → Analyzes: gamma regime, HIRO, tape, vanna, vol, 0DTE, flow, topStrikes, skew, candles, macro
  → Writes orders to agent-orders.json (LONG + SHORT scenarios per CFD)
  → Updates memory with thesis, watchlist, lessons
  → Validates/cancels/adjusts existing orders AND open positions every cycle

Fast Executor (server, every 500ms) — THE MUSCLE
  → Reads agent-orders.json
  → Monitors CFD prices (Broker bid/ask + TradingView fallback)
  → Executes instantly when price enters entry zone
  → Auto: breakeven at 1R, gamma-based trailing SL (level to level)

Server (PM2, port 3099) — THE INFRASTRUCTURE
  → Scrapes SpotGamma every 15s (levels, GEX, HIRO, tape, vanna, vol, 0DTE, flow)
  → Serves getAgentView endpoint (compact 21K chars, 25 keys, levels converted to CFD prices)
  → MT5 file bridge (sg_order.json / sg_result.json / sg_status.json)
  → Broker prices: live bid/ask/spread from Pepperstone EA
  → DXY/TLT real macro feeds from Yahoo Finance
  → Market live detection by price movement (not just timezone)
  → Macro calendar with countdown + awareness levels
  → Multi-timeframe store (4h snapshots every 15 min)
  → Tracks trades in trade-history.json
```

## How Claude Agent Works

Claude Code runs as a cron job (every 5 min, adaptive frequency). Each cycle:
1. Reads `data/agent-state.json` (memory from last cycle)
2. Fetches `localhost:3099/api/trpc/market.getAgentView` (all market data)
3. Checks price delta vs last cycle: <15pts=FLAT (brief log), 15-30=MEDIUM, >30=FULL analysis
4. Analyzes ALL 25 data categories in FULL mode
5. Identifies scenarios for BOTH directions (LONG + SHORT) on ALL 3 CFDs
6. Writes multiple pending orders to `data/agent-orders.json`
7. Validates existing orders — cancels if data no longer supports them
8. Validates open positions — closes if data invalidates the thesis
9. Updates `data/agent-state.json` with current thesis
10. Logs to `data/claude-decisions.jsonl`

**IMPORTANT:** Claude does NOT use the Anthropic API. It IS Claude Code running in a terminal. No API key needed. The brain is the Claude Code session itself.

## Trading Philosophy (defined by user)

### Core Principles
1. **Data manda** — Don't predict, react to what live data shows
2. **Multiple scenarios always** — LONG and SHORT orders for every CFD, at multiple levels
3. **Enter at structure** — Trade mode (SCALP/INTRADAY/SWING) guides risk management, but position can be upgraded if data supports it (e.g., SCALP→INTRADAY if HIRO strengthens)
4. **No artificial limits** — No kill switch, no max trades, no max positions, no min conviction
5. **Unlimited positions per asset** — Can have 3 LONGs in NAS at different levels
6. **Dynamic everything** — Orders and positions live and die with the data
7. **Positions = continuous analysis** — If data invalidates, close immediately, don't wait for SL
8. **Account is demo** — Trade without fear. Every trade (win or loss) is data to improve
9. **Macro events are catalysts, not threats** — Check flow data, don't just close positions

### Entry Logic
- **Entry** at gamma level (support/resistance) with structural edge
- **SL** behind the gamma level (where thesis invalidates)
- **TP1** next gamma level (first target)
- **TP2/TP3** further gamma levels or trailing
- Market decides if it's a scalp (5 min to TP1) or swing (days to TP3)

### Trailing SL (Gamma-Based)
- After breakeven (per trade mode: SCALP 0.5R, INTRADAY 1R, SWING 1.5R): SL moves to entry + 5pts NAS/US30, +2pts XAU (L106)
- Then SL jumps from gamma level to gamma level as price passes them
- Buffer: 15pts NAS/US30, 5pts XAUUSD below/above the level
- No partial closes — full position rides with trailing
- No fixed distance — structure-based only

### Position Sizing
- NAS100: 0.10 lots minimum (broker min), $0.10/point
- US30: 0.10 lots minimum (broker min), $0.10/point
- XAUUSD: 0.01 lots minimum (broker min), $1.00/point
- SL goes where structure says. If resulting risk >5% account, skip trade (don't shrink SL)

## Key Files

### Agent Files (in data/)
- `agent-state.json` — Claude's persistent memory (thesis, 98 lessons, performance, gammaBarsSnapshot, keyInstitutionalFlow, lastRatios, todayStats, preIdentifiedSetups, tradingRules, broker_specs, known_risks)
- `agent-orders.json` — Pending orders + managed positions for the fast executor
- `agent-playbook.json` — Historical statistics from 2,800 days of real data
- `agent-entry-models.json` — 7 standardized entry models from trading books
- `claude-decisions.jsonl` — Append-only log of every decision (130+ cycles logged)
- `daily-context.jsonl` — Daily 108-feature snapshots for future retraining
- `market-snapshots-rolling.json` — Multi-timeframe 4h rolling snapshots

### Server Endpoints
- `market.getAgentView` — Compact market data (21K chars, 25 keys, levels in CFD prices)
- `market.getData` — Full raw SpotGamma data (for dashboard)
- `market.getLivePrices` — TradingView CFD prices
- `market.getStatus` — Market status + marketLive detection by price movement
- `market.getMT5Status` — MT5 connection + account + broker bid/ask prices
- `market.executeClaudeTrade` — Execute trade with custom SL/TP/volume
- `market.getMultiTimeframe` — 4h rolling snapshots with HIRO/GEX/tape trends
- `market.getExecutorState` — Fast executor pending orders + managed positions
- `market.getLivePnL` — Real-time P&L for open positions
- `market.getPnLAnalytics` — Advanced analytics (when implemented)

### Config
- `data/auto-trading-config.json` — enabled, volumes, NO kill switch, NO limits
- `ecosystem.config.js` — PM2 config (runs dist/index.js on port 3099)

### Dashboard
- Desktop: `http://localhost:3099` or `http://192.168.1.50:3099`
- Mobile PWA: `http://192.168.1.50:3099/mobile`
- Refactored from 3226 lines to 648 lines (25 components)
- New panels: ExecutorPanel, LivePnLPanel, SetupVisualizerPanel
- Tab: Tendencia 4H (multi-timeframe charts)

## Data Sources & Improvements
- SpotGamma API (JWT authenticated) — levels, GEX, HIRO, tape, vanna, vol, 0DTE, flow
- TradingView WebSocket — CFD prices (NAS100, US30, XAUUSD)
- MT5 EA (SpotGammaBridge v2) — Broker bid/ask prices, account status, trade execution
- Tradier API — Per-ETF GEX (DIA, GLD)
- Yahoo Finance — DXY ($100.03) + TLT ($86.79) real macro feeds
- Macro Calendar — Countdown to events with awareness levels (PREPARE, CHECK_FLOW, TIGHTEN_SL, HAPPENING_NOW)
- 15-min Candle Signals — Pattern detection (hammer, engulfing, doji) from price memory
- Market Live Detection — Detects open market by price movement, not just timezone

## MANDATORY CHECKLIST — NEVER SKIP (FULL mode)
Every FULL cycle MUST check ALL 14 items in order. No exceptions.
**If you skip ANY item, the cycle is INVALID. Start over.**

### 1. REGIME CHECK
- SPX, QQQ, GLD, DIA gamma regime + VRP (iv30-rv30) for each

### 2. HIRO (ALL 8 symbols)
- SPX, QQQ, SPY, GLD, DIA, VIX, UVIX, IWM — trend + percentile
- Consensus: how many bearish vs bullish?

### 3. TAPE (ALL 7 symbols)
- SPX, QQQ, SPY, GLD, DIA, VIX, UVIX — sentiment score
- Contradictions with HIRO? (e.g., HIRO bearish but tape bullish = institutional vs retail)
- Remember: HIRO = institutional flow (trust for direction). Tape can be retail noise (L51).

### 4. LEVELS (ALL symbols)
- SPX, QQQ, GLD, DIA: callWall, putWall, gammaFlip, keyGamma, maxGamma
- QQQ topStrikes with net positioning (critical for NAS100!)
- Convert to CFD prices

### 5. ⭐ GAMMA BARS — MULTI-SYMBOL (THE MOST IMPORTANT ITEM)
**This is how the user finds entries. NEVER skip this.**
- Read `gammaBars` from getAgentView for each CFD
- For NAS100: bars come from SPX + QQQ + SPY combined (top 20 by |gamma|)
- For US30: bars from DIA
- For XAUUSD: bars from GLD
- **Identify the FATTEST bars** near current price — those are the real support/resistance
- Map the gamma landscape: where are the green walls (support)? Where are the red accelerators?
- **SPY and QQQ add HIDDEN accelerators not visible in SPX alone** (L44, L45)
- Example: SPX shows support at $23,961 (+1,038M) but SPY has -692M (-164K net) at $23,864 right below = the support is WEAKER than it looks
- ALL entries MUST be at a fat gamma bar. No entries at random levels.
- R:R minimum 1:1.5 (L48). SL behind the next structural gamma bar + buffer.
- **Save the gamma bar map** to `agent-state.json → gammaBarsSnapshot` every cycle (strike, gamma, type, cfdPrice, distFromPrice). This survives session restarts.

### 5.1 ⭐ DOMINANCE FLIP ANALYSIS (per strike) — **MANDATORY sub-check** (L113)
**Each strike has two sides of dealer gamma. The MIX tells you WHICH mechanic drives the level, and the EVOLUTION tells you when the mechanic is changing.** Classic `type: support/resistance` only looks at gamma SIGN — this refinement looks at WHO owns the gamma and WHAT will happen at the level.

- **Compute:** `callDominance = |callGamma| / (|callGamma| + |putGamma|)` per bar. Range 0-1.
- **Categories (buckets):**
  - `call_strong` (dom ≥ 0.80): call-driven strike
  - `call_mod` (0.60-0.80): call-biased
  - `flip_zone` (0.40-0.60): **LEADING INDICATOR** — strike transitioning
  - `put_mod` (0.20-0.40): put-biased
  - `put_strong` (dom < 0.20): put-driven strike
- **Dealer interpretation (combining dominance + sign of callGamma/putGamma):**
  - CALL-dom + callGamma>0 = `dealer_long_calls_support` (support by hedging demand in calls)
  - CALL-dom + callGamma<0 = `dealer_short_calls_resistance` (classic call wall)
  - PUT-dom + putGamma>0 = `dealer_long_puts_support` (they bought puts, hedge by buying stock when falling)
  - PUT-dom + putGamma<0 = `dealer_short_puts_support_fragile` (support that unwinds violently when breaks)
  - flip_zone = `mixed_flip_zone` (mechanic transitioning — highest leading value)
- **Flip events (L113):** if a strike's dominance crosses 0.5 between cycles → log event to `flipHistory[]`. A call→put flip at a resistance strike = resistance hardening OR breakdown imminent. A put→call flip at a support strike = support weakening.
- **How to use in entries:**
  - **Strong call_strong red bar + callGamma<0** = strong structural resistance, SHORT with high conviction
  - **flip_zone bar** = wait for flip confirmation OR place BOTH LONG and SHORT at edges of flip zone
  - **dealer_short_puts_support_fragile** = support yes but BREAKS faster than classic support — use tighter SL on LONG, or prefer SHORT breakdown entries
- **Run:** `node scripts/compute-dominance.cjs --save` (computes, saves snapshot, logs flips). Read `agent-state.json → dominanceSnapshot` for previous cycle comparison. Append flips to `data/flip-events.jsonl`.
- **Report in cycle log:** top 3 flip_zone strikes + any flip events from this cycle.

### 6. VOLATILITY
- Overall regime, term structure (contango/backwardation)
- Per-asset IV + skew
- VIX-SPX correlation (divergence = warning)

### 7. VANNA
- VIX change + signal, UVXY change + refuge signal
- GLD vanna signal, active flags

### 8. GEX FULL BREAKDOWN
- SPX, QQQ, DIA, GLD: total gamma, call gamma, put gamma, 0DTE gamma, gamma flip
- **ZERO call gamma on QQQ/DIA/GLD = no upside support, breakdowns accelerate**
- Tradier GEX: GLD, DIA totals + bias

### 9. 0DTE TRACE
- Bias, ratio, maxStrike (= magnetic TP target)

### 10. ⭐ OPTIONS FLOW — PER INSTRUMENT INDIVIDUAL TRADES
**NEVER just look at aggregated tape scores. Analyze individual trades per instrument.**
For EACH of the 7 symbols (SPX, QQQ, SPY, GLD, DIA, VIX, UVIX):
- P/C ratio, net delta, net gamma, dominant flow
- **LARGEST TRADES**: What are the biggest trades? Premium, strike, call/put, buy/sell, expiration, delta
- **STRIKE FLOW**: Which strikes have the most concentrated action? What direction?
- **RECENT TRADES**: What are institutions doing RIGHT NOW?

Then classify ALL trades (EVERY single one, not just the big ones):

**By size (WEIGHT in decisions):**
- **Institutional (>$50K)**: Smart money. ⭐⭐⭐ HIGHEST weight. These define direction.
- **Medium ($10K-50K)**: Funds/large traders. ⭐⭐ Medium weight. Confirm or contradict institutional.
- **Retail (<$10K)**: Individual traders. ⭐ Low weight individually, but in MASS they reveal crowd sentiment. 80% retail buying puts = fear. Can be contrarian signal at extremes OR confirmation.

**By expiration (WHAT it means):**
- **0DTE**: Intraday directional bet. Shows what traders expect TODAY. Timing signal.
- **This week (1-5 days)**: Short-term conviction. HIGH weight for immediate trades.
- **Monthly/Opex (2-4 weeks)**: Structural gamma positioning. Defines pin levels for opex. HIGH weight for levels.
- **LEAPS (>3 months)**: Long-term institutional thesis. Shows where big money sees the market going. Context weight.
- **ALWAYS note the expiry of each trade** — a $100K put expiring TOMORROW is very different from a $100K put expiring in 6 months.

**By delta impact (WHO moves the market):**
- **Net delta**: Total delta across all trades = overall positioning pressure
- High |delta| trades = these literally force dealers to hedge = move the market
- A $50K trade with delta -5M moves the market more than a $200K trade with delta -500K

**NEVER filter out small trades before analyzing.** The live flow watcher captures ALL orders every 5 seconds.

**KEY LESSON (L52)**: GLD $428 had $2.35M bearish concentrated in ONE strike — this was invisible in the aggregated tape score of +1. Only by reading individual GLD trades could you see institutions hammering that strike. ALWAYS read per-instrument trades.

**What to look for**:
- Single strike with massive concentrated premium = institutional conviction
- Call spreads / put spreads = defined risk bets with clear thesis
- VIX trades = volatility expectations (selling vol = range-bound, buying vol = expecting move)
- SELL at ASK vs BUY at BID = aggressive vs passive
- 0DTE large trades = intraday directional bets with immediate impact
- LEAPS = long-term structural views (less timing, more direction)
- **OPENING vs CLOSING** — are positions growing (conviction) or being unwound (weakening)?

**After analyzing all instruments, generate the COMBINED INTENTION:**
- What are institutions doing AS A WHOLE? Connect the dots across all instruments.
- Write a `combinedIntention` with: narrative (1 sentence), evidence (bullet points linking individual trades to the big picture), and scenarios (what happens under each macro outcome based on where the money is).
- Example: "53K puts CLOSING at SPX $7000 + VIX strangle SELL $2.7M + QQQ puts CLOSING at $600 = institutions REMOVING bearish hedges = they no longer expect a crash. But 40K calls OPENING at $6865 = that's the ceiling if it rallies."
- Save this to `agent-state.json → flowSnapshot.combinedIntention`

### 11. PRICE ACTION + CANDLES
- MT5 OHLC bars last 3 candles per CFD
- Patterns at key gamma levels (the fat bars from item 5!)

### 12. MACRO
- DXY + TLT, calendar countdown, upcoming events

### 13. BROKER + POSITIONS
- Bid/ask/spread per CFD
- Open positions P&L
- Balance/equity
- **Validate EVERY open position**: does the data still support the thesis? If not, CLOSE.
- **Validate EVERY pending order**: are levels still correct? R:R still ≥ 1:1.5?

### 14. ⭐ ENTRY DECISIONS — BE AGGRESSIVE, NOT PASSIVE

**FIRST: Classify market structure PER CFD.** Use ALL data from items 1-13 to determine:

| Structure | Detection | Trade Mode | Action |
|-----------|-----------|------------|--------|
| **ACCUMULATION** | Tight range (<80pts NAS) + HIRO improving + institutional flow buying quietly + tape neutral/bearish (retail not in yet) + VRP positive | SWING LONG | Place LONG at bottom of range. Breakout above range = add (pyramid). Patient. |
| **DISTRIBUTION** | Tight range at recent highs + HIRO deteriorating + institutional flow selling/closing longs + tape bullish (retail buying top) + VRP turning negative | SWING SHORT | Place SHORT at top of range. Breakdown below = add. Patient. |
| **MARKUP (trend up)** | HIRO >P70 sustained 3+ cycles + price breaking gamma bars upward + range expanding + VRP positive + green bars being tested from above (now support) | INTRADAY/SWING LONG | Trail LONG. Pyramid on bar breaks. No counter-trend SHORTs. |
| **MARKDOWN (trend down)** | HIRO <P30 sustained 3+ cycles + price breaking gamma bars downward + range expanding + VRP negative + red bars accelerating | INTRADAY/SWING SHORT | Trail SHORT. Pyramid on bar breaks. No counter-trend LONGs. |
| **CONGESTION/RANGE** | Price between 2 gamma bars <100pts apart + HIRO P40-P60 neutral + tape oscillating + price bouncing between boundaries 3+ times | SCALP | LONG at bottom boundary, SHORT at top. No swing. No pyramid. |
| **SQUEEZE** | Range compressing day-over-day + IV rank dropping + gamma bars clustering + HIRO flat | WAIT then INTRADAY | Wait for breakout direction. When confirmed → aggressive INTRADAY in breakout direction. |
| **TREND DAY** | Gap open + price never returns to open + HIRO extreme + range expanding every hour + flow one-directional | INTRADAY aggressive | Max orders in trend direction. Multiple entries at each bar break. No fading. |
| **ROTATION DAY** | Price crosses open 3+ times + HIRO neutral + balanced flow + range stable | SCALP | Fade extremes. LONG at day low boundary, SHORT at high. Small targets. |

Save `marketStructure` per CFD to agent-state.json (e.g., `"NAS100": "congestion"`, `"US30": "markdown"`, `"XAUUSD": "accumulation"`).
**The structure determines the tradeMode and strategy. Don't fight the structure.**

- For each CFD: identify LONG and SHORT scenarios at ALL gamma bars near price — not just the fattest
- **LEVEL mode by default** for ALL entries. CONFIRM mode ONLY for counter-trend reversals at extreme HIRO.
- Valid bars: >300M NAS, >3M GLD, >5M DIA (L101 — lowered from 500M/20M/10M after week analysis showed $347 missed)
- SL: behind the next gamma bar + buffer (15pts NAS/US30, 5pts XAU)
- TP: next gamma bar in trade direction (L59)
- **R:R ≥ 1:1.5 minimum** (L48 updated). 1:2 preferred but 1:1.5 acceptable.
- Write orders to agent-orders.json with exactLevel, entryMode, structuralSL
- **UNLIMITED ORDERS**: Place as many orders as the data justifies. 8-15 active orders is normal. Cover BOTH directions at EVERY valid gamma bar near price.
- **ALL 3 CFDs EQUALLY**: NAS100 uses SPX+QQQ+SPY bars. US30 uses DIA bars. XAUUSD uses GLD bars. Each CFD should have LONG+SHORT orders. Never neglect US30 or XAUUSD.
- **SPY and QQQ bars are INDEPENDENT entries for NAS100** (L44, L45). SPY $680 (-549M) is a valid entry level even if SPX doesn't show it.
- **BREAKOUT ORDERS at RED bars**: RED bars are accelerators — place LEVEL orders for breakouts. If price breaks through → vacuum → fast move.
- **ADAPT EVERY CYCLE (L99)**: Read fresh data EVERY cycle. Compare gamma bars, HIRO, flow, levels, ratios with existing orders. If ANYTHING changed significantly → UPDATE orders, snapshots, thesis IMMEDIATELY. Stale data = missed trades.
- **L97/L102 — NEVER BE PASSIVE**: At least 1 order within 50pts of NAS, $5 of XAU, 150pts of US30 AT ALL TIMES. If no bar exists within range, use nearest bar regardless of size.
- **L103 — HIRO EXTREME = ACT NOW**: If ANY symbol HIRO <P10 or >P90, place orders on that CFD within 1 cycle. Don't wait.
- **L104 — ALL 3 CFDs ALWAYS**: Every cycle MUST have orders on NAS100, US30, AND XAUUSD. Zero coverage = critical failure.
- **L105 — CONGESTION = ORDERS AT EDGES**: When congestion detected, LONG at bottom + SHORT at top boundary.
- **Save setups** to `agent-state.json → preIdentifiedSetups` with trigger level, gamma, direction, rationale, scenarios.
- **Save session stats** to `agent-state.json → todayStats`: range, trades, congestion cycles, HIRO/VRP/regime at close.

## Entry Models (from Markets in Profile + Options books)
1. **Fade Excess** — Price rejected at value area extreme (positive gamma)
2. **Bracket Breakout** — Range break with volume (negative gamma amplifies)
3. **Inventory Correction** — Short covering rally / long liquidation
4. **Poor High/Low Retest** — Unfinished business from yesterday
5. **Trend Day** — Open-Drive + narrow IB + elongated profile
6. **Gap Fill / Gap and Go** — Based on gamma regime + VRP
7. **Vanna Flow** — VIX spike → short indices / long gold

## CFD ↔ Options Mapping
- NAS100 ← SPX + QQQ data (ratio ~3.66x, recalculated each cycle)
- US30 ← DIA data (ratio ~99.7x, recalculated each cycle)
- XAUUSD ← GLD data (ratio ~10.8x, recalculated each cycle)
All levels in getAgentView are pre-converted to CFD prices.

## Lessons Learned (98)
Key lessons stored in agent-state.json. Most critical:
- L1: VRP negative = momentum, don't fade
- L2: Don't trade gamma flip pins without confirmation (UNLESS HIRO+tape+VRP aligned)
- L16: VRP overrides gammaRegime label
- L29: Don't chase moves that already happened
- L30: TopStrikes netPos can contradict tradierGex — trust topStrikes near levels
- L33: Verify broker accepts orders before assuming market is open
- L43: **GAMMA BARS are the key to entry precision.** Enter at the FATTEST bars (highest |gamma|), not random levels. These are the levels where dealers hedge most = strongest support/resistance.
- L44: **QQQ and SPY gamma bars MUST be checked alongside SPX for NAS100.** SPY $650 had -692M gamma (-164K net) = hidden accelerator not visible in SPX alone.
- L45: Multi-symbol gamma bars reveal the REAL support/resistance map. A SPX support can be weaker than it looks if SPY has massive negative gamma right next to it.
- L46: Executor SL protection: never auto-tighten SL without structural reason. Breakeven ONLY at 1R.
- L47: Market hours fix: 510-900 min Colombia time (9:30AM-4PM ET). Was cutting 2h daily.
- L48: **Minimum R:R 1:1.5 on ALL trades.** 1:2 preferred but 1:1.5 acceptable. 600 cycles with 0 fills = too conservative.
- L49: Three entry modes: zone (wide), level (tight ±8pts), confirm (micro-candle rejection). Confirm for bounces, level for breakouts.
- L50: LONG+SHORT on same asset at DIFFERENT levels = valid hedge if both structural. Same exactLevel = FORBIDDEN (L75, executor fills BOTH).
- L51: GLD tape bullish + HIRO bearish = retail buying dip while institutions sell. Trust HIRO.
- L52: **NEVER use aggregated tape scores alone.** Must read INDIVIDUAL TRADES per instrument. GLD $428 had $2.35M bearish in ONE strike — invisible in tape score of +1. Concentrated premium = institutional conviction.
- L53: **Classify trades by size**: Institutional (>$50K) = smart money, HIGHEST weight. Medium ($10K-50K) = funds. Retail (<$10K) = noise, often wrong at extremes. When they disagree, trust institutional.
- L54: **Classify trades by expiry**: 0DTE = intraday timing. Weekly = short-term conviction. Monthly/opex = structural positioning. LEAPS = long-term thesis. Read ALL expiries.
- L55: VIX options = volatility expectations. Selling vol = range-bound. Buying puts = VIX drops = bullish. Buying calls = crash protection.
- L56: SPX call/put spreads = institutional price targets. $9M call spread at 6745-6750 = ceiling NAS ~$24,694.
- L57: Per-instrument strike flow shows where the battle is. Highest concentrated delta = decision zone.
- L58: **LEVEL-TO-LEVEL MOVEMENT**: When price breaks a fat gamma bar, it travels to the NEXT fat bar. The vacuum between bars has little gamma = price moves fast. Entry = at the fat bar. TP = next fat bar. The vacuum = profit zone.
- L59: **TP = next fat gamma bar** in trade direction. Not arbitrary distance. The bars define real targets because dealers hedge there.
- L60: **BOUNCE vs BREAK at each fat bar**: The bar tells WHERE, the data tells WHAT. Score: HIRO + institutional flow + tape + VRP (positive=bounce, negative=break) + gamma sign (+high=harder to break) + candle (wick=bounce, body through=break). Majority wins. If bounce → confirm mode entry. If break → wait for candle body through → level mode entry, TP = next fat bar.
- L61: **LIVE ORDERS = INTENTION**: Puts buying = dealer buys underlying = SUPPORTS. Puts selling = dealer sells = PRESSURES down. Calls buying = dealer sells = RESISTS. Net delta at a strike = pressure direction.
- L62: **OPENING vs CLOSING**: Opening orders = new conviction (growing). Closing orders = reducing exposure (weakening level).
- L63: **FLOW PRESSURE vs GAMMA SIZE**: A fat bar can break if flow pressure exceeds gamma absorption. GLD $428: +37M gamma BUT -40M delta flow = flow wins = breaks. Always compare the two.
- L64: **CAPTURE ALL ORDERS** — not just institutional. Retail in mass tells a story too. Live flow watcher captures EVERY trade every 5s, classifies by size. Never filter before analyzing.
- L65: **ISM spike hit -1,111M bar and rejected.** Level-to-level confirmed in macro events too.
- L66: **Enter at the WALL, not 40pts above it.** Precision = tighter SL = better R:R.
- L67: **Macro spikes hit gamma bars and reject.** Entry = reversal at the bar, not chasing the spike.
- L68: **Always have US30 orders ready.** DIA bars exist and produce valid setups.
- L69: **Congestion between close bars (20pts) = DO NOT ENTER the interior.** But DO place orders at BOUNDARIES (L105): LONG at bottom, SHORT at top, SL outside the zone. The interior is dead — the edges are tradeable.
- L70: **Executor: gamma-trail wins over breakeven** if the trailing gamma level is more protective than breakeven.
- L71: **Executor: manualSL flag** = executor does NOT touch SL. For manual SL management.
- L72: **Executor: duplicate guard must check CFD+direction** not just order ID. Prevents 3x fills.
- L73: **19 fills for 6 trades = 3x duplication.** Executor duplicate guard was broken, now fixed.
- L74: **ALWAYS have orders ready.** Never leave the book empty if valid setups exist.
- L75: **NEVER LONG+SHORT at same exactLevel.** Executor fills BOTH. Lost -$6.74.
- L76: **OVERNIGHT ALLOWED with strict rules.** Gamma bars ARE valid overnight. Rules: ONLY fat bars (>1,000M NAS, >30M GLD, >20M DIA). Wider SL (25pts NAS/US30, 8pts XAU). **CONFIRM mode overnight** (L83 LEVEL default applies during market hours ONLY — overnight has no HIRO/tape to validate breakouts). XAUUSD priority (active in Asia/Europe). Pre-market (7AM+) full analysis with fresh data.
- L77: **Conversion ratios shift every cycle.** ALWAYS read current gammaBars from getAgentView.
- L78: **Every cycle order:** data freshness → gamma bars → scenarios → validate orders → flow.
- L79: **Pre-market and pre-macro ARE valid** if SpotGamma data is fresh and levels are clear. The problem was overnight without volume, not pre-market.
- L80: **Accelerator bars: use LEVEL mode, not confirm.** Price flies through accelerators — confirm mode misses the entry.
- L81: **UPDATE levels before market open** with fresh gamma bars. Stale levels from yesterday = missed entries.
- L82: **In freefall: SHORT orders BELOW price** at accelerator bars, LEVEL mode. Don't try to catch the falling knife with LONGs.
- L83: **LEVEL mode by default for ALL entries during market hours.** CONFIRM only for counter-trend reversals at extreme HIRO. Overnight: CONFIRM mode per L76 (no live data to validate breakouts). Bounces WITH trend = LEVEL. Bounces AGAINST trend = CONFIRM. Price touching a gamma bar IS the setup — don't wait for candle confirmation that may never come.
- L84: **FULL 14-point cycle every time during market hours (8:30AM-3PM Colombia).** No shortcuts. Brief logs ONLY allowed post-close with no positions AND price delta <15pts.
- L85: **Every cycle: WHERE are institutions positioning?** Which strikes? Which expiry? This is the edge.
- L86: **Show conversion ratios and level shifts each cycle.** Update orders if >20pts shift.
- L87: **SpotGamma vs MT5 price diff ~25pts NAS.** Executor uses MT5 prices for execution.
- L88: **Price diff is unstable.** Use SpotGamma levels directly, executor tolerance handles small diffs.
- L89: **Report gamma bars in ETF strike prices**, not converted CFD. The ETF strike is the real level.
- L90: **XAU: prefer FAT bars (>+30M) but >3M is acceptable per L101.** Small GLD bars are weaker but valid if near price (L102). >30M for SWING, >3M for SCALP/INTRADAY.
- L91: **VRP overrides direction for XAU when significant.** VRP < -1.0 = don't go LONG gold. VRP -0.03 to -1.0 = reduce conviction but allowed if HIRO >P70 AND institutional flow buying. VRP > 0 = LONG favored.
- L92: **SPX/QQQ HIRO divergence = sector rotation**, not broad crash. SPX improving + QQQ extreme bearish = selling tech specifically.
- L93: **Power hour HIRO improvements can be fake-outs.** SPX went P34→P44 then reversed P40 in one cycle. Don't trust near-close improvements.
- L94: **VIX call spread = range bet.** $14M VIX 20/22.5 = controlled volatility for weeks. Best regime signal for moderate bearish.
- L95: **GLD HIRO crash can be from single massive trade.** $795K trade crashed HIRO -22pts in 2 cycles. Cross-reference with institutional trade list.
- L96: **triggerSymbol MUST match gamma bar's native ETF.** NAS100: SPX/SPY/QQQ. XAUUSD: GLD. US30: DIA. NEVER default all to SPX.
- L97: **NEVER be static with orders.** Every cycle MUST seek NEW entries near current price, not just validate old orders. If nearest order is >50pts NAS / $5 XAU / 150pts US30 from price, MUST find intermediate gamma bars and place new orders. Old orders stay PLUS new ones. (Updated from >100pts per L102 week analysis.)
- L98: **US30 gammaBars now use DIA-only bars.** Fixed: endpoint was returning SPX bars converted to US30 (DIA gamma too small to make combined top 20). Now gammaBarSyms=["DIA"] for US30.
- L99: **ALL DATA CHANGES DURING THE SESSION — NOT JUST BARS.** Update EVERYTHING every cycle. Stale data = missed trades = money lost.
- L100: **VALIDATE AND ADAPT ORDERS — BOUNCE vs BREAK.** When price approaches an order, score L60: HIRO + tape + flow + VRP + gamma sign. If data says BOUNCE → keep order direction. If data says BREAK → FLIP the order (LONG→SHORT or SHORT→LONG) at the SAME level. Don't cancel — ADAPT. The bar tells WHERE, the live data tells WHICH DIRECTION.
- L101: **LOWER BAR THRESHOLDS.** Week analysis showed SPY$679 (+617M) bounced 10+ times but was ignored. New minimums: NAS >300M (was >500M), US30 >5M (was >10M), XAU >3M (was >20M). Any bar that price reacts to repeatedly is valid regardless of gamma size.
- L102: **MANDATORY PROXIMITY — orders MUST be near price.** At least 1 order within 50pts of NAS price, $5 of XAU, 150pts of US30 AT ALL TIMES. Apr 9: nearest order 152pts away in 116pt range = 0 fills. If no gamma bar within range, use the nearest bar regardless of size.
- L103: **HIRO EXTREME = IMMEDIATE ORDERS.** When HIRO <P10 or >P90 on ANY symbol, place orders within 1 cycle. DIA P3 at open Apr 10 was ignored for 3 hours while US30 crashed 376pts. Extreme HIRO is the strongest signal — act immediately.
- L104: **EQUAL CFD COVERAGE — ALL 3 ALWAYS.** US30 had $100.80 missed, XAU had $121.00 missed because agent was ~85% NAS focused. Every cycle MUST have active orders on NAS100, US30, AND XAUUSD. Zero-coverage on any CFD is a critical failure.
- L105: **CONGESTION BOUNDARIES GET ORDERS.** When L69 congestion detected, place LONG at bottom boundary + SHORT at top boundary. Apr 9: 25,000-25,080 congestion had 0 orders inside = missed 2 profitable trades (+$16).
- L106: **BREAKEVEN SL = ENTRY + 5pts BUFFER (NAS/US30), +2pts (XAU).** Trade 7 was stopped out 2.4pts below entry then went +207pts. Exact breakeven gets shaken out by normal noise. Buffer prevents this.
- L107: **TRADE MODE = STRUCTURAL DECISION.** SCALP for congestion/tight bars (<30pts). INTRADAY for normal market moves. SWING for multi-day thesis with LEAPS/monthly flow or HIRO extreme. Mode determines SL width, breakeven threshold, trail style, volume, and expiry. ALWAYS set tradeMode on every order.
- L108: **PYRAMID = ADD when move CONFIRMS.** Only in profit. Same volume. SL conjunto. Max: SCALP 0, INTRADAY 2, SWING 3. Signals: price breaks bar, HIRO strengthens, institutional flow confirms, candle pattern confirms.
- L109: **AUTO-CLASSIFY MODE**: 0DTE flow = SCALP. Weekly flow = INTRADAY. Monthly/LEAPS = SWING. Bar separation <30pts = SCALP, >100pts = SWING. HIRO extreme = SWING.
- L110: **CLASSIFY MARKET STRUCTURE PER CFD EVERY CYCLE.** Accumulation, distribution, markup, markdown, congestion, squeeze, trend day, rotation day. The structure determines tradeMode and strategy. Don't fight the structure. Save to agent-state.json → marketStructure.
- L111: **CONFLICT PRIORITY RULES.** When rules conflict: (1) Statistical rules (N>200) override single lessons. NAS SHORT very_neg=40%WR → use SCALP not INTRADAY/SWING. (2) L76 overnight rules override L83 LEVEL default. (3) Freefall (HIRO<P10 + bars breaking) overrides L105 congestion LONGs — SHORT only in freefall. (4) Flow magnitude > gamma magnitude = BREAK per L63, add +2 to L60 BREAK score. (5) When HIRO signals conflict between symbols (L92), trade the individual CFD based on ITS ETF HIRO (QQQ for NAS, DIA for US30). (6) Power hour HIRO changes are unreliable (L93) — don't change positions in last 60min based on HIRO alone.
- L112: **TRADE MODE UPGRADE.** A SCALP can become INTRADAY, an INTRADAY can become SWING — but NEVER downgrade. When pyramid signals fire on a SCALP, upgrade to INTRADAY first. When HIRO goes extreme on an INTRADAY, upgrade to SWING. Update tradeMode, adjust SL/volume, enable pyramiding.
- L113: **DOMINANCE FLIP PER STRIKE = LEADING INDICATOR.** Each strike has callGamma and putGamma — the ratio tells WHICH side drives the level. `callDominance = |callGamma|/(|callGamma|+|putGamma|)`. Buckets: ≥0.80 call_strong, 0.40-0.60 flip_zone, <0.20 put_strong. When dominance crosses 0.5 between cycles = **FLIP EVENT** — the market structure at that strike changed. A call→put flip at resistance = resistance weakening (breakout signal). A put→call flip at support = support weakening (breakdown signal). Strikes in flip_zone (0.40-0.60) are transitioning and are the highest-information strikes. Combined with gamma SIGN: `dealer_short_puts_support_fragile` (put-dom + negGamma) = support breaks faster than classic. Run `scripts/compute-dominance.cjs --save` each FULL cycle. Snapshot in `agent-state.json → dominanceSnapshot`, flip log in `data/flip-events.jsonl`.

## Statistical Rules (576-day backtest, 160K candles, 2,246 touch events)

**Candle patterns at gamma bars:**
- Hammer at support = 76% bounce 1h (N=129) — STRONGEST signal
- Doji = 69% bounce (N=262). Wick rejection below = 65% (N=371)
- Body-through = 58-61% break continuation — breakout confirmed

**Fake breaks:** 72% of touches are fake (N=1,610). Wait 2nd candle body-through. Avg 61pts penetration before reversal. Fat bars = 77% fake breaks.

**Post-break:** 69% pull back to retest (N=723). 65% of retests hold as new S/R. RETEST = best entry R:R.

**Bar size (counter-intuitive):** >1000M = 47% bounce (LESS). <100M = 55% (MORE). Mega bars = breakout zone. Small = scalp bounce.

**VRP (#1 predictor):** VRP<-0.02 = 64% break (N=457). VRP>0.02 = 49% bounce (N=736). NEVER fade bars with negative VRP.

**VIX:** <20 = 38% bounce. >20 = 50% bounce. High VIX = bars more reliable.

**Regime:** Neutral = 55% bounce (BEST). Positive = 40% (WORST). Very_neg = 42%.

**Days:** Wed = 57% bounce (BEST). Thu = 50% (WORST). OpEx day = 44% (WORST overall).

**Confluence:** SPX+SPY same level = 57% vs 51% single (+6%). Negative net delta = 57% bounce.

**Optimal SL/TP (medians from data):**
- NAS: SCALP SL21/TP52, INTRADAY SL42/TP87, SWING SL83/TP183
- US30: SCALP SL30/TP71, INTRADAY SL56/TP109, SWING SL107/TP224
- XAU: SCALP SL4/TP8, INTRADAY SL6/TP12, SWING SL9/TP26

**NAS fat bar (>1B) EV:** SL15/TP100 = +13.5pts/trade. SL10/TP100 = +12.2pts. 3x better than all bars.

**XAU WARNING:** NO SL/TP combo has positive EV alone (N=359). ALWAYS needs HIRO+flow+DXY confirmation.

**Level-to-level speed:** NAS 3.1h avg (N=851). <50pts gap = 1.2h. Negative regime = fastest 2.9h.

## Multi-Factor Scoring (from 576-day backtest)

**Score each potential entry** (VRP, VIX, Regime, Bar type, Day alignment):
- Score -3/-4 = ~28-36% bounce → BREAKOUT entry, not bounce
- Score 0 = 49% → coin flip, skip or need extra confirmation
- Score +2/+3 = ~57-59% bounce → valid bounce entry

**Best 2-factor combos (N>150):**
- DAY_ALIGNED + VIX_HIGH = 73% (N=494)
- DAY_ALIGNED + VRP+ = 72% (N=418)
- DAY_ALIGNED + MED_BAR = 72% (N=316)

**Worst combos (BREAKOUT territory):**
- REG_NEGATIVE + SUPPORT = 23% bounce (N=31) → breaks 77%!
- VIX_MID + VRP_NEGATIVE = 29% (N=243)
- FAT_BAR + REG_VERY_NEG = 30% (N=104)

**VRP + Regime table:**
- Best: VRP+_neutral = 58%, VRP0_neutral = 57%
- Worst: VRP-_very_negative = 33%, VRP-_positive = 35%

## Overnight & Weekend Rules (from 588 nights, 117 weekends)

**Overnight gaps (P90 = safe SL minimum):**
- NAS: avg 25pts, P90 = 52pts. Minimum overnight SL = 52pts.
- US30: avg 35pts, P90 = 62pts. Minimum overnight SL = 62pts.
- XAU: avg 3pts, P90 = 8pts. Minimum overnight SL = 8pts.

**Weekend gaps (Fri→Mon):**
- NAS: avg 71pts, P90 = 223pts. 66% gap UP. Worst = -568pts (Apr 4 2025).
- US30: avg 99pts, P90 = 254pts. 68% gap UP. Worst = -1019pts.
- XAU: avg 7pts, P90 = 19pts. 46% gap UP.

**Weekend SL survival rates:**
| SL | NAS | US30 | XAU(pts) |
|----|-----|------|----------|
| 100 | 80% | 74% | 80%(SL10) |
| 200 | 88% | 90% | 91%(SL20) |
| 300 | 95% | 91% | 95%(SL30) |

**Overnight LONG bias:** NAS 61% wins, US30 60%, XAU 56%. Default LONG overnight.

## Macro Event Rules (from 102 macro events)

- Macro days are **14% more volatile** (413pts vs 363pts NAS range)
- Gamma bars **HOLD BETTER on macro days**: 53% bounce vs 43% normal
- FOMC = most volatile (445pts). CPI = least (352pts). NFP = highest bounce 58%.
- **Fade macro spikes at gamma bars** — 53% bounce rate confirms this strategy
- Widen SL 14% on macro event days

## Drawdown Recovery (from 1,019 NAS events)

| Adverse Move | Recover 1h | Recover 4h |
|-------------|-----------|-----------|
| 10pts | 95% | 97% |
| 20pts | 90% | 93% |
| 30pts | 80% | 85% |
| 40pts | 71% | 79% |
| 50pts | 64% | 73% |

No clear "point of no return" — even 50pts adverse has 73% recovery. Supports wider SL.

## Momentum & Streak Rules

- After 3 DOWN days NAS → **58% reversal** (N=50). After 5 DOWN → **67%** (N=9).
- After 3 UP days NAS → 54% continuation.
- Positive gamma regime lasts avg **7.7 days** (max 163). Very_negative = 1.9 days.
- Use regime duration for trade mode: >5 days = SWING, <3 days = SCALP.

## VIX-Based Range Expectations

| VIX | Expected NAS Range | UP% | SL adjustment |
|-----|-------------------|-----|---------------|
| <15 | 252pts | 61% | Tighten SL |
| 15-20 | 360pts | 57% | Normal SL |
| 20-25 | 491pts | 47% | Widen 35% |
| 25-30 | 662pts | 30% | Widen 85% |
| >30 | 1,020pts | 33% | Widen 180% or reduce size |

## Gap Fill Rules

- Small gaps fill **89-94%** of the time → fade small gaps
- Big NAS gaps (>100pts): only **52% fill**, 55% continue → DON'T fade
- US30 big gaps (>100pts): 64% fill → fade cautiously
- Monday has largest gaps (NAS avg 71pts vs Tue-Fri avg 14pts)

## Individual Flow Analysis — How to Read (User's Method)
**The user's second key method: read every individual order, classify them, and find where smart money is concentrated.**

### What to analyze per instrument (SPX, QQQ, SPY, GLD, DIA, VIX, UVIX):
1. **Largest trades**: The 5 biggest by premium. Who placed them? What strike/expiry?
2. **Recent trades**: What's happening RIGHT NOW? Is smart money active or quiet?
3. **Strike flow**: Which strike has the most concentrated action? Net delta direction?

### Classification matrix:
| Size | Who | Weight | Example |
|------|-----|--------|---------|
| >$50K | Institutional/Smart money | ⭐⭐⭐ Maximum | GLD PUT 428 $201K |
| $10K-50K | Funds/Large traders | ⭐⭐ Medium | QQQ PUT 585 $24K |
| <$10K | Retail | ⭐ Low (often wrong) | SPX CALL 6540 $60 |

### By expiration:
| Expiry | Meaning | Weight |
|--------|---------|--------|
| 0DTE | Intraday directional bet | Timing signal |
| This week | Short-term conviction | High for immediate trades |
| Monthly/Opex | Structural gamma positioning | High for levels |
| LEAPS (>3mo) | Long-term institutional thesis | Context |

### Key patterns:
- **Single strike massive premium** (e.g., GLD $428 = $2.35M) = institutional conviction at that level
- **Call spread** (buy one strike, sell another) = defined risk bet with price target
- **VIX selling vol both sides** = expects range, no crash or rally
- **Retail heavily one-sided** = often a contrarian signal at extremes
- **Institutional quiet while retail active** = big money already positioned, waiting

## Gamma Bars — How to Use (User's Method)
The user's primary method from SpotGamma Equity Hub: find the strikes with the **fattest bars** (highest absolute gamma) and trade at those levels. These are where dealer hedging is concentrated = strongest price reactions.
- `getAgentView` now includes `gammaBars` per CFD: top 20 fattest bars from SPX+QQQ+SPY (NAS), DIA (US30), GLD (XAUUSD)
- Each bar has: cfdPrice, strike, symbol (which ETF), gamma, netPos, type (support/resistance)
- **Green bars (positive gamma) = support** — dealers absorb selling here
- **Red bars (negative gamma) = resistance/accelerator** — dealers amplify moves through these
- Entry at green bar = LONG with SL below. Entry at red bar rejection = SHORT.
- When green+red bars are close together = congestion zone, wait for break.

## Fast Executor Entry Modes — NEAR-EXACT LEVEL ENTRIES
**User requirement: enter close to the gamma bar level, not 15-20pts away.**
- `zone`: Execute if price anywhere in [low, high] range — RARELY use, only for wide breakout catches
- `level`: **±5pts NAS/US30, ±3pts XAU** — Execute near the exact level. For breakouts.
- `confirm`: **±10pts NAS/US30, ±5pts XAU** + micro-candle rejection — Execute near level WITH confirmation. For bounces.
- Always set `exactLevel` to the exact gamma bar cfdPrice.

## Trade Modes & Pyramiding

### Three Trade Modes
Every order MUST specify `tradeMode`. The executor adjusts breakeven, trail, and expiry per mode.

**SCALP** (`tradeMode: "scalp"`):
- When: congestion zones, tight gamma bars (<30pts NAS), 0DTE plays, fading macro spikes
- SL: 10-15pts NAS/US30, 3-5pts XAU (behind nearest bar)
- TP: next gamma bar ONLY (TP1). No TP2/TP3.
- Breakeven: 0.5R (aggressive). Trail: fixed 8pts NAS/US30, 3pts XAU.
- Volume: standard (0.10/0.10/0.01). Expires: 2 hours.
- Pyramid: NOT allowed.

**INTRADAY** (`tradeMode: "intraday"`) — DEFAULT:
- When: directional moves during market hours, CPI/FOMC reactions, normal gamma bar setups
- SL: 15-25pts NAS/US30, 5-8pts XAU (behind bar + buffer)
- TP: TP1 at next bar, TP2 optional (2 bars out)
- Breakeven: 1R. Trail: gamma-trail (level to level) with 15pts/5pts buffer.
- Volume: standard. Expires: 20:00 UTC (market close).
- Pyramid: up to 2 additions when move confirms.

**SWING** (`tradeMode: "swing"`):
- When: multi-day trends, weekly/monthly/LEAPS flow, HIRO extreme (<P10 or >P90), structural regime plays
- SL: 50-100pts NAS/US30, 15-25pts XAU (2-3 bars back)
- TP: TP1 at 2nd bar, TP2 at 3rd bar, TP3 at major structural level
- Breakeven: 1.5R (more room). Trail: gamma-trail every 4h, buffer 25pts/10pts.
- Volume: REDUCED (0.03 NAS, 0.03 US30, 0.01 XAU) — wider SL = smaller size.
- manualSL: true by default — Claude manages SL each cycle with fresh data.
- Expires: never. Position lives until thesis invalidates.
- Pyramid: up to 3 additions when move confirms.

### Mode Auto-Classification
| Factor | SCALP | INTRADAY | SWING |
|--------|-------|----------|-------|
| Gamma bars separation | <30pts NAS | 30-100pts | >100pts |
| HIRO trend | Any | P30-P70 | <P10 or >P90 |
| Flow expiry | 0DTE dominant | Weekly/0DTE | Monthly/LEAPS |
| Macro event | Fading spike | Reaction | No event (trend) |
| Congestion (L69) | YES → scalp edges | NO → directional | N/A |
| Bar fatness | >300M NAS | >500M NAS | >1000M NAS |

### Pyramiding Rules (L108)
Pyramiding = adding to winning positions when the move CONFIRMS. Claude decides when to pyramid.

**Signals to add:**
1. Price breaks gamma bar in trade direction → add at next bar
2. HIRO strengthens (e.g., P50→P80 with LONG open)
3. Institutional flow confirms (new large trades same direction)
4. Candle pattern confirms (engulfing, hammer in direction)
5. VRP supports direction

**Rules:**
- Only if original trade is in profit (at least breakeven)
- Each addition = same volume as original (not more)
- SL of entire chain moves to breakeven of the group
- Max pyramids: SCALP=0, INTRADAY=2, SWING=3
- Addition is a new `pendingOrder` with `pyramidOf: "parent-id"`

### Order Format with Trade Mode
```json
{
  "id": "nas-long-6850-swing",
  "cfd": "NAS100",
  "direction": "LONG",
  "tradeMode": "swing",
  "exactLevel": 25240,
  "entryMode": "level",
  "triggerSource": "spotgamma",
  "triggerSymbol": "SPX",
  "triggerLevel": 6850,
  "structuralSL": 25100,
  "tp1": 25400,
  "tp2": 25600,
  "tp3": 25800,
  "volume": 0.03,
  "rationale": "SWING: SPX$6850 +1397M. HIRO P90+ 3 cycles. LEAPS flow bullish. R:R 2.3:1",
  "conviction": "HIGH"
}
```

## MT5 Setup
- Broker: Pepperstone Demo (account 61498408)
- EA: SpotGammaBridge v2 (in MQL5/Experts/) — sends bid/ask + positions
- Communication: JSON files in MQL5/Files/ (sg_order, sg_result, sg_status)
- Symbols: NAS100 (min 0.10), US30 (min 0.10), XAUUSD (min 0.01)

## Cron Execution — How to Run Each Cycle

Each cron trigger executes ONE full trading cycle. Follow these steps IN ORDER:

### Step 1: Read Identity + Live State (CONTEXT RECOVERY — DO THIS FIRST, NO EXCEPTIONS)
Read these files IN ORDER before anything else:
1. `agent/agent-identity.md` — tu rol, principios, prohibiciones, active lessons. Confirma que lo leíste.
2. `data/live-state.json` — estado vivo compacto del ciclo anterior: market_structure, gamma_context, hiro, execution, intentions, thesis. Este es tu punto de partida.
3. `data/agent-state.json` — memoria completa: 105+ lessons, performance, gammaBarsSnapshot, flowSnapshot, recentCycles
4. `data/user-directives.json` — preferencias del usuario (NUNCA modificar sin permiso)
5. `data/agent-orders.json` — órdenes pendientes + posiciones managed actuales

**BLOQUEO**: Si no has leído `agent-identity.md` y `live-state.json`, NO ejecutes ninguna decisión de trading.

**live-state.json es tu source of truth compacto** — reconstruye el contexto desde ahí, no desde logs ni snapshots antiguos.

**Check for open positions immediately** — si hay managed positions en live-state.json, valídalas contra datos actuales ANTES de cualquier otra cosa.

### Step 2: Fetch Market Data
Fetch ALL 3 endpoints using node (not curl):
```javascript
export PATH="/c/Program Files/nodejs:$PATH" && node -e "..."
```
- `http://localhost:3099/api/trpc/market.getAgentView` — 25 categories: cfds (with gammaBars, levels, hiro, tape, flow per CFD), gex, vanna, vol, odte, calendar, optionsFlow, institutionalFlow, liveFlow, etc.
- `http://localhost:3099/api/trpc/market.getMT5Status` — broker prices (bid/ask), account balance/equity, open positions
- `http://localhost:3099/api/trpc/market.getExecutorState` — pending orders + managed positions in the fast executor

### Step 3: Time Check
Calculate Colombia time (UTC-5):
- **Market hours (9:30AM-4PM ET = 8:30AM-3PM Colombia):** FULL 14-point analysis + trade
- **Pre-market (7AM-8:30AM Colombia):** FULL analysis with fresh SpotGamma data. Valid for order placement (L79).
- **Post-close (3PM-6PM Colombia = 4PM-7PM ET):** Monitor prices + validate open positions. If FLAT and no positions, brief log only.
- **Evening (6PM-11PM Colombia):** Monitor prices. If positions open, validate. If FLAT, brief log.
- **Overnight (11PM-6AM Colombia):** Trading ALLOWED at FAT bars only (L76). Use end-of-day gammaBarsSnapshot + combinedIntention from agent-state.json. Rules: only bars >1,000M NAS / >30M GLD / >20M DIA. Wider SL (25pts NAS/US30, 8pts XAU). CONFIRM mode only. No HIRO/tape available — use VRP + gamma size + institutional intention from close. XAUUSD priority (Asia/Europe active).

### Step 4: FULL 14-Point Analysis
Execute ALL 14 checkpoints from the MANDATORY CHECKLIST above. **NEVER skip any item.**
- Items 5 (GAMMA BARS), 10 (OPTIONS FLOW), and 14 (ENTRY DECISIONS) are the most critical.
- Read `cfds.NAS100.gammaBars`, `cfds.US30.gammaBars`, `cfds.XAUUSD.gammaBars` for the fat bars.
- Read individual trades per instrument from optionsFlow/liveFlow (L52).

### Step 5: Write Orders
Write to `data/agent-orders.json`:
```json
{
  "pendingOrders": [
    {
      "id": "unique-id",
      "cfd": "NAS100",
      "direction": "LONG",
      "exactLevel": 25011,
      "entryMode": "confirm",
      "triggerSource": "spotgamma",
      "triggerSymbol": "SPX",
      "triggerLevel": 6800,
      "structuralSL": 24922,
      "tp1": 25084,
      "tp2": 25250,
      "volume": 0.10,
      "rationale": "SPX $6,800 +1,582M GREEN wall. Bounce expected. HIRO P110. R:R 2.1:1",
      "conviction": "HIGH",
      "expiresAt": "2026-04-10T21:00:00.000Z"
    }
  ],
  "managedPositions": [],
  "lastPriceCheck": "2026-04-10T13:30:00.000Z"
}
```
**Rules:**
- `triggerSymbol` MUST match the gamma bar's native ETF (L96): NAS→SPX/SPY/QQQ, US30→DIA, XAU→GLD
- `entryMode`: "level" for ALL entries during market hours (L83). "confirm" ONLY for counter-trend bounces (going LONG while HIRO <P20) or overnight entries (L76).
- SL behind next gamma bar + buffer: 15pts NAS/US30, 5pts XAU
- TP = next fat gamma bar in trade direction (L59)
- R:R >= 1:1.5 required (L48). If R:R fails, skip the trade.
- Report levels as ETF strikes: "SPX $6,800 (+1,582M)" not "NAS 25,011" (L89)

### Step 6: Validate Existing Orders + Positions
**For EACH pending order, check if it's still valid by scoring these factors:**
- **Gamma bar still exists?** If the bar disappeared or shrank significantly → cancel
- **HIRO direction**: If order is LONG but HIRO is bearish and falling → reduce conviction or cancel
- **Tape sentiment**: If order is LONG but tape is -100 max bearish → warning (L51: HIRO > tape, but both bearish = strong signal)
- **Institutional flow**: Are institutions buying or selling at that level? (L52, L53)
- **VRP**: Negative VRP = momentum, don't fade (L1). If LONG against momentum → cancel
- **Proximity alert (L100)**: When price is within 30pts NAS (or $3 XAU) of an order, score BOUNCE vs BREAK (L60):
  - HIRO direction? Tape sentiment? Institutional flow? VRP? Gamma sign?
  - If majority says BOUNCE → keep order as bounce entry
  - If majority says BREAK → **FLIP the order direction** at the same level (LONG→SHORT or SHORT→LONG)
  - Don't cancel — ADAPT to what the data says RIGHT NOW
- **Positions:** Close if thesis invalidated (don't wait for SL if data says exit NOW)
- **SL levels:** Update if gamma bars shifted significantly (>20pts NAS, >$2 XAU)

### Step 7: SEEK NEW ENTRIES (L97 — CRITICAL)
**Every cycle, actively hunt for new setups near current price.**
- If nearest pending order is >50pts from NAS price (or >$5 from XAU, >150pts US30), you MUST find intermediate gamma bars and create additional orders (L102).
- Old orders stay — add NEW ones. More scenarios = more chances.
- Check `cfds.*.gammaBars` for the fattest bars within ±200pts of price.
- The agent's job is to ACTIVELY HUNT setups, not passively wait.

### Step 8: Update Memory
- Update `data/agent-state.json`: increment cycleNumber, update lastCycle timestamp, update thesis per CFD
- **MANDATORY: Update ALL snapshots in `agent-state.json` EVERY cycle** (L99). These MUST reflect current data, not stale data from hours ago:
  - `gammaBarsSnapshot`: gamma bars per CFD (strike, gamma, type, cfdPrice, distFromPrice)
  - `flowSnapshot`: per-instrument flow (P/C, netCalls/Puts, tape, strikeConcentration, topFlowStrikes) + `combinedIntention` (narrative + evidence + scenarios) + `keyInstitutionalTrades`
  - `volSnapshot`: per-asset IV level, term structure, skew, atmIV (detect cheap/expensive options)
  - `vannaSnapshot`: VIX change, vanna signals, UVIX/GLD divergence
  - `gexSnapshot`: per-symbol call/put/total/0DTE gamma, gamma flip levels (detect dealer positioning)
  - `odteSnapshot`: 0DTE bias, maxGexStrike (magnetic target), hedgeWall, top support/resistance
  - `macroSnapshot`: DXY, TLT, trends, next event countdown
  - `levelsSnapshot`: callWall, putWall, gammaFlip, volTrigger, maxGamma per CFD with context
  - `lastRatios`: conversion ratios (NAS, US30, XAU) for drift detection
  - `todayStats`: session range, trades, congestion cycles, HIRO/VRP/regime at close
  - `preIdentifiedSetups`: setups for next session with trigger levels, gamma, direction, rationale, scenarios
- **Update `recentCycles` array** in agent-state.json (rolling last 10 cycles). Each entry:
  ```json
  {
    "cycle": "C###", "ts": "ISO",
    "prices": { "NAS": 25080, "US30": 48190, "XAU": 4770 },
    "hiro": { "SPX": "P44", "QQQ": "P3", "DIA": "P5", "GLD": "P56" },
    "regime": "very_neg SPX",
    "thesis": "1-sentence market narrative",
    "keyFlow": "Top institutional trade summary",
    "ordersActive": 8,
    "positionsOpen": ["nas-short-25109"],
    "reasoning": "WHY this decision was made (2-3 sentences)",
    "marketFeel": "Choppy/trending/breakout/congestion descriptor",
    "marketStructure": { "NAS": "congestion", "US30": "markdown", "XAU": "accumulation" }
  }
  ```
  This is the PRIMARY context bridge between sessions. Trim to 10 entries max.

- **Save session stats** to `agent-state.json → todayStats`: range, trades, congestion cycles, HIRO/VRP/regime at close.
- **Save setups** to `agent-state.json → preIdentifiedSetups` with trigger level, gamma, direction, rationale, scenarios.

- Append ENRICHED decision to `data/claude-decisions.jsonl`:
```json
{
  "ts": "ISO", "cycle": "C###",
  "prices": { "NAS": 25080, "US30": 48190, "XAU": 4770 },
  "action": "TRADE/NO_TRADE/HOLD/SL_HIT/TP_HIT",
  "direction": "LONG/SHORT",
  "cfd": "NAS100",
  "tradeMode": "scalp/intraday/swing",
  "triggerBar": "SPX$6825 -1114M",
  "hiro": { "SPX": "P44", "DIA": "P5" },
  "regime": "very_neg",
  "reasoning": "Why this action was taken",
  "confidence": "HIGH/MEDIUM/LOW",
  "lessonsApplied": ["L83", "L58"]
}
```

- Append to `data/daily-context.jsonl` (ONE entry per FULL cycle for backtesting — the COMPLETE snapshot):
```json
{
  "ts": "ISO", "cycle": "C###",

  // ── PRICES & MICROSTRUCTURE ──
  "prices": { "NAS": 25080, "US30": 48190, "XAU": 4770 },
  "priceDelta": { "NAS": -12, "US30": -45, "XAU": 3 },
  "priceSpeed": { "NAS": 12, "US30": 45, "XAU": 3 },
  "spreads": { "NAS": 1.0, "US30": 2.0, "XAU": 0.16 },
  "dayRange": { "NAS": { "high": 25226, "low": 25040, "range": 186 }, "US30": { "high": 48226, "low": 47850, "range": 376 }, "XAU": { "high": 4794, "low": 4732, "range": 62 } },
  "priceInRange": { "NAS": 0.22, "US30": 0.10, "XAU": 0.61 },
  "distFromDayHigh": { "NAS": 146, "US30": 376, "XAU": 24 },
  "distFromDayLow": { "NAS": 40, "US30": 0, "XAU": 38 },

  // ── SESSION & TIME ──
  "session": "market_open",
  "minSinceOpen": 180,
  "minToClose": 210,
  "dayOfWeek": "Thu",
  "daysToOpex": 8,

  // ── HIRO (all 8 symbols) ──
  "hiro": {
    "SPX": { "p": 44, "val": 774, "trend": "neutral", "delta": -3 },
    "QQQ": { "p": 3, "val": -2900, "trend": "bearish", "delta": -8 },
    "SPY": { "p": 41, "val": 590, "trend": "neutral", "delta": -2 },
    "DIA": { "p": 5, "val": -500, "trend": "bearish", "delta": 0 },
    "GLD": { "p": 56, "val": 200, "trend": "neutral", "delta": 2 },
    "VIX": { "p": 50, "val": 0, "trend": "neutral", "delta": 0 },
    "UVIX": { "p": 45, "val": 0, "trend": "neutral", "delta": 0 },
    "IWM": { "p": 40, "val": 0, "trend": "neutral", "delta": -1 }
  },
  "hiroConvergence": "mixed",
  "hiroExtremeCount": 2,

  // ── TAPE (all 7 symbols) ──
  "tape": { "SPX": -75, "QQQ": -16, "SPY": -61, "DIA": -1, "GLD": 24, "VIX": 0, "UVIX": 0 },
  "tapeVsHiro": "aligned",

  // ── REGIME & VRP ──
  "regime": { "SPX": "very_neg", "QQQ": "neg", "DIA": "pos", "GLD": "pos" },
  "vrp": { "SPX": -2.1, "QQQ": -3.4, "DIA": 0.5, "GLD": -0.03 },

  // ── VOLATILITY ──
  "vix": 19.56,
  "vixDelta": 0.41,
  "ivRank": { "SPX": 45, "QQQ": 52, "DIA": 38, "GLD": 61 },
  "skewBias": "put_skew",
  "termStructure": "contango",

  // ── MACRO ──
  "dxy": 98.66,
  "dxyDelta": -0.15,
  "tlt": 86.50,
  "tltDelta": 0.20,
  "macroNext": { "event": "CPI", "hoursUntil": 2.5, "impact": "High" },
  "macroLast": { "event": "FOMC", "hoursAgo": 48, "impact": "High" },

  // ── VANNA ──
  "vanna": { "vixChg": 0.41, "uvixChg": 1.56, "active": false, "refuge": false, "uvixGldDivergence": false },

  // ── GEX ──
  "gex": {
    "SPX": { "total": 2200000, "call": 1800000, "put": 400000, "zeroDte": 890000, "gammaFlip": 6500 },
    "QQQ": { "total": 150000, "call": 0, "put": 150000, "zeroDte": 50000 },
    "DIA": { "total": 5000, "call": 3000, "put": 2000, "zeroDte": 1000 },
    "GLD": { "total": 8000, "call": 0, "put": 8000, "zeroDte": 2000 }
  },

  // ── 0DTE ──
  "odte": { "bias": "bullish", "ratio": 1.79, "maxGex": 6850, "maxGexCFD": 25240, "hedgeWall": 6850 },

  // ── GAMMA BARS (top 5 near price per CFD) ──
  "gammaBarsNear": {
    "NAS": [
      { "sym": "SPX", "strike": 6825, "gamma": -1114, "type": "resist", "dist": -7, "timesTouched": 3 },
      { "sym": "SPY", "strike": 679, "gamma": 266, "type": "support", "dist": -13, "timesTouched": 6 },
      { "sym": "SPX", "strike": 6850, "gamma": 1397, "type": "support", "dist": 112, "timesTouched": 0 },
      { "sym": "SPY", "strike": 680, "gamma": -549, "type": "resist", "dist": 21, "timesTouched": 1 },
      { "sym": "SPX", "strike": 6780, "gamma": -730, "type": "resist", "dist": -146, "timesTouched": 0 }
    ],
    "US30": [
      { "sym": "DIA", "strike": 479, "gamma": -2, "type": "resist", "dist": -14, "timesTouched": 1 },
      { "sym": "DIA", "strike": 483, "gamma": 66, "type": "support", "dist": 386, "timesTouched": 0 }
    ],
    "XAU": [
      { "sym": "GLD", "strike": 439, "gamma": 9, "type": "support", "dist": 16, "timesTouched": 2 },
      { "sym": "GLD", "strike": 433, "gamma": 7, "type": "support", "dist": -50, "timesTouched": 0 }
    ]
  },

  // ── LEVELS ──
  "levels": {
    "NAS": { "callWall": 25788, "putWall": 24400, "gammaFlip": 25200, "maxGamma": 25295, "distToFlip": 120 },
    "US30": { "callWall": 49475, "putWall": 47476, "gammaFlip": 48500, "distToFlip": 610 },
    "XAU": { "callWall": 4965, "putWall": 4627, "gammaFlip": 4850, "distToFlip": 87 }
  },

  // ── OPTIONS FLOW ──
  "flow": {
    "pcRatio": { "SPX": 0.8, "QQQ": 1.2, "DIA": 0.9, "GLD": 1.5 },
    "netDeltaToday": { "SPX": -5000000, "QQQ": -35000000, "DIA": 2000000, "GLD": -1000000 },
    "institutional": [
      { "sym": "QQQ", "type": "CALL", "strike": 611, "prem": 709000, "exp": "May15", "sig": "bearish", "delta": -14800000 },
      { "sym": "VIX", "type": "CALL", "strike": 23, "prem": 722000, "exp": "Aug19", "sig": "bearish", "delta": -1500000 }
    ],
    "instCount": 2,
    "retailBias": "bullish",
    "liveFlowBias": "bearish",
    "bullBear": [553995, 355804],
    "premiumTotal": 1086815,
    "openingVsClosing": "closing_dominant",
    "concentratedStrikes": ["SPX6920", "QQQ607", "SPY680"]
  },

  // ── CORRELATIONS (calculated) ──
  "correlations": {
    "nasVsUs30": "diverging",
    "vixVsSpx": "normal",
    "dxyVsXau": "inverse",
    "hiroConvergence": { "bullish": 1, "bearish": 2, "neutral": 5 }
  },

  // ── POSITIONS & ORDERS ──
  "positions": [
    { "cfd": "NAS100", "dir": "SHORT", "entry": 25109, "sl": 25145, "tp": 25005, "pnl": -2.05, "pnlPts": -20, "mode": "intraday", "age_min": 45, "riskPts": 36, "rrCurrent": -0.56 }
  ],
  "ordersActive": 18,
  "nearestOrderDist": { "NAS": 12, "US30": 386, "XAU": 136 },
  "ordersByMode": { "scalp": 2, "intraday": 12, "swing": 4 },

  // ── AGENT META ──
  "cyclesSinceLastTrade": 5,
  "winStreak": 0,
  "lossStreak": 2,
  "dayPnL": -3.55,
  "weekPnL": -50.61,
  "accountBalance": 918.78,
  "accountEquity": 916.73,
  "marginUsed": 12.55,

  // ── MARKET STRUCTURE (classified per CFD) ──
  "marketStructure": { "NAS": "congestion", "US30": "markdown", "XAU": "accumulation" },

  // ── CANDLE PATTERNS (at nearest gamma bars) ──
  "candleAtBar": {
    "SPX6825": "wick_rejection_short",
    "SPY679": "body_through_up",
    "DIA479": "doji"
  }
}
```
This is the COMPLETE market snapshot. ~1200 tokens per entry but enables TRUE backtesting with every data point the agent sees. One entry per FULL cycle only (not brief/flat cycles).

## To Start the Agent
1. Server: `pm2 start ecosystem.config.js` (or `pm2 restart spotgamma`)
2. Build first if code changed: `pnpm run build`
3. Agent: In Claude Code, create a session cron:
```
cron: */1 * * * 0-5
prompt: Run one full SpotGamma trading cycle — ALL 14 checkpoints per CLAUDE.md. Read agent-state.json, fetch all 3 endpoints, execute full checklist. ALWAYS seek new entries near price (L97). Update state and log.
```
