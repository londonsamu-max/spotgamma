const d = JSON.parse(require('fs').readFileSync('data/tmp_agentview.json','utf8')).result.data.json;
const ex = JSON.parse(require('fs').readFileSync('data/tmp_executor.json','utf8')).result.data.json;

console.log('TS:', d.timestamp, '| Mkt:', d.marketStatus, '| Live:', d.marketLive);
for (const c of ['NAS100','US30','XAUUSD']) console.log(c+': price='+d.cfds[c].price+' ratio='+d.cfds[c].conversionRatio.toFixed(4));

// 1 REGIME
console.log('\n=1= REGIME');
for (const c of ['NAS100','US30','XAUUSD']) {
  const r=d.cfds[c].rawLevels; const vrp=r.iv30&&r.rv30?(r.iv30-r.rv30).toFixed(4):'N/A';
  console.log(d.cfds[c].optionsSymbol+': '+r.gammaRegime+' VRP='+vrp+' iv30='+r.iv30+' rv30='+r.rv30+' skew='+r.skew);
}

// 2 HIRO
console.log('\n=2= HIRO');
const allHiro = {};
for (const c of ['NAS100','US30','XAUUSD']) {
  const h=d.cfds[c].hiro;
  if(h) for(const [s,v] of Object.entries(h)) if(!allHiro[s]) { allHiro[s]=v; console.log(s+': P'+v.percentile+' '+v.trend); }
}
for(const [s,v] of Object.entries(d.hiroTrend)) console.log('TREND_'+s+': P'+v.percentile+' '+v.trend+' chg5m='+v.change5m);

// 3 TAPE
console.log('\n=3= TAPE');
const allTape = {};
for (const c of ['NAS100','US30','XAUUSD']) {
  const t=d.cfds[c].tape;
  if(t) for(const [s,v] of Object.entries(t)) {
    if(!allTape[s]) { allTape[s]=1;
      console.log(s+': score='+v.sentimentScore+' '+v.sentiment+' bull%='+v.bullPct+' trades='+v.trades+' cPrem='+v.callPremium+' pPrem='+v.putPremium);
      if(v.largestTrades) v.largestTrades.slice(0,3).forEach(lt=>console.log('  BIG $'+lt.premium+' @'+lt.strike));
      if(v.strikeFlow) v.strikeFlow.slice(0,5).forEach(sf=>console.log('  FLOW '+sf.strike+' c='+sf.callPrem+' p='+sf.putPrem+' '+sf.direction));
    }
  }
}
console.log('Global:', JSON.stringify(d.tapeGlobal));

// 4 LEVELS
console.log('\n=4= LEVELS');
for (const c of ['NAS100','US30','XAUUSD']) {
  const l=d.cfds[c].levels;
  console.log(c+': CW='+l.callWall.toFixed(0)+' PW='+l.putWall.toFixed(0)+' GF='+l.gammaFlip.toFixed(0)+' MaxG='+l.maxGamma.toFixed(0)+' VT='+l.volTrigger.toFixed(0));
}

// 5 GAMMA BARS
console.log('\n=5= GAMMA BARS');
for (const c of ['NAS100','US30','XAUUSD']) {
  const bars=d.cfds[c].gammaBars||[]; const price=d.cfds[c].price;
  console.log(c+' ('+bars.length+' bars, price='+price.toFixed(1)+'):');
  bars.sort((a,b)=>b.cfdPrice-a.cfdPrice).forEach(b=>{
    const dist=(b.cfdPrice-price).toFixed(0);
    const near=Math.abs(b.cfdPrice-price)<150?' <<<':'';
    console.log('  '+b.symbol+' $'+b.strike+' -> '+b.cfdPrice.toFixed(0)+' ('+(dist>0?'+':'')+dist+') g='+(b.gamma/1e6).toFixed(0)+'M net='+(b.netPos?(b.netPos/1e3).toFixed(0)+'K':'0')+' '+b.type+near);
  });
}

// 6 VOL
console.log('\n=6= VOL');
console.log('Regime:',d.vol.regime,'Term:',d.vol.termStructure);
for(const [s,v] of Object.entries(d.vol.perAsset||{})) console.log('  '+s+': iv='+v.atmIV+' '+v.ivLevel+' term='+v.termStructure+' skew='+v.putCallSkew);

// 7 VANNA
console.log('\n=7= VANNA');
console.log('VIX:',d.vanna.vix,'chg:'+d.vanna.vixChangePct?.toFixed(2)+'%','idxVanna:'+d.vanna.indexVannaActive,'refuge:'+d.vanna.refugeFlowActive);
console.log('Div:',d.vanna.uvixGldDivergence?.signal,d.vanna.uvixGldDivergence?.strength);
console.log('Det:',d.vannaDetailed?.vixVannaSignal,d.vannaDetailed?.vixVannaStrength,'gld:'+d.vannaDetailed?.gldVannaSignal);

// 8 GEX
console.log('\n=8= GEX');
for(const [s,g] of Object.entries(d.gammaBreakdown)) console.log(s+': tot='+(g.totalGamma/1e9).toFixed(1)+'B call='+(g.callGamma/1e9).toFixed(1)+'B put='+(g.putGamma/1e9).toFixed(1)+'B 0dte='+(g.zeroDteGamma/1e9).toFixed(1)+'B flip='+g.gammaFlipLevel);

