/* ══════════════════════════════════════════════════════════════════════
   MISSION CONTROL — frontend for the autonomous portfolio-impact agent.
   Consumes CONTRACTS.md §1 events over SSE (/api/stream), or a canned
   replay with ?demo=1.

   Performance contract:
     · animate transform / opacity ONLY
     · slipstream capped at MAX_SLIP live nodes, removed on animationend
     · rail capped at MAX_ROWS, oldest dropped
   ══════════════════════════════════════════════════════════════════════ */
(() => {
'use strict';

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const Q  = new URLSearchParams(location.search);
const DEMO  = Q.get('demo') === '1';
const SPEED = Math.max(0.15, parseFloat(Q.get('speed') || '1'));

const MAX_ROWS = 40;
const MAX_SLIP = 30;
const BODY_LINES = 12;

/* ─────────────────────────── stage scaling ─────────────────────────── */
const stage = $('#stage');
function fit(){
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform =
    `translate3d(${Math.round((innerWidth - 1920 * s) / 2)}px,${Math.round((innerHeight - 1080 * s) / 2)}px,0) scale(${s})`;
}
addEventListener('resize', fit); fit();

/* ─────────────────────────── shared state ──────────────────────────── */
const S = {
  t0: null, elapsed: 0, tokens: 0, lastTok: 0,
  attempt: 1, maxAttempts: 4, phase: 'idle',
  logLines: 0, credits: 1000, burn: [], accepted: false,
  portfolio: null, headlines: [], seenSearch: new Set(), tally: {},
};

/* token counter is monotonic: whichever is larger, the authoritative
   state.tokens_total or the running sum of per-tool token costs.
   `force` is the escape hatch resetRun() uses to start a second run. */
function setTokens(n, force){
  if(!force && !(n > S.tokens)) return;
  S.tokens = n;
  $('#sTok').textContent = fmtTok(n) + ' tok';
  setCredits(CREDITS_MAX - n / 12, force);
}

/* create-element helper — every builder below uses it */
function el(tag, cls, html){
  const n = document.createElement(tag);
  if(cls) n.className = cls;
  if(html != null) n.innerHTML = html;
  return n;
}
const CREDITS_MAX = 1000;

const fmtMS   = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const fmtTok  = n => n >= 1000 ? (n/1000).toFixed(1) + 'k' : String(n|0);
const fmtUSD  = n => (n<0?'-':'') + '$' + Math.abs(n).toLocaleString('en-US',{maximumFractionDigits:0});
const fmtPct  = n => (n>0?'+':'') + Number(n).toFixed(2) + '%';
const esc     = t => String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/* ══════════════════════════ LEFT · TREEMAP ══════════════════════════ */
let chart = null, tmData = [], maxAbs = 1;
const NEUTRAL = '#3f4152';

function rich(darkText){
  const c1 = darkText ? '#11111b' : '#cdd6f4';
  const c2 = darkText ? 'rgba(17,17,27,.68)' : 'rgba(205,214,244,.58)';
  return {
    t:{fontSize:25,fontWeight:'bold',fontFamily:'JetBrains Mono,monospace',color:c1,lineHeight:28},
    w:{fontSize:17,fontFamily:'JetBrains Mono,monospace',color:c2,lineHeight:22},
    i:{fontSize:21,fontWeight:'bold',fontFamily:'JetBrains Mono,monospace',color:c1,lineHeight:24}
  };
}
function impactColor(v){
  const t = Math.min(1, Math.abs(v) / (maxAbs || 1));
  return v < 0 ? `hsl(343,72%,${(73 - 24*t).toFixed(0)}%)`
               : `hsl(115,52%,${(75 - 20*t).toFixed(0)}%)`;
}

function initTreemap(pf){
  S.portfolio = pf;
  $('#pfMeta').textContent = `${pf.positions.length} holdings`;
  $('#totBefore').textContent = fmtUSD(pf.total_value_usd);
  tmData = pf.positions.map(p => ({
    name: p.ticker, value: p.weight_pct,
    weight: p.weight_pct, imp: null, sector: p.sector,
    itemStyle:{ color: NEUTRAL },
    label:{ rich: rich(false) }
  }));
  chart = echarts.init($('#treemap'), null, {renderer:'canvas'});
  paint(false);
}

function paint(anim){
  if(!chart) return;
  chart.setOption({
    animation:true, animationDuration: anim ? 620 : 320,
    animationEasing:'cubicOut',
    tooltip:{show:false},
    series:[{
      type:'treemap', roam:false, nodeClick:false, breadcrumb:{show:false},
      left:0, top:0, right:0, bottom:0, width:'100%', height:'100%',
      itemStyle:{ borderColor:'#1e1e2e', borderWidth:3, gapWidth:3, borderRadius:8 },
      upperLabel:{show:false},
      emphasis:{disabled:true},
      label:{
        show:true, position:'insideTopLeft', padding:[7,0,0,11], overflow:'truncate',
        /* area already encodes weight — once we have an impact, that is the
           second line instead, so narrow cells never truncate. */
        formatter: p => `{t|${p.name}}\n` + (p.data.imp == null
          ? `{w|${p.data.weight.toFixed(1)}%}`
          : `{i|${fmtPct(p.data.imp)}}`)
      },
      data: tmData
    }]
  });
}

/* staggered recolour on the final result */
function repaintTreemap(res){
  const by = {};
  (res.positions || []).forEach(p => by[p.ticker] = p);
  maxAbs = Math.max(0.01, ...Object.values(by).map(p => Math.abs(p.impact_pct || 0)));

  const order = tmData.map((d,i)=>i).sort((a,b) =>
    Math.abs((by[tmData[b].name]||{}).impact_pct||0) - Math.abs((by[tmData[a].name]||{}).impact_pct||0));

  order.forEach((idx, n) => setTimeout(() => {
    const p = by[tmData[idx].name]; if(!p) return;
    tmData[idx].imp = p.impact_pct;
    tmData[idx].itemStyle = { color: impactColor(p.impact_pct) };
    tmData[idx].label = { rich: rich(true) };
    paint(true);
  }, 220 + n * 115));

  const before = res.portfolio_value_before_usd ?? (S.portfolio ? S.portfolio.total_value_usd : 0);
  const dUsd = res.portfolio_impact_usd ?? 0, dPct = res.portfolio_impact_pct ?? 0;
  setTimeout(() => {
    $('#totBefore').textContent = fmtUSD(before);
    $('#totAfter').textContent  = fmtUSD(before + dUsd);
    const d = $('#totDelta');
    d.className = 'totdelta on ' + (dPct < 0 ? 'neg' : 'pos');
    d.textContent = `${fmtPct(dPct)}   ${dUsd<0?'−':'+'}${fmtUSD(Math.abs(dUsd)).replace('$','$')}`;
    $('#totAfter').style.color = dPct < 0 ? 'var(--red)' : 'var(--green)';
  }, 260 + tmData.length * 115);
}

/* ═══════════════════════ CENTRE · STATUS STRIP ══════════════════════ */
const PHASE = {
  spawning : ['SPAWNING',  'ver'],
  running  : ['RUNNING',   'run'],
  verifying: ['VERIFYING', 'ver'],
  rejected : ['REJECTED',  'bad'],
  accepted : ['ACCEPTED',  'good'],
  destroyed: ['DESTROYED', 'dead'],
};
function setPhase(p){
  S.phase = p;
  const [txt, cls] = PHASE[p] || [String(p).toUpperCase(), 'run'];
  $('#sPhaseTxt').textContent = txt;
  $('#sPhase').className = 'sPhase ' + cls;
}

/* token burn sparkline */
const sparkCtx = $('#spark').getContext('2d');
sparkCtx.scale(2,2);
function drawSpark(){
  const w = 180, h = 30, b = S.burn;
  sparkCtx.clearRect(0,0,w,h);
  if(b.length < 2) return;
  const mx = Math.max(1, ...b);
  const step = w / (b.length - 1);
  sparkCtx.beginPath();
  b.forEach((v,i) => {
    const x = i*step, y = h - 2 - (v/mx)*(h-5);
    i ? sparkCtx.lineTo(x,y) : sparkCtx.moveTo(x,y);
  });
  sparkCtx.strokeStyle = '#89dceb'; sparkCtx.lineWidth = 1.6;
  sparkCtx.lineJoin = 'round'; sparkCtx.stroke();
  sparkCtx.lineTo(w, h); sparkCtx.lineTo(0, h); sparkCtx.closePath();
  sparkCtx.fillStyle = 'rgba(137,220,235,.20)'; sparkCtx.fill();
}
setInterval(() => {
  S.burn.push(Math.max(0, S.tokens - S.lastTok));
  S.lastTok = S.tokens;
  if(S.burn.length > 46) S.burn.shift();
  drawSpark();
}, 600);

/* ═══════════════════════════ THE RAIL ═══════════════════════════════ */
const rail = $('#rail'), railWrap = $('#railWrap');
const ICON = {THOUGHT:'◇', SEARCH:'⌕', WRITE:'◉', RUN:'▶', EMIT:'⬢', SYSTEM:'⚙'};
const VERB = {THOUGHT:'THOUGHT', SEARCH:'SEARCH', WRITE:'WROTE', RUN:'RAN', EMIT:'EMIT', SYSTEM:'SYS'};
const MARK = {running:'◐', ok:'✓', fail:'✗'};
const rowsById = new Map();
let openRow = null, typer = null;

function scrollRail(){
  const y = Math.max(0, rail.offsetHeight + 24 - railWrap.clientHeight);
  rail.style.transform = `translate3d(0,${-y}px,0)`;
}

function collapseOpen(){
  if(typer){ clearInterval(typer.h); typer.finish(); typer = null; }
  if(openRow){ openRow.classList.remove('open'); openRow.classList.add('dim'); openRow = null; }
}

function onTool(ev){
  $('#railHint').classList.add('gone');
  const kind = ICON[ev.kind] ? ev.kind : 'SYSTEM';

  /* upsert by id — a running row can be completed later */
  let row = ev.id ? rowsById.get(ev.id) : null;
  const fresh = !row;
  if(fresh){
    collapseOpen();
    row = document.createElement('div');
    row.className = 'row k-' + kind;
    row.innerHTML =
      `<div class="rowhead">
         <span class="ic"></span><span class="kind"></span>
         <span class="label"></span><span class="detail"></span>
         <span class="grow"></span>
         <span class="meta tok"></span><span class="meta ms"></span><span class="st"></span>
       </div>
       <div class="rowbody"><pre></pre></div>`;
    rail.appendChild(row);
    if(ev.id) rowsById.set(ev.id, row);
    while(rail.children.length > MAX_ROWS){
      const dead = rail.firstElementChild;
      for(const [k,v] of rowsById) if(v === dead) rowsById.delete(k);
      dead.remove();
    }
  }

  row.dataset.status = ev.status || 'ok';
  row.className = 'row k-' + kind +
    (row.classList.contains('open') ? ' open' : '') +
    (row.classList.contains('dim')  ? ' dim'  : '');
  if(ev.status === 'fail') row.classList.add('fail');

  row.querySelector('.ic').textContent     = ICON[kind];
  row.querySelector('.kind').textContent   = VERB[kind];
  row.querySelector('.label').textContent  = ev.label || '';
  row.querySelector('.detail').textContent = ev.detail || '';
  row.querySelector('.tok').textContent    = ev.tokens ? fmtTok(ev.tokens) + ' tok' : '';
  row.querySelector('.ms').textContent     = ev.ms ? ev.ms + 'ms' : '';
  row.querySelector('.st').textContent     = MARK[ev.status] || '✓';

  if(ev.tokens){
    S.tally[ev.id || ('_' + rail.children.length)] = ev.tokens;
    setTokens(Object.values(S.tally).reduce((a,b) => a + b, 0));
  }

  if(ev.body){
    if(openRow && openRow !== row) collapseOpen();
    row.classList.remove('dim'); row.classList.add('open');
    openRow = row;
    startBody(row, kind, String(ev.body));
  }
  requestAnimationFrame(scrollRail);
}

/* ── typewriter + cheap syntax colouring ───────────────────────────── */
const KW = /(#[^\n]*)|('[^'\n]*'|"[^"\n]*"|`[^`\n]*`)|\b(def|class|import|from|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|with|as|try|except|finally|raise|lambda|yield|assert|async|await|pass|break|continue|print|self)\b|\b(-?\d+\.?\d*)\b/g;
function hl(txt){
  return esc(txt).replace(KW, (m,c,s,k,n) =>
    c ? `<span class="t-com">${c}</span>` :
    s ? `<span class="t-str">${s}</span>` :
    k ? `<span class="t-kw">${k}</span>` :
        `<span class="t-num">${n}</span>`);
}

function startBody(row, kind, body){
  const lines = body.replace(/\s+$/,'').split('\n');
  const shown = lines.slice(0, BODY_LINES).join('\n');
  const extra = Math.max(0, lines.length - BODY_LINES);
  const pre   = row.querySelector('pre');
  const code  = kind === 'WRITE';

  const render = (txt, caret) => {
    pre.innerHTML = (code ? hl(txt) : esc(txt)) + (caret ? '<span class="caret"></span>' : '');
  };
  const finish = () => {
    render(shown, false);
    if(extra){
      const m = document.createElement('span');
      m.className = 'more'; m.textContent = `… +${extra} more lines`;
      pre.parentNode.appendChild(m);
    }
    requestAnimationFrame(scrollRail);
  };
  const old = row.querySelector('.more'); if(old) old.remove();

  if(!shown.length){ finish(); return; }

  let i = 0;
  const per = Math.max(2, Math.ceil(shown.length / 55)); // ~1s of typing regardless of size
  const h = setInterval(() => {
    i += per;
    if(i >= shown.length){ clearInterval(h); typer = null; finish(); return; }
    render(shown.slice(0, i), true);
    if(i % (per*6) < per) scrollRail();
  }, 26 / SPEED);
  typer = {h, finish};
}

/* ══════════════════════ THE SLIPSTREAM ═════════════════════════════ */
const slip = $('#slip');
const live = [];
const BAD = /Traceback|Error|Exception|FAILED|CRITICAL|refus/i;

function onLog(ev){
  S.logLines++;
  const txt = String(ev.text || '').replace(/\s+$/,'').slice(0, 96);
  if(!txt) return;

  const el = document.createElement('div');
  el.className = 'slipline ' + (BAD.test(txt) ? 's-bad' : (ev.stream === 'stderr' ? 's-err' : 's-out'));
  el.textContent = txt;
  el.style.left   = (20 + Math.random()*430) + 'px';
  el.style.bottom = (18 + Math.random()*300) + 'px';
  el.style.animationDuration = (760 + Math.random()*180) + 'ms';
  el.addEventListener('animationend', () => {
    el.remove();
    const i = live.indexOf(el); if(i >= 0) live.splice(i,1);
  }, {once:true});

  slip.appendChild(el); live.push(el);
  while(live.length > MAX_SLIP) live.shift().remove();
}

/* ════════════════════════ RIGHT · THE JUDGE ════════════════════════ */
const SEED = [
  ['V1','schema valid'], ['V2','tickers ⊆ portfolio'], ['V3','positions reconcile'],
  ['V4','impact_usd consistent'], ['V5','ranges & enums sane'], ['V6','verifier hash unchanged'],
];
const checkEls = new Map();
function initChecks(){
  const box = $('#checks'); box.innerHTML = '';
  SEED.forEach(([id, name]) => {
    const el = document.createElement('div');
    el.className = 'chk';
    el.innerHTML = `<span class="cid">${id}</span><span class="cname">${name}</span><span class="cmark">·</span>`;
    box.appendChild(el); checkEls.set(id, el);
  });
}
initChecks();

function onVerdict(v){
  const checks = v.checks || [];
  checks.forEach((c, i) => setTimeout(() => {
    let el = checkEls.get(c.id);
    if(!el){
      el = document.createElement('div'); el.className = 'chk';
      el.innerHTML = `<span class="cid">${c.id}</span><span class="cname"></span><span class="cmark">·</span>`;
      $('#checks').appendChild(el); checkEls.set(c.id, el);
    }
    el.className = 'chk tick ' + (c.passed ? 'pass' : 'fail');
    el.querySelector('.cname').textContent = c.name || c.id;
    el.querySelector('.cmark').textContent = c.passed ? '✓' : '✗';
    if(!c.passed && c.message) el.title = c.message;
  }, i * 170));

  const dwell = checks.length * 170 + 260;
  setTimeout(() => {
    const st = $('#stamp'), attempt = v.attempt || S.attempt;
    st.className = v.passed ? 'acc' : 'rej';
    $('#stampTop').textContent = `ATTEMPT ${attempt} — ${v.passed ? 'ACCEPTED' : 'REJECTED'}`;

    const bad = checks.find(c => !c.passed);
    $('#stampMsg').textContent = v.passed
      ? `all ${checks.length || 6} checks green · analysis is arithmetically sound`
      : (bad ? `${bad.id} ${bad.name}: ${bad.message || 'failed'}` : 'verification failed');

    const r = $('#stampRoute');
    if(!v.passed && v.route){ r.hidden = false; r.textContent = '↻ ' + v.route; }
    else r.hidden = true;

    const flash = $('#flash');
    flash.className = v.passed ? 'on ok' : 'on';
    setTimeout(() => flash.className = '', 700);

    if(v.passed){ S.accepted = true; burst(); markPips(); }
    else {
      const g = $('#grid');
      g.classList.remove('shake'); void g.offsetWidth; g.classList.add('shake');
      setTimeout(() => g.classList.remove('shake'), 700);
    }
  }, dwell);
}

function burst(){
  if(typeof confetti !== 'function') return;
  const shoot = (x, ang) => confetti({
    particleCount: 90, spread: 74, startVelocity: 52, ticks: 220, angle: ang,
    origin: {x, y: 0.62}, scalar: 1.25, disableForReducedMotion: false,
    colors: ['#a6e3a1','#89dceb','#cba6f7','#f9e2af','#89b4fa']
  });
  shoot(0.80, 100); setTimeout(() => shoot(0.68, 70), 140); setTimeout(() => shoot(0.88, 115), 280);
}

/* ═══════════════════════════ HUD ═══════════════════════════════════ */
function buildPips(n){
  const box = $('#pips'); box.innerHTML = '';
  for(let i=0;i<n;i++){ const d = document.createElement('div'); d.className='pip'; box.appendChild(d); }
  markPips();
}
function markPips(){
  $$('#pips .pip').forEach((p,i) => {
    p.className = 'pip' +
      (i < S.attempt - 1 ? ' done' :
       i === S.attempt - 1 ? (S.accepted ? ' win' : ' cur') : '');
  });
}
buildPips(4);

const SEGS = 20;
(() => { const b = $('#credBar'); for(let i=0;i<SEGS;i++){ const s=document.createElement('div'); s.className='cseg'; b.appendChild(s);} })();
function setCredits(c, force){
  // drains only, unless a new run explicitly resets it
  S.credits = force ? Math.max(0, Math.round(c))
                    : Math.max(0, Math.min(S.credits, Math.round(c)));
  $('#credNum').textContent = S.credits;
  const on = Math.ceil(SEGS * S.credits / CREDITS_MAX);
  const cls = S.credits < CREDITS_MAX*0.2 ? 'crit' : S.credits < CREDITS_MAX*0.45 ? 'warn' : '';
  $$('#credBar .cseg').forEach((s,i) => s.className = 'cseg ' + cls + (i < on ? '' : ' off'));
}
setCredits(CREDITS_MAX);

const BASE_NEWS = [
  'BREAKING · Commerce Dept. widens advanced-node export controls to two additional fabs',
  'Semis lead pre-market decline · SOX futures −3.1%',
  'Analysts flag second-order exposure across hyperscaler capex',
  'Energy and managed care bid as rotation defensive',
];
/* headline wire — adoptNews() (run controls, below) swaps in the real
   /api/news events when they arrive and re-renders. */
let NEWS = BASE_NEWS;

function renderTicker(){
  const items = S.headlines.concat(NEWS);
  const one = items.map((h,i) =>
    `<span class="${i < S.headlines.length ? 'hl' : ''}">${esc(h)}</span>`).join('<span class="dot">◆</span>');
  $('#tickInner').innerHTML = one + '<span class="dot">◆</span>' + one + '<span class="dot">◆</span>';
}
renderTicker();

setInterval(() => {
  if(S.t0 && S.phase !== 'destroyed') S.elapsed = (Date.now() - S.t0) / 1000;
  const t = fmtMS(S.elapsed);
  $('#sClock').textContent = t; $('#hudClock').textContent = t;
}, 120);

/* ═══════════════════════ EVENT DISPATCH ════════════════════════════ */
function onState(ev){
  if(S.t0 === null) S.t0 = Date.now();
  if(ev.model)  $('#sModel').textContent  = ev.model;
  if(ev.effort) $('#sEffort').textContent = ev.effort;
  if(ev.max_attempts && ev.max_attempts !== S.maxAttempts){
    S.maxAttempts = ev.max_attempts; buildPips(S.maxAttempts);
  }
  if(ev.attempt){ S.attempt = ev.attempt; $('#sAttempt').textContent = 'ATTEMPT ' + ev.attempt; markPips(); }
  if(typeof ev.elapsed_s === 'number'){ S.elapsed = ev.elapsed_s; S.t0 = Date.now() - ev.elapsed_s*1000; }
  if(typeof ev.tokens_total === 'number') setTokens(ev.tokens_total);
  if(ev.phase){
    setPhase(ev.phase);
    if(ev.phase === 'destroyed') tombstone(ev);
    // the run is over — hand the RUN button back
    if(/^(destroyed|accepted|error)$/.test(ev.phase)) setRunning(false);
    else setRunning(true);
    if(ev.phase === 'error' && ev.message) toast(String(ev.message).slice(0, 90));
  }
}

function tombstone(ev){
  collapseOpen();
  $('#tombLines').textContent = S.logLines.toLocaleString('en-US');
  $('#tombMeta').textContent =
    `${S.attempt} attempt${S.attempt>1?'s':''} · ${fmtTok(S.tokens)} tokens · ${fmtMS(S.elapsed)} wall clock · ` +
    (S.accepted ? 'analysis ACCEPTED' : 'no accepted analysis');
  $('#tomb').hidden = false;
  $$('#slip .slipline').forEach(n => n.remove()); live.length = 0;
}

function onResult(ev){
  const d = ev.data || {};
  if(d.headline && !S.headlines.includes(d.headline)){ S.headlines.unshift(d.headline); renderTicker(); }
  if(d.positions) repaintTreemap(d);
  if(d.budget && typeof d.budget.codex_credits_used === 'number')
    setCredits(CREDITS_MAX - d.budget.codex_credits_used);
  $('#judgeSub').textContent = d.methodology ? d.methodology.replace(/_/g,' ') : 'deterministic verifier';

  /* ACT II — after the stamp, the confetti and the treemap recolour have all
     landed (repaintTreemap needs ~2.0s: 115ms stagger + tail). */
  S.lastResult = d;
  clearTimeout(S.actTimer);
  S.actTimer = setTimeout(() => openAct2(d), 2600 / SPEED);
}

function handle(ev){
  if(!ev || !ev.type) return;
  try{
    switch(ev.type){
      case 'tool':    onTool(ev); break;
      case 'log':     onLog(ev); break;
      case 'state':   onState(ev); break;
      case 'verdict': onVerdict(ev); break;
      case 'result':  onResult(ev); break;
    }
    if(ev.type === 'tool' && ev.kind === 'SEARCH' && ev.label && !S.seenSearch.has(ev.label)){
      S.seenSearch.add(ev.label);
      if(S.headlines.length < 3){ S.headlines.push(ev.label); renderTicker(); }
    }
  }catch(err){ console.error('handle', ev.type, err); }
}

/* ══════════════════════ PORTFOLIO BOOTSTRAP ════════════════════════ */
/* mirrors data/portfolio.json so the UI is correct with no backend */
const FALLBACK = {
  total_value_usd: 100000,
  positions: [
    {ticker:'AAPL', name:'Apple Inc.',              sector:'Technology Hardware', value_usd:15040, weight_pct:15.04},
    {ticker:'NVDA', name:'NVIDIA Corporation',      sector:'Semiconductors',      value_usd:14000, weight_pct:14.00},
    {ticker:'MSFT', name:'Microsoft Corporation',   sector:'Software',            value_usd:12600, weight_pct:12.60},
    {ticker:'AVGO', name:'Broadcom Inc.',           sector:'Semiconductors',      value_usd:10200, weight_pct:10.20},
    {ticker:'JPM',  name:'JPMorgan Chase & Co.',    sector:'Financials',          value_usd:10080, weight_pct:10.08},
    {ticker:'XOM',  name:'Exxon Mobil Corporation', sector:'Energy',              value_usd:8000,  weight_pct:8.00},
    {ticker:'WMT',  name:'Walmart Inc.',            sector:'Consumer Staples',    value_usd:8000,  weight_pct:8.00},
    {ticker:'JNJ',  name:'Johnson & Johnson',       sector:'Health Care',         value_usd:7920,  weight_pct:7.92},
    {ticker:'CAT',  name:'Caterpillar Inc.',        sector:'Industrials',         value_usd:7120,  weight_pct:7.12},
    {ticker:'NEE',  name:'NextEra Energy, Inc.',    sector:'Utilities',           value_usd:7040,  weight_pct:7.04},
  ]
};

fetch('/api/portfolio')
  .then(r => r.ok ? r.json() : Promise.reject(r.status))
  .then(pf => initTreemap(pf && pf.positions ? pf : FALLBACK))
  .catch(() => initTreemap(FALLBACK))
  .then(() => { if(DEMO) runDemo(); else connect(); });

addEventListener('resize', () => chart && chart.resize());

/* ═══════════════════════════ LIVE SSE ══════════════════════════════ */
function connect(){
  let es;
  try{ es = new EventSource('/api/stream'); }
  catch(e){ return; }
  es.onmessage = e => { try{ handle(JSON.parse(e.data)); }catch(_){} };
  ['tool','log','state','verdict','result'].forEach(n =>
    es.addEventListener(n, e => { try{ const o = JSON.parse(e.data); handle(o.type ? o : {type:n, ...o}); }catch(_){} }));
  es.onerror = () => {
    if(es.readyState === EventSource.CLOSED)
      $('#railHint').textContent = 'stream closed · reload to reconnect';
  };
  setTimeout(() => {
    if(!S.t0) $('#railHint').textContent = 'waiting for /api/stream …  (try ?demo=1)';
  }, 3500);
}

/* ══════════════════════════ DEMO REPLAY ════════════════════════════ */
const CODE = `import json, math
from pathlib import Path

PF    = json.loads(Path("/work/portfolio.json").read_text())
BETA  = json.loads(Path("/work/kit/sector_beta.json").read_text())
SHOCK = {"Semiconductors": -8.0, "Technology": -2.0,
         "Consumer Discretionary": -3.0, "Energy": 1.5}

def impact(pos):
    # beta-weighted sector shock, clipped to schema range
    b = BETA.get(pos["sector"], 0.55)
    s = SHOCK.get(pos["sector"], 0.0)
    return max(-25.0, min(25.0, round(b * s, 2)))

rows = []
for p in PF["positions"]:
    ip = impact(p)
    rows.append({"ticker": p["ticker"], "sector": p["sector"],
                 "weight_pct": p["weight_pct"],
                 "value_before_usd": p["value_usd"],
                 "impact_pct": ip,
                 "impact_usd": round(p["value_usd"] * ip / 100, 2)})

total_pct = sum(r["weight_pct"] / 100 * r["impact_pct"] for r in rows)
total_usd = sum(r["impact_usd"] for r in rows)
print(f"portfolio_impact_pct = {total_pct:.4f}")
print(f"portfolio_impact_usd = {total_usd:.2f}")
Path("/work/result.json").write_text(json.dumps(payload, indent=2))`;

const RUNOUT = `$ python /work/analysis.py
loaded 10 positions · $100,000.00 notional
sector betas resolved from /work/kit/sector_beta.json
applying beta_weighted_shock across 6 sectors
portfolio_impact_pct = -1.6655
portfolio_impact_usd = -1665.50
wrote /work/result.json (4.2 KB)`;

const FIXOUT = `re-deriving declared aggregate from position rows
  Σ(weight_pct/100 × impact_pct) = -1.665500
  previously declared            = -2.100000
  delta                          =  0.434500   ← V3 breach
patched portfolio_impact_pct -> -1.67
patched portfolio_impact_usd -> -1665.50
re-emitting /work/result.json`;

/* Canned payload — schema-valid against verifier/impact.schema.json and it
   genuinely reconciles: Sigma(w/100 x impact) = -1.80696 -> declared -1.81
   (drift 0.003 < the 0.01 V3 tolerance), and every impact_usd is exact.
   Swapped for data/golden_result.json at boot when that file exists. */
let RESULT = {
  news_id: 'evt-taiwan-quake',
  headline: 'Magnitude 7.1 earthquake near Hsinchu halts TSMC leading-edge fabs; advanced packaging lines offline',
  published_at: '2026-08-28T01:40:00Z',
  thesis: 'A 5-to-10 day outage at TSMC leading-edge and CoWoS advanced-packaging capacity binds the single-source bottleneck for AI accelerator assembly. The book takes concentrated damage through its semiconductor weight, a second-order drag on hyperscaler capacity build, and a partial offset from a defensive rotation into staples, health care and financials.',
  methodology: 'beta_weighted_shock',
  confidence: 0.74,
  mechanism: [
    {from:'M7.1 Hsinchu quake',      to:'TSMC leading-edge fabs', effect:'Fab 12, 18 and 20 evacuated; N3/N2 wafer starts idled'},
    {from:'TSMC leading-edge fabs',  to:'CoWoS packaging',        effect:'advanced packaging offline an estimated 5-10 days'},
    {from:'CoWoS packaging',         to:'NVDA/AVGO',              effect:'accelerator assembly is single-sourced on this line'},
    {from:'TSMC leading-edge fabs',  to:'AAPL',                   effect:'N3 capacity for A-series slips roughly one quarter'},
    {from:'NVDA/AVGO',               to:'MSFT',                   effect:'Azure AI capacity build defers with accelerator supply'},
    {from:'risk-off rotation',       to:'JNJ/WMT/JPM',            effect:'defensive, staples and rate-sensitive bid'},
  ],
  positions: [
    {ticker:'NVDA', sector:'Semiconductors',      weight_pct:14.00, value_before_usd:14000, impact_pct:-6.80, impact_usd:-952.00, confidence:0.81, rationale:'CoWoS advanced packaging is the binding constraint on accelerator assembly and is single-sourced at the affected Hsinchu lines; a 5-10 day halt pushes a quarter of H200-class shipments right.'},
    {ticker:'AVGO', sector:'Semiconductors',      weight_pct:10.20, value_before_usd:10200, impact_pct:-4.20, impact_usd:-428.40, confidence:0.72, rationale:'Custom AI ASIC programmes share the same leading-edge node and packaging queue; networking silicon is less exposed, which caps the drawdown below NVDA.'},
    {ticker:'AAPL', sector:'Technology Hardware', weight_pct:15.04, value_before_usd:15040, impact_pct:-2.40, impact_usd:-360.96, confidence:0.68, rationale:'Apple is the largest N3 customer by volume and builds inventory ahead of the autumn cycle, so a sub-two-week outage delays rather than destroys units.'},
    {ticker:'MSFT', sector:'Software',            weight_pct:12.60, value_before_usd:12600, impact_pct:-1.10, impact_usd:-138.60, confidence:0.59, rationale:'Second-order only: Azure AI capacity additions track accelerator deliveries, deferring revenue recognition without impairing the installed base.'},
    {ticker:'CAT',  sector:'Industrials',         weight_pct: 7.12, value_before_usd: 7120, impact_pct:-0.30, impact_usd: -21.36, confidence:0.41, rationale:'Marginal drag from a broad industrial risk-off move; no direct semiconductor supply-chain exposure in the machinery franchise.'},
    {ticker:'JNJ',  sector:'Health Care',         weight_pct: 7.92, value_before_usd: 7920, impact_pct: 0.45, impact_usd:  35.64, confidence:0.52, rationale:'Classic defensive beneficiary as growth multiples de-rate on a supply shock; earnings stream is uncorrelated with foundry capacity.'},
    {ticker:'WMT',  sector:'Consumer Staples',    weight_pct: 8.00, value_before_usd: 8000, impact_pct: 0.35, impact_usd:  28.00, confidence:0.50, rationale:'Staples absorb rotation flow out of semiconductors; consumer electronics is too small a basket share to matter to the P&L.'},
    {ticker:'JPM',  sector:'Financials',          weight_pct:10.08, value_before_usd:10080, impact_pct: 0.20, impact_usd:  20.16, confidence:0.44, rationale:'Modest rotation benefit and a steeper curve on the risk-off bid; no direct exposure to Taiwanese manufacturing capacity.'},
    {ticker:'NEE',  sector:'Utilities',           weight_pct: 7.04, value_before_usd: 7040, impact_pct: 0.15, impact_usd:  10.56, confidence:0.43, rationale:'Rate-sensitive defensive bid, partly offset by softer expected data-centre load growth if AI capacity build slips.'},
    {ticker:'XOM',  sector:'Energy',              weight_pct: 8.00, value_before_usd: 8000, impact_pct: 0.00, impact_usd:   0.00, confidence:0.38, rationale:'No identifiable transmission channel from Taiwanese foundry capacity to integrated oil and gas cash flows; held flat rather than guessed.'},
  ],
  portfolio_value_before_usd: 100000,
  portfolio_impact_pct: -1.81,
  portfolio_impact_usd: -1806.96,
  citations: [
    {claim:'TSMC evacuated and idled Fab 12, Fab 18 and Fab 20; leading-edge N3/N2 lines and CoWoS capacity down an estimated 5 to 10 days', url:'https://www.reuters.com/technology/tsmc-halts-fabs-hsinchu-quake', source:'Reuters', published_at:'2026-08-28'},
    {claim:'NVDA data centre segment revenue concentration on CoWoS advanced packaging disclosed in the most recent 10-Q', url:'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=NVDA', source:'SEC EDGAR 10-Q', published_at:'2026-07-24'},
    {claim:'Broadcom custom AI accelerator programmes qualified on the same leading-edge node', url:'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=AVGO', source:'SEC EDGAR 10-K', published_at:'2026-06-12'},
    {claim:'Sector beta estimates derived from a trailing 250-day regression against the S&P 500', url:'https://fred.stlouisfed.org/series/SP500', source:'FRED', published_at:'2026-08-27'},
  ],
  budget: { codex_credits_used: 468, parallel_calls_used: 3, attempts: 2 }
};

/* prefer the verifier-validated golden payload when stream D lands it */
fetch('data/golden_result.json')
  .then(r => r.ok ? r.json() : Promise.reject(0))
  .then(g => { if(g && Array.isArray(g.positions) && g.positions.length) RESULT = g; })
  .catch(() => {});

const V_OK  = n => ({id:n[0], name:n[1], passed:true});
const NAMES = SEED;

function runDemo(){
  const q = [];
  let tok = 0;
  const push = (dt, ev) => q.push([dt, ev]);
  const st = (dt, o) => push(dt, Object.assign(
    {type:'state', model:'gpt-5.6-terra', effort:'medium', attempt:1, max_attempts:4,
     tokens_total: tok, parallel_calls:1}, o));
  const tool = (dt, o) => { tok += (o.tokens||0); push(dt, Object.assign({type:'tool', status:'ok'}, o)); };
  const logs = (arr, stream, gap) => arr.forEach(t => push(gap||55, {type:'log', stream: stream||'stdout', text:t}));
  const noise = (n, stream, words) => {
    for(let i=0;i<n;i++)
      push(38, {type:'log', stream: stream||'stdout',
                text: words[Math.floor(Math.random()*words.length)].replace('%d', Math.floor(Math.random()*9000))});
  };
  const CODEX_NOISE = [
    'codex: thinking … (%d ms)', 'tokens in=%d out=1180', 'exec sandbox: bypass approvals',
    'GET https://www.sec.gov/cgi-bin/browse-edgar 200', 'reading /work/kit/sector_beta.json',
    'tool_call: shell(["python","-c","..."])', 'stream chunk %d bytes',
    'apply_patch: /work/analysis.py', 'reasoning: effort=medium tokens=%d',
    'GET https://www.federalregister.gov/api/v1/documents 200',
  ];
  const ERR_NOISE = [
    'Traceback (most recent call last):', '  File "/work/analysis.py", line 31, in <module>',
    'KeyError: \'portfolio_impact_pct\'', 'ValidationError: 1 validation error for PortfolioImpactAnalysis',
    'stderr: reconciliation drift 0.4345 exceeds tolerance 0.01',
  ];

  /* ── boot ─────────────────────────────────────────────── */
  st(60, {phase:'spawning', elapsed_s:0});
  tool(320, {id:'s1', kind:'SYSTEM', label:'daytona sandbox', detail:'snapshot python:3.12-slim', tokens:0, ms:1840, status:'running'});
  logs(['daytona: creating sandbox (auto_stop_interval=0)','daytona: pulling snapshot python:3.12-slim','daytona: session "agent" created'], 'stdout', 210);
  tool(520, {id:'s1', kind:'SYSTEM', label:'daytona sandbox', detail:'ready · auto_stop=0', tokens:0, ms:1840, status:'ok'});
  tool(300, {id:'s2', kind:'SYSTEM', label:'uploaded kit/', detail:'portfolio.json · skills/ · verifier/', tokens:0, ms:410,
             body:'/work\n├── portfolio.json        10 positions · $100,000\n├── kit/sector_beta.json   trailing 250d regression\n├── skills/portfolio-impact/SKILL.md\n└── verifier/impact.schema.json'});

  /* ── attempt 1 ────────────────────────────────────────── */
  st(700, {phase:'running', attempt:1, elapsed_s:6});
  tool(420, {id:'t1', kind:'THOUGHT', label:'plan the analysis', detail:'3 steps', tokens:840, ms:2100,
    body:'1. pull the primary source for the export-control expansion (Federal Register + Reuters)\n2. map affected sectors -> portfolio holdings via trailing-250d sector betas\n3. compute per-position impact, reconcile the weighted sum, emit schema-valid JSON'});
  noise(9, 'stderr', CODEX_NOISE);
  tool(300, {id:'t2', kind:'SEARCH', label:'US widens advanced-node export controls to two more foundries', detail:'federalregister.gov · 2 sources', tokens:1310, ms:1640});
  noise(11, 'stdout', CODEX_NOISE);
  tool(240, {id:'t3', kind:'SEARCH', label:'NVDA 10-Q restricted-SKU revenue share', detail:'sec.gov EDGAR · 11% of DC segment', tokens:980, ms:2210});
  noise(8, 'stdout', CODEX_NOISE);
  tool(240, {id:'t4', kind:'WRITE', label:'analysis.py', detail:'+34 lines', tokens:2240, ms:3180, body:CODE});
  noise(16, 'stdout', CODEX_NOISE);
  tool(1500, {id:'t5', kind:'RUN', label:'python analysis.py', detail:'exit 0 · 1.9s', tokens:180, ms:1920, body:RUNOUT});
  noise(7, 'stdout', CODEX_NOISE);
  tool(900, {id:'t6', kind:'EMIT', label:'result.json', detail:'declared −2.10% · 10 positions', tokens:1620, ms:980});

  st(300, {phase:'verifying', attempt:1, elapsed_s:31});
  tool(200, {id:'t7', kind:'SYSTEM', label:'verifier.verify()', detail:'6 checks · pure, offline', tokens:0, ms:14, status:'running'});
  push(1400, {type:'verdict', passed:false, attempt:1, route:'MECHANICAL FIX', checks:[
    V_OK(NAMES[0]), V_OK(NAMES[1]),
    {id:'V3', name:'positions reconcile', passed:false, kind:'semantic',
     message:'Σ = -1.6655, declared -2.10 (Δ 0.4345 > 0.01)'},
    V_OK(NAMES[3]), V_OK(NAMES[4]), V_OK(NAMES[5]),
  ]});
  tool(1500, {id:'t7', kind:'SYSTEM', label:'verifier.verify()', detail:'V3 FAILED · rejected', tokens:0, ms:14, status:'fail'});
  st(120, {phase:'rejected', attempt:1, elapsed_s:34});
  ERR_NOISE.forEach(t => push(120, {type:'log', stream:'stderr', text:t}));

  /* ── attempt 2 ────────────────────────────────────────── */
  st(900, {phase:'running', attempt:2, elapsed_s:38, parallel_calls:3});
  tool(300, {id:'r1', kind:'SYSTEM', label:'codex exec resume --last', detail:'route: MECHANICAL FIX · effort medium', tokens:0, ms:220,
    body:'The verifier rejected your output:\n  V3 positions reconcile — Σ = -1.6655, declared -2.10 (Δ 0.4345 > 0.01)\nRecompute portfolio_impact_pct from the position rows. Do not change the per-position\nimpacts unless your rationale changes. Re-emit the full document.'});
  noise(10, 'stderr', CODEX_NOISE);
  tool(300, {id:'r2', kind:'THOUGHT', label:'locate the discrepancy', detail:'aggregate, not positions', tokens:760, ms:1440,
    body:'The per-position impacts are internally consistent with the sector betas and each impact_usd\nmatches value_before_usd × impact_pct/100. Only the declared aggregate is wrong — it was\ncarried over from the first-pass estimate instead of being re-derived after the beta clip.\nThis is a mechanical fix: recompute the two aggregate fields, leave positions untouched.'});
  noise(12, 'stdout', CODEX_NOISE);
  tool(300, {id:'r3', kind:'WRITE', label:'analysis.py', detail:'~2 lines · aggregate re-derived', tokens:640, ms:910,
    body:'-  payload["portfolio_impact_pct"] = FIRST_PASS_ESTIMATE\n-  payload["portfolio_impact_usd"] = round(PF["total_value_usd"] * FIRST_PASS_ESTIMATE / 100, 2)\n+  payload["portfolio_impact_pct"] = round(total_pct, 2)\n+  payload["portfolio_impact_usd"] = round(total_usd, 2)'});
  noise(14, 'stdout', CODEX_NOISE);
  tool(900, {id:'r4', kind:'RUN', label:'python analysis.py', detail:'exit 0 · reconciled', tokens:210, ms:1710, body:FIXOUT});
  noise(6, 'stdout', CODEX_NOISE);
  tool(1100, {id:'r5', kind:'EMIT', label:'result.json', detail:'declared −1.67% · reconciled', tokens:1490, ms:1040});

  st(300, {phase:'verifying', attempt:2, elapsed_s:58});
  tool(200, {id:'r6', kind:'SYSTEM', label:'verifier.verify()', detail:'6 checks · pure, offline', tokens:0, ms:12, status:'running'});
  push(1500, {type:'verdict', passed:true, attempt:2, checks: NAMES.map(V_OK)});
  tool(1400, {id:'r6', kind:'SYSTEM', label:'verifier.verify()', detail:'6/6 PASSED · accepted', tokens:0, ms:12, status:'ok'});
  st(200, {phase:'accepted', attempt:2, elapsed_s:62, tokens_total: 8210});
  push(400, {type:'result', data: RESULT});

  /* ── teardown ─────────────────────────────────────────── */
  logs(['daytona: fetching /work/result.json (4.2 KB)','daytona: archiving 1,284 log lines','daytona: sandbox.delete() …'], 'stdout', 700);
  st(2600, {phase:'destroyed', attempt:2, elapsed_s:71, tokens_total: 8210});

  /* run it */
  let i = 0;
  (function step(){
    if(i >= q.length) return;
    const [dt, ev] = q[i++];
    setTimeout(() => { handle(ev); step(); }, Math.max(8, dt / SPEED));
  })();

  $('#railHint').textContent = 'DEMO REPLAY';
}

/* ══════════════════════════════════════════════════════════════════════
   PART 1 · RUN CONTROLS — news strip, RUN button, SPACE, live scan
   ══════════════════════════════════════════════════════════════════════ */
const FALLBACK_NEWS = [{
  id:'evt-taiwan-quake',
  headline:'Magnitude 7.1 earthquake near Hsinchu halts TSMC leading-edge fabs; advanced packaging offline',
  summary:'TSMC evacuated and idled Fab 12, 18 and 20. Leading-edge N3/N2 lines and CoWoS advanced-packaging capacity down an estimated 5-10 days.',
  published_at:'2026-08-28T01:40:00Z', tickers_hint:['NVDA','AVGO','AAPL','MSFT']
}];
let NEWS_EVENTS = [];

function newsMeta(n){
  const d = (n.published_at || '').slice(5,10).replace('-','/');
  const tk = (n.tickers_hint || []).slice(0,4).join(' ');
  return [tk, d].filter(Boolean).join('  ·  ');
}
function renderNewsStrip(){
  const box = $('#newsStrip'); box.innerHTML = '';
  NEWS_EVENTS.slice(0,4).forEach(n => {
    const b = el('button', 'nchip' + (n.id === S.selNews ? ' sel' : ''),
      `<span class="nh">${esc(n.headline || n.id)}</span><span class="nm">${esc(newsMeta(n))}</span>`);
    b.title = n.summary || '';
    b.onclick = () => { S.selNews = n.id; renderNewsStrip(); };
    box.appendChild(b);
  });
}
function adoptNews(list, keepOnEmpty){
  const arr = (Array.isArray(list) ? list : (list && list.events) || []).filter(n => n && n.headline);
  if(!arr.length) return keepOnEmpty ? false : false;   // never empty the strip
  NEWS_EVENTS = arr;
  if(!NEWS_EVENTS.some(n => n.id === S.selNews)) S.selNews = NEWS_EVENTS[0].id;
  renderNewsStrip();
  NEWS = NEWS_EVENTS.map(n => n.headline).slice(0,8);
  renderTicker();
  return true;
}
NEWS_EVENTS = FALLBACK_NEWS.slice();
S.selNews = FALLBACK_NEWS[0].id;
renderNewsStrip();

fetch('/api/news').then(r => r.ok ? r.json() : Promise.reject(0))
  .then(l => adoptNews(l)).catch(() => {});

function toast(msg){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('on'); void t.offsetWidth; t.classList.add('on');
}

/* full reset so the RUN button can fire again and again */
function resetRun(){
  closeAct2(true);
  clearTimeout(S.actTimer);
  rail.innerHTML = ''; rowsById.clear(); openRow = null;
  if(typer){ clearInterval(typer.h); typer = null; }
  $$('#slip .slipline').forEach(n => n.remove()); live.length = 0;
  $('#tomb').hidden = true;
  $('#railHint').classList.remove('gone');
  $('#railHint').textContent = 'provisioning sandbox …';
  S.tally = {}; S.logLines = 0; S.accepted = false; S.attempt = 1;
  S.burn = []; S.lastTok = 0; S.elapsed = 0; S.t0 = Date.now();
  setTokens(0, true);
  setCredits(CREDITS_MAX, true);
  setPhase('spawning');
  $('#sAttempt').textContent = 'ATTEMPT 1';
  markPips(); initChecks();
  const st = $('#stamp'); st.className = 'idle';
  $('#stampTop').textContent = 'AWAITING VERDICT';
  $('#stampMsg').textContent = ''; $('#stampRoute').hidden = true;
  $('#judgeSub').textContent = 'deterministic verifier';
  $('#totAfter').textContent = '—'; $('#totAfter').style.color = '';
  $('#totDelta').className = 'totdelta';
  if(S.portfolio) initTreemap(S.portfolio);
}

function setRunning(on){
  S.running = on;
  const b = $('#runBtn');
  b.disabled = on;
  b.classList.toggle('busy', on);
  b.querySelector('.rbTxt').textContent = on ? 'RUNNING…' : 'RUN ANALYSIS';
  b.querySelector('.rbIcon').textContent = on ? '◐' : '▶';
}

function triggerRun(){
  if(S.running) return;
  setRunning(true);                       // disable immediately — belt and braces
  if(DEMO){ resetRun(); setTimeout(runDemo, 260); return; }

  const news = NEWS_EVENTS.find(n => n.id === S.selNews) || NEWS_EVENTS[0];
  resetRun();
  // send the FULL object: an unknown news_id silently falls back to events[0]
  fetch('/api/trigger', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(news ? {news} : {})
  })
  .then(r => r.ok ? r.json() : r.text().then(t => Promise.reject(r.status + ' ' + t)))
  .catch(e => { toast('could not start run · ' + String(e).slice(0,60)); setRunning(false); });
}

$('#runBtn').onclick = triggerRun;

$('#scanBtn').onclick = () => {
  const b = $('#scanBtn');
  if(b.classList.contains('busy')) return;
  b.classList.add('busy');
  fetch('/api/news/live')
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(l => { adoptNews(l) ? toast('live scan · ' + NEWS_EVENTS.length + ' events') : toast('live scan returned nothing'); })
    .catch(() => toast('live scan unavailable — keeping current wire'))
    .then(() => b.classList.remove('busy'));
};

/* health probe keeps the button honest if a run was started elsewhere */
if(!DEMO) setInterval(() => {
  fetch('/api/health').then(r => r.json()).then(h => {
    if(h && h.run && typeof h.run.active === 'boolean' && h.run.active !== S.running) setRunning(h.run.active);
  }).catch(() => {});
}, 3000);

addEventListener('keydown', e => {
  if(e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k = e.key;
  if(k === ' ' || k === 'Spacebar'){ e.preventDefault(); closeAct2(); triggerRun(); return; }
  if(!A2.open) { if(k === 'v' || k === 'V'){ e.preventDefault(); openAct2(S.lastResult || RESULT); } return; }
  if(k === 'Escape'){ e.preventDefault(); if(!$('#a2detail').hidden || !$('#a2evpanel').hidden) closeDetail(); else closeAct2(); }
  else if(k === 'a' || k === 'A'){ e.preventDefault(); closeAct2(); }
  else if(k === 'ArrowRight'){ e.preventDefault(); stepCard(1); }
  else if(k === 'ArrowLeft'){ e.preventDefault(); stepCard(-1); }
});

/* ══════════════════════════════════════════════════════════════════════
   PART 2 · ACT II — THE VERDICT
   ══════════════════════════════════════════════════════════════════════ */
const A2 = { open:false, cards:[], order:[], sel:-1, timers:[], fall:null,
             nodes:[], edges:[], adj:{}, cites:[], data:null };

const after = (ms, fn) => A2.timers.push(setTimeout(fn, ms / SPEED));
const clearBeats = () => { A2.timers.forEach(clearTimeout); A2.timers = []; };

const splitIds = s => String(s || '').split(/\s*[\/,]\s*/).map(x => x.trim()).filter(Boolean);
const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
const dots = c => { const f = Math.round(Math.max(0, Math.min(1, c)) * 5);
  return '<b>' + '●'.repeat(f) + '</b>' + '○'.repeat(5 - f); };

function openAct2(d){
  if(!d || !d.positions || A2.open) return;
  A2.open = true; A2.data = d; A2.sel = -1;
  clearBeats();

  // impactColor normalises by module-level maxAbs; set it ourselves so Act II
  // is correct even when opened directly (?act2=1 / V key) with no treemap run.
  maxAbs = Math.max(0.01, ...d.positions.map(p => Math.abs(p.impact_pct || 0)));

  $('#grid').classList.remove('back'); $('#hud').classList.remove('back');
  $('#grid').classList.add('away');    $('#hud').classList.add('away');
  $('#act2').hidden = false; $('#act2').classList.remove('closing');

  buildHero(d);
  const order = d.positions.slice().sort((a,b) => {
    const za = Math.abs(a.impact_pct||0) < 1e-9, zb = Math.abs(b.impact_pct||0) < 1e-9;
    if(za !== zb) return za ? 1 : -1;                       // zero-impact deal LAST
    return Math.abs(b.impact_pct||0) - Math.abs(a.impact_pct||0);
  });
  A2.order = order;
  matchCitations(d, order);

  const chainMs = buildChain(d, order);                     // BEAT 1
  after(chainMs + 260, () => dealCards(order, d));          // BEAT 2
  after(chainMs + 260 + order.length * 300 + 420, () => buildFall(order, d)); // BEAT 3
}

function closeAct2(instant){
  if(!A2.open) return;
  A2.open = false; clearBeats(); closeDetail();
  const a = $('#act2');
  if(instant){ a.hidden = true; a.classList.remove('closing'); }
  else {
    a.classList.add('closing');
    setTimeout(() => { a.hidden = true; a.classList.remove('closing'); }, 460);
  }
  $('#grid').classList.remove('away'); $('#hud').classList.remove('away');
  $('#grid').classList.add('back');    $('#hud').classList.add('back');
}

/* ── hero ─────────────────────────────────────────────────────── */
function buildHero(d){
  $('#a2thesis').textContent = d.thesis || d.headline || '';
  $('#a2method').textContent = (d.methodology || 'analysis').replace(/_/g,' ');
  const n = (d.citations || []).length;
  $('#a2evidence').textContent = 'EVIDENCE ×' + n;
  $('#a2evidence').onclick = () => openEvidence(d);

  const pct = d.portfolio_impact_pct ?? 0, usd = d.portfolio_impact_usd ?? 0;
  const before = d.portfolio_value_before_usd ?? (S.portfolio ? S.portfolio.total_value_usd : 0);
  const p = $('#a2pct');
  p.textContent = fmtPct(pct);
  p.style.color = pct < 0 ? 'var(--red)' : 'var(--green)';
  $('#a2usd').textContent = fmtUSD(before) + '  →  ' + fmtUSD(before + usd);

  const c = Math.max(0, Math.min(1, d.confidence ?? 0));
  $('#a2confNum').textContent = c.toFixed(2);
  $('#a2confBar').style.transform = 'scaleX(0)';
  after(240, () => $('#a2confBar').style.transform = 'scaleX(' + c + ')');
}

/* ── BEAT 1 · the chain draws itself ──────────────────────────── */
function buildChain(d, order){
  const host = $('#a2chain'), fx = $('#a2effects');
  host.innerHTML = ''; fx.innerHTML = '';
  A2.nodes = []; A2.edges = []; A2.adj = {};

  const mech = Array.isArray(d.mechanism) ? d.mechanism : [];
  if(!mech.length){ $('#a2chainSub').textContent = 'no mechanism supplied'; return 300; }

  const tickers = new Set(d.positions.map(p => p.ticker));
  const links = [];
  mech.forEach(m => splitIds(m.from).forEach(f =>
    splitIds(m.to).forEach(t => { if(f !== t) links.push({s:f, t:t, effect:m.effect || ''}); })));
  if(!links.length){ $('#a2chainSub').textContent = 'no mechanism supplied'; return 300; }

  const layer = new Map();
  links.forEach(l => { layer.set(l.s, 0); layer.set(l.t, 0); });
  for(let i = 0; i < 14; i++){
    let ch = false;
    links.forEach(l => { const n = layer.get(l.s) + 1; if(n > layer.get(l.t)){ layer.set(l.t, n); ch = true; } });
    if(!ch) break;
  }
  // every portfolio ticker collapses into ONE column, then PORTFOLIO
  let maxMid = 0;
  layer.forEach((v, k) => { if(!tickers.has(k)) maxMid = Math.max(maxMid, v); });
  layer.forEach((v, k) => { if(tickers.has(k)) layer.set(k, maxMid + 1); });
  const BOOK = 'PORTFOLIO';
  layer.set(BOOK, maxMid + 2);
  const hasOut = new Set(links.map(l => l.s));
  Array.from(layer.keys()).forEach(k => {
    if(k === BOOK) return;
    if(tickers.has(k) || !hasOut.has(k)) links.push({s:k, t:BOOK, effect:''});
  });
  links.forEach(l => (A2.adj[l.s] = A2.adj[l.s] || []).push(l.t));

  /* layout */
  const cols = {};
  layer.forEach((v, k) => (cols[v] = cols[v] || []).push(k));
  const keys = Object.keys(cols).map(Number).sort((a,b) => a-b);
  const W = host.clientWidth || 900, H = host.clientHeight || 260;
  const maxCh = keys.length <= 4 ? 22 : keys.length <= 5 ? 19 : 15;
  const wOf = k => k === BOOK ? 132 : tickers.has(k) ? 74 : Math.min(196, clip(k, maxCh).length * 7.6 + 24);

  const colW = keys.map(k => Math.max(...cols[k].map(wOf)));
  const sum = colW.reduce((a,b) => a+b, 0);
  const gap = keys.length > 1 ? Math.max(10, (W - 24 - sum) / (keys.length - 1)) : 0;
  let x = 12 + colW[0] / 2;
  const pos = {};
  keys.forEach((k, ci) => {
    if(ci) x += colW[ci-1]/2 + gap + colW[ci]/2;
    const list = cols[k];
    // >5 in a column (the ticker stack) fans into two sub-columns
    const two = list.length > 5, per = two ? Math.ceil(list.length/2) : list.length;
    list.forEach((id, i) => {
      const sub = two ? Math.floor(i/per) : 0, idx = two ? i % per : i;
      const n = two ? (sub === 0 ? per : list.length - per) : list.length;
      pos[id] = { x: x + (two ? (sub ? 40 : -40) : 0), y: H * (idx + 1) / (n + 1) };
    });
  });

  const kind = k => k === BOOK ? 'book' : tickers.has(k) ? 'tick'
                  : (layer.get(k) === 0 ? 'news' : 'mid');

  /* nodes */
  const STEP = 190;
  Array.from(layer.keys()).forEach(k => {
    const n = el('div', 'cn ' + kind(k), esc(k === BOOK ? '◆ PORTFOLIO' : clip(k, maxCh)));
    n.style.left = pos[k].x + 'px'; n.style.top = pos[k].y + 'px';
    n.style.animationDelay = (layer.get(k) * STEP / SPEED) + 'ms';
    n.dataset.id = k;
    if(kind(k) === 'tick'){
      const p = d.positions.find(p => p.ticker === k);
      if(p && Math.abs(p.impact_pct||0) > 1e-9){
        n.style.borderColor = impactColor(p.impact_pct);
        n.style.color = impactColor(p.impact_pct);
      }
    }
    n.onclick = () => litPath(k);
    host.appendChild(n); A2.nodes.push(n);
  });

  /* edges — rotated divs grown with scaleX: a real line-draw, transform only */
  links.forEach(l => {
    const a = pos[l.s], b = pos[l.t]; if(!a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const e = el('div', 'ce');
    e.style.left = a.x + 'px'; e.style.top = a.y + 'px';
    e.style.width = len + 'px';
    e.style.setProperty('--a', (Math.atan2(dy, dx) * 180 / Math.PI) + 'deg');
    e.style.animationDelay = ((layer.get(l.s) + 0.55) * STEP / SPEED) + 'ms';
    e.dataset.s = l.s; e.dataset.t = l.t;
    host.appendChild(e); A2.edges.push(e);
  });

  /* the effect text lands with its edge */
  mech.forEach((m, i) => after((layer.get(splitIds(m.from)[0]) ?? i) * STEP + 300 + i * 90, () => {
    fx.appendChild(el('div', 'efx',
      `<i>${esc(clip(m.from, 26))}</i> → <u>${esc(clip(m.to, 22))}</u> · ${esc(m.effect || '')}`));
    while(fx.children.length > 6) fx.firstElementChild.remove();
  }));

  $('#a2chainSub').textContent = `${Array.from(layer.keys()).length} nodes · ${mech.length} links`;
  return (keys.length + 1) * STEP + 300;
}

function litPath(id){
  const seen = new Set([id]), q = [id];
  while(q.length){ const n = q.shift(); (A2.adj[n]||[]).forEach(m => { if(!seen.has(m)){ seen.add(m); q.push(m); } }); }
  const all = A2.nodes.every(n => n.classList.contains('lit')) ;
  const already = A2.nodes.length && A2.nodes.filter(n => n.classList.contains('lit')).length &&
                  A2.nodes.find(n => n.dataset.id === id && n.classList.contains('lit'));
  if(already){ clearLit(); return; }
  A2.nodes.forEach(n => {
    const on = seen.has(n.dataset.id);
    n.classList.toggle('lit', on); n.classList.toggle('faded', !on);
  });
  A2.edges.forEach(e => {
    const on = seen.has(e.dataset.s) && seen.has(e.dataset.t);
    e.classList.toggle('lit', on); e.classList.toggle('faded', !on);
  });
  A2.cards.forEach(c => {
    const on = seen.has(c.dataset.ticker);
    c.classList.toggle('raised', on); c.classList.toggle('dimmed', !on);
  });
}
function clearLit(){
  A2.nodes.forEach(n => n.classList.remove('lit','faded'));
  A2.edges.forEach(e => e.classList.remove('lit','faded'));
  A2.cards.forEach(c => c.classList.remove('raised','dimmed'));
}

/* ── citations ────────────────────────────────────────────────── */
function matchCitations(d, order){
  const cites = (d.citations || []).map(c => Object.assign({}, c));
  A2.cites = cites; A2.byTicker = {};
  order.forEach(p => {
    const name = (S.portfolio && (S.portfolio.positions.find(x => x.ticker === p.ticker)||{}).name) || '';
    const stem = name.split(/[ ,.]/)[0];
    const hit = cites.find(c => !c._used && (
      new RegExp('\\b' + p.ticker + '\\b').test(c.claim || '') ||
      (stem.length > 3 && (c.claim || '').toLowerCase().includes(stem.toLowerCase()))));
    if(hit){ hit._used = true; A2.byTicker[p.ticker] = hit; }
  });
}
const host = u => { try{ return new URL(u).host.replace(/^www\./,''); }catch(_){ return String(u||'').slice(0,42); } };

/* ── BEAT 2 · the cards deal out ──────────────────────────────── */
function dealCards(order, d){
  const box = $('#a2cards'); box.innerHTML = ''; A2.cards = [];
  const top = order[0] ? order[0].ticker : null;

  order.forEach((p, i) => {
    const zero = Math.abs(p.impact_pct || 0) < 1e-9;
    const pp = (p.weight_pct / 100) * p.impact_pct;
    const cite = A2.byTicker[p.ticker];
    const c = el('div', 'a2card' + (zero ? ' zero' : ''),
      `${(!zero && p.ticker === top) ? '<span class="cFlag">TOP IMPACT</span>' : ''}
       <div class="cTop">
         <span class="cTk">${esc(p.ticker)}</span>
         <span class="cSec">${esc(p.sector || '')}</span>
         <span class="cImp">${fmtPct(p.impact_pct)}</span>
       </div>
       <div class="cConf"><span class="cDots">${dots(p.confidence)}</span>
         <span class="cCn">${Number(p.confidence ?? 0).toFixed(2)}</span></div>
       <div class="cNil">no material exposure</div>
       <div class="cRat">${esc(p.rationale || '')}</div>
       <div class="cMath"><em>w</em> ${p.weight_pct.toFixed(2)}% <em>×</em> ${fmtPct(p.impact_pct)} <em>=</em> ${pp>=0?'+':''}${pp.toFixed(2)}pp</div>
       <div class="cCite">${cite ? '&#128279; ' + esc(host(cite.url)) : ''}</div>`);
    c.style.animationDelay = (i * 300 / SPEED) + 'ms';
    c.dataset.ticker = p.ticker;
    c.style.borderLeftColor = zero ? 'var(--surface2)' : impactColor(p.impact_pct);
    c.querySelector('.cImp').style.color = zero ? 'var(--overlay)' : impactColor(p.impact_pct);
    c.onclick = () => openDetail(i);
    box.appendChild(c); A2.cards.push(c);
  });
}

/* ── BEAT 3 · the waterfall assembles ─────────────────────────── */
function buildFall(order, d){
  const host = $('#a2fall');
  if(!A2.fall){ A2.fall = echarts.init(host, null, {renderer:'canvas'}); A2.fall.on('click', p => {
    const i = order.findIndex(o => o.ticker === p.name); if(i >= 0) selectCard(i, true);
  }); }
  const cats = ['START'].concat(order.map(p => p.ticker)).concat(['Σ TOTAL']);
  const contrib = order.map(p => (p.weight_pct / 100) * p.impact_pct);
  const total = contrib.reduce((a,b) => a+b, 0);

  const base = [], val = [], col = [];
  let run = 0;
  base.push(0); val.push(0); col.push('transparent');
  contrib.forEach(c => {
    const from = run, to = run + c;
    base.push(Math.min(from, to)); val.push(Math.abs(c));
    col.push(c === 0 ? '#45475a' : impactColor(c));
    run = to;
  });
  base.push(Math.min(0, total)); val.push(Math.abs(total)); col.push('#cba6f7');

  const mono = 'JetBrains Mono,monospace';
  A2.fall.setOption({
    animationDuration: 420, animationEasing:'cubicOut',
    grid:{left:64, right:16, top:26, bottom:56},
    xAxis:{ type:'category', data:cats,
      axisLabel:{color:'#a6adc8', fontSize:14.5, fontFamily:mono, interval:0, rotate:36},
      axisLine:{lineStyle:{color:'rgba(205,214,244,.18)'}}, axisTick:{show:false} },
    yAxis:{ type:'value', axisLabel:{color:'#6c7086', fontSize:14, fontFamily:mono,
        formatter: v => v.toFixed(1) + '%' },
      splitLine:{lineStyle:{color:'rgba(205,214,244,.07)'}} },
    series:[
      {name:'b', type:'bar', stack:'w', silent:true, itemStyle:{color:'transparent'},
       barWidth:'62%', data:[]},
      {name:'v', type:'bar', stack:'w', barWidth:'62%', data:[]}
    ]
  });

  let k = 0, shown = 0;
  const stepMs = 230;
  const tick = () => {
    k++;
    const dv = val.slice(0, k).map((v, i) => ({ value: v, itemStyle:{ color: col[i], borderRadius:3 } }));
    A2.fall.setOption({ series:[{ data: base.slice(0, k) }, { data: dv }] });
    if(k > 1 && k <= contrib.length + 1) shown += contrib[k-2];
    if(k === contrib.length + 2) shown = total;
    const r = $('#a2running');
    r.textContent = (shown >= 0 ? '+' : '') + shown.toFixed(2) + '%';
    r.style.color = shown < 0 ? 'var(--red)' : 'var(--green)';
    if(k < base.length) after(stepMs, tick);
    else after(300, () => {
      r.textContent = fmtPct(d.portfolio_impact_pct ?? total);
      $('#a2chainSub').textContent += ' · click a node';
    });
  };
  after(120, tick);
}

/* ── BEAT 4 · interactive ─────────────────────────────────────── */
function selectCard(i, raiseOnly){
  A2.sel = i;
  A2.cards.forEach((c, j) => { c.classList.toggle('raised', j === i); c.classList.toggle('dimmed', false); });
  if(!raiseOnly) openDetail(i);
}
function stepCard(dir){
  if(!A2.order.length) return;
  const n = A2.order.length;
  A2.sel = ((A2.sel < 0 ? (dir > 0 ? -1 : 0) : A2.sel) + dir + n) % n;
  selectCard(A2.sel);
}
function closeDetail(){ $('#a2detail').hidden = true; $('#a2evpanel').hidden = true; }

function openDetail(i){
  const p = A2.order[i]; if(!p) return;
  A2.sel = i;
  A2.cards.forEach((c, j) => c.classList.toggle('raised', j === i));
  const pp = (p.weight_pct / 100) * p.impact_pct;
  const cite = A2.byTicker[p.ticker];
  const col = Math.abs(p.impact_pct) < 1e-9 ? 'var(--overlay)' : impactColor(p.impact_pct);
  const d = $('#a2evpanel'); d.hidden = true;
  const b = $('#a2detail');
  b.innerHTML =
    `<div class="dTop">
       <span class="dTk">${esc(p.ticker)}</span>
       <span class="dSec">${esc(p.sector || '')}</span>
       <span class="dImp" style="color:${col}">${fmtPct(p.impact_pct)}</span>
     </div>
     <div class="a2conf" style="max-width:520px">
       <span class="a2clab">CONFIDENCE</span>
       <span class="a2meter"><b style="transform:scaleX(${Math.max(0,Math.min(1,p.confidence??0))})"></b></span>
       <span class="a2cnum">${Number(p.confidence ?? 0).toFixed(2)}</span>
     </div>
     <div class="dRat">${esc(p.rationale || 'no rationale supplied')}</div>
     <div class="dMath"><em>weight</em> ${p.weight_pct.toFixed(2)}%
       <em>×</em> ${fmtPct(p.impact_pct)} <em>=</em> ${pp>=0?'+':''}${pp.toFixed(3)}pp
       <em>&nbsp;·&nbsp;</em> ${fmtUSD(p.impact_usd ?? 0)}</div>
     ${cite ? `<div class="dCite"><div class="cl">&#128279; ${esc(cite.claim || '')}</div>
        <div class="cu">${esc(cite.source ? cite.source + ' · ' : '')}${esc(cite.url || '')}</div></div>` : ''}
     <div class="dNav">← → step companies · ESC close · ${i+1} of ${A2.order.length}</div>`;
  b.hidden = false;
  b.classList.remove('x'); void b.offsetWidth;
  b.onclick = closeDetail;
}

function openEvidence(d){
  $('#a2detail').hidden = true;
  const b = $('#a2evpanel');
  const cs = d.citations || [];
  b.innerHTML = `<div class="evTitle">EVIDENCE · ${cs.length} CITATION${cs.length===1?'':'S'}</div>` +
    cs.map(c => `<div class="evRow"><div class="cl">${esc(c.claim || '')}</div>
      <div class="cu">${esc(c.source ? c.source + ' · ' : '')}${esc(c.url || '')}${c.published_at ? ' · ' + esc(c.published_at) : ''}</div></div>`).join('') ||
    '<div class="evRow"><div class="cl">no citations supplied</div></div>';
  b.hidden = false;
  b.onclick = closeDetail;
}

/* charts inside Act II must resize with the stage too */
addEventListener('resize', () => { if(A2.fall) A2.fall.resize(); });

/* manual test hook: ?act2=1 jumps straight in with the canned payload */
if(Q.get('act2') === '1') setTimeout(() => openAct2(RESULT), 400);

})();
