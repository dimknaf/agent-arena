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
/* real headlines if the backend has them, otherwise the canned set */
let NEWS = BASE_NEWS;
fetch('/api/news')
  .then(r => r.ok ? r.json() : Promise.reject(0))
  .then(list => {
    const arr = (Array.isArray(list) ? list : (list.events || []))
      .map(n => typeof n === 'string' ? n : (n.headline || n.title || n.text || ''))
      .filter(Boolean);
    if(arr.length){ NEWS = arr.slice(0, 8); renderTicker(); }
  })
  .catch(() => {});

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
const FALLBACK = {
  total_value_usd: 100000,
  positions: [
    {ticker:'AAPL', name:'Apple Inc.',            sector:'Technology',             qty:40,  price_usd:455.00, value_usd:18200, weight_pct:18.2},
    {ticker:'MSFT', name:'Microsoft Corp.',       sector:'Technology',             qty:28,  price_usd:535.71, value_usd:15000, weight_pct:15.0},
    {ticker:'NVDA', name:'NVIDIA Corp.',          sector:'Semiconductors',         qty:70,  price_usd:192.86, value_usd:13500, weight_pct:13.5},
    {ticker:'AMZN', name:'Amazon.com Inc.',       sector:'Consumer Discretionary', qty:42,  price_usd:238.10, value_usd:10000, weight_pct:10.0},
    {ticker:'GOOGL',name:'Alphabet Inc.',         sector:'Communication Services', qty:36,  price_usd:250.00, value_usd:9000,  weight_pct:9.0},
    {ticker:'META', name:'Meta Platforms Inc.',   sector:'Communication Services', qty:11,  price_usd:727.27, value_usd:8000,  weight_pct:8.0},
    {ticker:'JPM',  name:'JPMorgan Chase & Co.',  sector:'Financials',             qty:24,  price_usd:304.17, value_usd:7300,  weight_pct:7.3},
    {ticker:'TSLA', name:'Tesla Inc.',            sector:'Consumer Discretionary', qty:16,  price_usd:437.50, value_usd:7000,  weight_pct:7.0},
    {ticker:'XOM',  name:'Exxon Mobil Corp.',     sector:'Energy',                 qty:50,  price_usd:120.00, value_usd:6000,  weight_pct:6.0},
    {ticker:'UNH',  name:'UnitedHealth Group',    sector:'Health Care',            qty:18,  price_usd:333.33, value_usd:6000,  weight_pct:6.0},
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

const RESULT = {
  news_id: 'reuters-2026-08-30-export-controls',
  headline: 'US widens advanced-node semiconductor export controls to two additional foundries',
  published_at: '2026-08-30T06:12:00Z',
  thesis: 'Tighter advanced-node export controls compress near-term unit volume for AI accelerator supply chains, with second-order drag on hyperscaler capex-levered names and a defensive rotation bid into energy and managed care.',
  methodology: 'beta_weighted_shock',
  confidence: 0.71,
  mechanism: [
    {from:'export controls', to:'NVDA', effect:'direct unit-volume compression in restricted SKUs'},
    {from:'NVDA', to:'MSFT/GOOGL', effect:'accelerator scarcity delays AI capex monetisation'},
    {from:'risk-off rotation', to:'XOM/UNH', effect:'defensive sector bid'},
  ],
  positions: [
    {ticker:'NVDA', sector:'Semiconductors',         weight_pct:13.5, value_before_usd:13500, impact_pct:-6.40, impact_usd:-864.00, rationale:'Highest direct revenue exposure to restricted advanced-node SKUs; consensus expects a mid-single-digit unit haircut.', confidence:0.78},
    {ticker:'TSLA', sector:'Consumer Discretionary', weight_pct:7.0,  value_before_usd:7000,  impact_pct:-2.40, impact_usd:-168.00, rationale:'Autonomy compute roadmap depends on restricted accelerator supply; high-beta discretionary name in risk-off tape.', confidence:0.55},
    {ticker:'MSFT', sector:'Technology',             weight_pct:15.0, value_before_usd:15000, impact_pct:-1.80, impact_usd:-270.00, rationale:'Azure AI capacity build slips on accelerator scarcity, deferring capex monetisation by one to two quarters.', confidence:0.66},
    {ticker:'AAPL', sector:'Technology',             weight_pct:18.2, value_before_usd:18200, impact_pct:-1.20, impact_usd:-218.40, rationale:'Limited direct exposure; drag is via general technology multiple compression rather than unit volume.', confidence:0.60},
    {ticker:'GOOGL',sector:'Communication Services', weight_pct:9.0,  value_before_usd:9000,  impact_pct:-1.10, impact_usd:-99.00,  rationale:'TPU roadmap partially insulates Alphabet, but shared foundry capacity is still constrained.', confidence:0.58},
    {ticker:'AMZN', sector:'Consumer Discretionary', weight_pct:10.0, value_before_usd:10000, impact_pct:-0.90, impact_usd:-90.00,  rationale:'AWS accelerator fleet expansion slows; retail segment largely unaffected by the control regime.', confidence:0.57},
    {ticker:'META', sector:'Communication Services', weight_pct:8.0,  value_before_usd:8000,  impact_pct:-0.70, impact_usd:-56.00,  rationale:'Training cluster expansion is exposed, but inference demand and ad revenue are near-term insulated.', confidence:0.54},
    {ticker:'JPM',  sector:'Financials',             weight_pct:7.3,  value_before_usd:7300,  impact_pct: 0.30, impact_usd: 21.90,  rationale:'Modest rotation benefit; no direct supply-chain exposure to the restricted node classes.', confidence:0.44},
    {ticker:'UNH',  sector:'Health Care',            weight_pct:6.0,  value_before_usd:6000,  impact_pct: 0.40, impact_usd: 24.00,  rationale:'Defensive managed-care bid as growth multiples de-rate on the announcement.', confidence:0.46},
    {ticker:'XOM',  sector:'Energy',                 weight_pct:6.0,  value_before_usd:6000,  impact_pct: 0.90, impact_usd: 54.00,  rationale:'Energy leads the defensive rotation; unaffected by semiconductor control regime.', confidence:0.49},
  ],
  portfolio_value_before_usd: 100000,
  portfolio_impact_pct: -1.67,
  portfolio_impact_usd: -1665.50,
  citations: [
    {claim:'Commerce Department expanded the entity list to two additional foundries', url:'https://www.federalregister.gov/documents/2026/08/30/export-controls', source:'Federal Register', published_at:'2026-08-30'},
    {claim:'NVDA restricted-SKU revenue share disclosed at 11% of data centre segment', url:'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=NVDA', source:'SEC EDGAR 10-Q', published_at:'2026-07-24'},
    {claim:'Sector beta estimates from trailing 250-day regression', url:'https://fred.stlouisfed.org/series/SP500', source:'FRED', published_at:'2026-08-29'},
  ],
  budget: { codex_credits_used: 412, parallel_calls_used: 3, attempts: 2 }
};

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

})();