// 9 0DTE
console.log('\n=9= 0DTE');
console.log('Bias:',d.odte.bias,'Ratio:',d.odte.gexRatio?.toFixed(2),'MaxGEX:',d.odte.maxGexStrike,'NAS:',d.odte.maxGexStrike_nas100,'HW:',d.odte.hedgeWall);
if(d.odte.support) console.log('Supp:',d.odte.support.map(s=>s.price+'('+(s.gamma/1e6).toFixed(0)+'M)').join(' '));
if(d.odte.resistance) console.log('Res:',d.odte.resistance.map(s=>s.price+'('+(s.gamma/1e6).toFixed(0)+'M)').join(' '));

// 10 FLOW
console.log('\n=10= FLOW');
for(const sym of ['SPX','QQQ','DIA','GLD']) {
  const of2=d.optionsFlow[sym]||{};
  console.log(sym+': cVol='+of2.callVolume+' pVol='+of2.putVolume+' P/C='+of2.putCallRatio+' VRP='+of2.vrp);
  if(of2.topPositions) of2.topPositions.slice(0,5).forEach(p=>console.log('  '+p.strike+' net='+p.netTotal+' '+p.interpretation));
}
console.log('\nInst:', JSON.stringify(d.institutionalFlow.breakdown));
(d.institutionalFlow.bigTrades||[]).forEach(t=>{
  console.log('BIG '+t.time?.substring(11,19)+' '+t.symbol+' '+t.callPut+' '+t.strike+' '+t.expiration?.substring(0,10)+' '+t.buySell+' $'+t.premium+' d='+(t.delta/1e6).toFixed(1)+'M '+t.signal+' ['+t.category+']'+(t.is0DTE?' 0DTE':''));
});
console.log('\nLive: tot='+d.liveFlow.alertsTotal+' 5m='+d.liveFlow.alertsLast5min+' 1m='+d.liveFlow.alertsLast1min);
console.log('5min:', JSON.stringify(d.liveFlow.last5min));
const alerts=d.liveFlow.recentAlerts||[];
if(alerts.length){console.log('Recent('+alerts.length+'):');
  alerts.slice(0,20).forEach(a=>console.log('  '+a.time?.substring(11,19)+' '+a.symbol+' '+a.callPut+' '+a.strike+' '+a.expiration?.substring(0,10)+' '+a.buySell+' $'+a.premium+' d='+(a.delta/1e6).toFixed(2)+'M '+a.signal+(a.is0DTE?' 0DTE':'')));
}

// TOP STRIKES
console.log('\nTOP STRIKES');
for(const c of ['NAS100','US30','XAUUSD']){const ts=d.cfds[c].topStrikes||[];
  if(ts.length){console.log(c+':');ts.forEach(s=>console.log('  cfd='+s.cfdPrice?.toFixed(0)+' g='+(s.gamma/1e6).toFixed(0)+'M oi='+s.oi+' net='+s.netPos));}}

// 11 PA
console.log('\n=11= PA');
for(const c of ['NAS100','US30','XAUUSD','VIX']){const pa=d.priceAction[c];
  console.log(c+': '+pa.current+' hi='+pa.sessionHigh+' lo='+pa.sessionLow+' rng='+pa.sessionRange+' trnd='+pa.recentTrend+' m5='+pa.momentum5m+' m1h='+pa.momentum1h);}
console.log('Candles:', JSON.stringify(d.candleSignals));

// 12 MACRO
console.log('\n=12= MACRO');
console.log('DXY:',d.macro.dxy,'TLT:',d.macro.tlt);
d.calendar.filter(e=>e.hoursUntil>-1&&e.hoursUntil<25).forEach(e=>console.log('  '+e.time+' '+e.event+' ['+e.impact+'] '+e.hoursUntil?.toFixed(1)+'h '+e.warning));

// 13 BROKER
console.log('\n=13= BROKER');
console.log('MT5:',d.mt5.connected,'Bal:',d.mt5.balance,'Eq:',d.mt5.equity,'Margin:',d.mt5.margin);
for(const s of ['NAS100','US30','XAUUSD']){const p=d.mt5.prices[s];console.log('  '+s+': bid='+p.bid+' ask='+p.ask+' spr='+(p.ask-p.bid).toFixed(2));}
console.log('Positions:',d.mt5.positions?.length||0);
if(d.mt5.positions?.length) d.mt5.positions.forEach(p=>console.log('  '+JSON.stringify(p)));

// EXECUTOR
console.log('\nEXEC pending:',ex.pendingOrders?.length||0,'managed:',ex.managedPositions?.length||0);
(ex.pendingOrders||[]).forEach(o=>console.log('  '+o.id+' '+o.direction+' exact='+o.exactLevel+' zone=['+o.entryZone+'] sl='+o.sl+' tp1='+o.tp1+' '+o.entryMode+' '+o.status+' exp='+o.expiresAt));
(ex.managedPositions||[]).forEach(p=>console.log('  MGD:'+JSON.stringify(p)));

console.log('\nVIX-SPX:',JSON.stringify(d.vixSpxCorrelation));
