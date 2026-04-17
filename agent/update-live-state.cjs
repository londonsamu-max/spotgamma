/**
 * updateLiveState — llamar al FINAL de cada ciclo de trading
 * Actualiza data/live-state.json con estado fresco y compacto
 *
 * Uso: node agent/update-live-state.js
 * O importar: require('./agent/update-live-state')({ decisions, prices, hiro, ... })
 */

const fs = require('fs');
const path = require('path');

function updateLiveState({ cycle, prices, hiro, regime, marketStructure, gammaBars, thesis, intentions, execution, combinedIntention }) {
  const prevPath = path.join(__dirname, '../data/live-state.json');
  const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')) : {};

  // Mantener solo las 10 active lessons más críticas (no todas las 105)
  const ACTIVE_LESSONS = ['L43', 'L52', 'L60', 'L83', 'L97', 'L102', 'L104', 'L110', 'L111', 'L116'];

  // Construir gamma_context compacto (top 3 bars por CFD)
  const gamma_context = {};
  for (const cfd of ['NAS100', 'US30', 'XAUUSD']) {
    const bars = (gammaBars?.[cfd] || []).slice(0, 3).map(b => ({
      sym: b.sym || b.symbol,
      strike: b.strike,
      gamma: b.gamma,
      type: b.type,
      dist: b.distFromPrice
    }));
    gamma_context[cfd] = { nearest_bars: bars };
  }

  // Limitar intentions a 3-5 más relevantes
  const cleanIntentions = (intentions || []).slice(0, 5).map(i =>
    typeof i === 'string' ? i.slice(0, 100) : JSON.stringify(i).slice(0, 100)
  );

  const newState = {
    cycle: cycle || prev.cycle,
    ts: new Date().toISOString(),
    market_structure: marketStructure || prev.market_structure || {},
    gamma_context,
    hiro: hiro || prev.hiro || {},
    regime: regime || prev.regime || '',
    execution: {
      pending_orders: execution?.pending_orders ?? prev.execution?.pending_orders ?? 0,
      open_positions: execution?.open_positions ?? prev.execution?.open_positions ?? 0,
      balance: execution?.balance ?? prev.execution?.balance ?? null,
      day_pnl: execution?.day_pnl ?? prev.execution?.day_pnl ?? null
    },
    active_lessons: ACTIVE_LESSONS,
    intentions: cleanIntentions,
    thesis: {
      NAS100: thesis?.NAS100 || prev.thesis?.NAS100 || '',
      US30: thesis?.US30 || prev.thesis?.US30 || '',
      XAUUSD: thesis?.XAUUSD || prev.thesis?.XAUUSD || ''
    },
    combined_intention: combinedIntention || prev.combined_intention || ''
  };

  fs.writeFileSync(prevPath, JSON.stringify(newState, null, 2));
  return newState;
}

// Si se ejecuta directamente (node update-live-state.js), reconstruye desde agent-state.json
if (require.main === module) {
  const statePath = path.join(__dirname, '../data/agent-state.json');
  const ordersPath = path.join(__dirname, '../data/agent-orders.json');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const orders = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
  const rc = state.recentCycles || [];
  const last = rc[rc.length - 1] || {};
  const gbs = state.gammaBarsSnapshot || {};
  const flow = state.flowSnapshot || {};

  const setups = Array.isArray(state.preIdentifiedSetups)
    ? state.preIdentifiedSetups
    : Object.values(state.preIdentifiedSetups || {});

  const result = updateLiveState({
    cycle: state.cycleNumber,
    prices: last.prices,
    hiro: last.hiro,
    regime: last.regime,
    marketStructure: last.marketStructure,
    gammaBars: gbs,
    thesis: state.thesis,
    intentions: setups.slice(0, 5).map(s =>
      `${s.direction || '?'} ${s.cfd || '?'} at ${s.triggerLevel || s.exactLevel || '?'}`
    ),
    execution: {
      pending_orders: (orders.pendingOrders || []).length,
      open_positions: (orders.managedPositions || []).length,
      balance: state.performance?.accountBalance || null,
      day_pnl: state.performance?.dayPnL || null
    },
    combinedIntention: flow.combinedIntention?.narrative || ''
  });

  console.log('live-state.json updated:', JSON.stringify(result, null, 2));
}

module.exports = updateLiveState;
