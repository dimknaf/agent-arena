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
/* ?replay=<run_id|last> re-plays a REAL stored run from /api/runs/<id>.
   There is no canned data anywhere in this file — the fallback when no run
   is live is a genuine earlier run, never invented numbers. */
const REPLAY = Q.get('replay');
const ACT2Q  = Q.get('act2');
const AUTO   = /^(1|true|yes)$/i.test(Q.get('auto') || '');
const SPEED  = Math.max(0.15, parseFloat(Q.get('speed') || '1'));

/* Replay pacing. `rate` is a PRESENTATION control, never a fidelity one:
   every recorded event is played, in order, whatever the rate. 1x is the
   true original timing; 2x and 4x collapse dead air only (see gapMs). */
const RP = { rate: Math.max(1, parseFloat(Q.get('rate') || '') || 2),
             on:false, headline:'', id:'', token:0, done:false, runs:[] };

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
  seenProse: new Set(),
  mine: false, external: false,          // who started the run that is streaming
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
  // horizon-aware: band() falls back to a flat impact_pct when horizons is absent
  const H = 'long_term';
  const impOf = t => { const p = by[t]; return p ? band(p, H).base : 0; };
  maxAbs = Math.max(0.01, ...Object.keys(by).map(t => Math.abs(impOf(t))));

  const order = tmData.map((d,i)=>i).sort((a,b) =>
    Math.abs(impOf(tmData[b].name)) - Math.abs(impOf(tmData[a].name)));

  order.forEach((idx, n) => setTimeout(() => {
    const p = by[tmData[idx].name]; if(!p) return;
    const v = impOf(tmData[idx].name);
    tmData[idx].imp = v;
    tmData[idx].itemStyle = { color: impactColor(v) };
    tmData[idx].label = { rich: rich(true) };
    paint(true);
  }, 220 + n * 115));

  const before = res.portfolio_value_before_usd ?? (S.portfolio ? S.portfolio.total_value_usd : 0);
  const pb = pBand(res, H), pu = pBandUsd(res, H);
  const dUsd = res.portfolio_impact_usd ?? pu.base, dPct = res.portfolio_impact_pct ?? pb.base;
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
  refreshNow();
}

/* one source of truth for the NOW chip — replay always wins, because a
   replay must never be mistakable for a live run */
function refreshNow(){
  if(typeof setNow !== 'function') return;
  if(RP.on)      return setNow('replay');
  if(S.external) return setNow('external');
  if(S.running || /^(spawning|running|verifying)$/.test(S.phase)) return setNow('live');
  setNow('idle');
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

/* Two families of kind live here:
     · the six the ORCHESTRATOR sends (CONTRACTS §1)
     · the finer kinds this dashboard DERIVES from the shell command it was
       handed, because "RAN /bin/bash -lc …" eighteen times is a terminal,
       not a story.
   Deriving is a PRESENTATION choice only. The untouched command is always
   on the card face and in the expander, so nothing below can hide what
   actually ran. Anything the dashboard wrote itself is rendered in the
   muted `›` narration style and never as the agent's own words. */
const ICON = {THOUGHT:'◇', SEARCH:'⌕', WRITE:'◉', RUN:'▶', EMIT:'⬢', SYSTEM:'⚙',
              READ:'▤', FETCH:'⇣', RESEARCH:'◎', COMPUTE:'Σ', CHECK:'◈', INSPECT:'◱'};
const VERB = {THOUGHT:'THOUGHT', SEARCH:'SEARCH', WRITE:'WROTE', RUN:'SHELL', EMIT:'DRAFT', SYSTEM:'SYS',
              READ:'READ', FETCH:'FETCH', RESEARCH:'RESEARCH', COMPUTE:'COMPUTE', CHECK:'CHECK', INSPECT:'INSPECT'};
const MARK = {running:'◐', ok:'✓', fail:'✗'};
const rowsById = new Map();
let openRow = null, typer = null;

const cut  = (s, n) => { s = String(s == null ? '' : s);
                         return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const uniq = a => a.filter((x, i) => a.indexOf(x) === i);
const baseName  = p => String(p).split('/').filter(Boolean).pop() || String(p);
const firstLine = t => (String(t || '').split('\n').find(l => l.trim().length > 1) || '').trim();
/* U+FFFD is a transport artefact in the recorded stream, not the agent's text */
const mend = t => String(t || '').replace(/�/g, '’');
function tryJSON(t){
  try{ const j = JSON.parse(String(t)); return (j && typeof j === 'object') ? j : null; }
  catch(_){ return null; }
}

/* The orchestrator caps a row body at 4 000 chars, so a late draft payload
   arrives as valid-looking JSON that stops mid-string. Pull the few fields
   the card shows straight out of the text rather than dropping the row into
   a wall of braces. Marked `_partial` so the card can say so. */
function salvageJSON(t){
  const s = String(t || '');
  if(!/^\s*\{/.test(s)) return null;
  const un = v => { try{ return JSON.parse('"' + v + '"'); }catch(_){ return v; } };
  const one = re => { const m = s.match(re); return m ? un(m[1]) : null; };
  const claims = [], re = /"claim"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m; while((m = re.exec(s))) claims.push(un(m[1]));
  const head = one(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const thes = one(/"thesis"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const conf = s.match(/"confidence"\s*:\s*(-?[\d.]+)/);
  if(head == null && !claims.length) return null;
  return { headline: head || '', thesis: thes || '',
           confidence: conf ? +conf[1] : undefined,
           positions: new Array((s.match(/"ticker"\s*:/g) || []).length),
           citations: claims.map(c => ({claim:c})), _partial: true };
}

/* the literal command, unwrapped from `bash -lc` and flattened to one line
   so a heredoc cannot blow the card open. Still the truth, just narrower. */
function shellOf(raw){
  let s = String(raw || '').trim().replace(/^\/bin\/bash\s+-lc\s+/, '');
  if(s.length > 1 && ((s[0] === '"' && s.slice(-1) === '"') || (s[0] === "'" && s.slice(-1) === "'")))
    s = s.slice(1, -1);
  return '$ ' + s.replace(/\s+/g, ' ').trim();
}

const NICE = {
  'SKILL.md'          : 'the portfolio-impact skill',
  'impact.schema.json': 'the output contract',
  'portfolio.json'    : 'the book · 10 holdings',
  'news.json'         : 'the news event',
  'budget.json'       : 'its budget',
  'sec_client.py'     : 'sec_client toolkit',
  'parallel_client.py': 'parallel_client toolkit',
};
const nice = f => NICE[f] || f;

/* ── command → readable action ────────────────────────────────────────
   Order matters: a line with both `rg` and `sed` is a search, and a line
   that runs a script it wrote is a computation even though it also
   validates. Returns null when nothing matches — then the row falls back
   to the raw command in monospace, which is honest and rare. */
function readCmd(raw){
  const c = String(raw || '');
  if(!c.trim()) return null;
  const b  = c.replace(/^\/bin\/bash\s+-lc\s+/, '');
  const py = /\bpython3?\b/.test(b);
  const files = uniq((b.match(/\/[\w.\/-]*\.(?:md|json|jsonl|py|txt|ya?ml)/g) || []).map(baseName));

  if(py && /\b(market_cap|shares_outstanding|annual_revenue|sec_client)\b/.test(b))
    return {kind:'FETCH', label:'live market cap & revenue',
            detail:'sec_client → data.sec.gov XBRL',
            narr:'checking what each holding is actually worth right now'};

  if(py && /\b(parallel_client|search)\b/.test(b)){
    /* count only what is actually inside the queries list — a wrong count
       would be a claim about the agent, so when in doubt claim nothing */
    const blk = b.match(/queries\s*=\s*\[([\s\S]*?)\n\s*\]/);
    const n = blk ? (blk[1].match(/^\s*['"]/gm) || []).length : 0;
    return {kind:'RESEARCH', label:'web search' + (n > 1 ? ' · ' + n + ' queries' : ''),
            detail:'parallel_client',
            narr:'looking outside its own inputs for corroboration'};
  }

  const script = b.match(/python3?\s+(\/work\/[\w.\/-]+\.py)/);
  if(script)
    return {kind:'COMPUTE', label:baseName(script[1]),
            detail:/jsonschema|validate/.test(b) ? 'then validates the output' : 'code it wrote itself',
            narr:'running the model it just wrote — every holding, one number each'};

  if(py && /jsonschema|\bvalidate\b|result\.json/.test(b))
    return {kind:'CHECK',
            label:/jsonschema/.test(b) ? 'result.json vs impact.schema.json' : 'result.json',
            detail:/jsonschema/.test(b) ? 'jsonschema' : 'reads its own answer back',
            narr:'checking its own answer before it hands it over'};

  if(/(?:^|[^\w.\/-])(?:rg|grep)\b/.test(b)){
    const m  = b.match(/\b(?:rg|grep)\b(?:\s+-{1,2}[\w-]+)*\s+(?:\\?["']([^"'\\\n]{2,70})|([^\s"'\\\n]{2,50}))/);
    const pat = m && (m[1] || m[2]);
    const wh = uniq((b.match(/\/(?:opt|work|verifier|etc)[\w.\/-]*/g) || []).map(baseName));
    const where = wh.length ? wh.slice(0, 2).join(', ') + (wh.length > 2 ? ' +' + (wh.length - 2) : '') : 'the workspace';
    return {kind:'SEARCH', label: pat ? cut(pat, 44) : 'across ' + where,
            detail: pat ? 'in ' + where : '',
            narr:'hunting for the exact definition instead of guessing it'};
  }

  if(/(?:^|[^\w.\/-])(?:sed|cat|head|tail|less|bat)\b/.test(b) && files.length){
    const skill = files.some(f => /SKILL\.md$/i.test(f));
    const kit   = files.some(f => /_client\.py$/.test(f));
    return {kind:'READ', label: nice(files[0]),
            detail: files.length > 1
              ? nice(files[1]) + (files.length > 2 ? ' +' + (files.length - 2) + ' more' : '') : '',
            narr: skill ? 'reading its brief and the contract it has to satisfy'
                : kit   ? 'reading the toolkit source before it trusts it'
                        : 'taking in ' + nice(files[0])};
  }

  if(/(?:^|[^\w.\/-])(?:ls|test\s+-[a-z]|which|stat|find|pwd)\b/.test(b))
    return {kind:'INSPECT',
            label:(b.match(/\/(?:opt|work|verifier|etc|root)[\w.\/-]*/) || [, ''])[0] || 'the workspace',
            detail:'', narr:'looking around before it commits'};

  return null;
}

/* derived narration for the orchestrator's own SYSTEM lines */
const SYSNARR = [
  [/snapshot unavailable/i,         'no prebuilt image — it builds the box from scratch instead'],
  [/^sandbox [0-9a-f]{6}/i,         'a cloud machine now exists that did not exist a second ago'],
  [/credentials transplanted/i,     'the sandbox is given its own Codex identity'],
  [/installing/i,                   'the toolchain the agent will need goes in first'],
  [/sandbox ready/i,                'the box is armed and the agent has somewhere to work'],
  [/kit uploaded|skills uploaded/i, 'handing over the only tools it is allowed to use'],
  [/toolkit verified/i,             'proving the tools import before trusting them'],
  [/egress lock/i,                  'the platform refused the network lockdown — logged, not hidden'],
  [/codex attempt/i,                'the task goes to Codex; nobody steers it from here'],
  [/turn \d+ complete/i,            'the agent has stopped thinking'],
];
const sysNarr = l => (SYSNARR.find(p => p[0].test(String(l || ''))) || [, ''])[1];

/* the agent's OWN sentences, lifted verbatim out of the draft result.json
   it just emitted. Nothing here is written by the dashboard — if there is
   no new sentence there is no THOUGHT card. */
function pickProse(j){
  const cands = [];
  if(typeof j.thesis === 'string' && j.thesis.length > 24) cands.push(j.thesis);
  (j.citations || []).forEach(c => {
    if(c && typeof c.claim === 'string' && c.claim.length > 24) cands.push(c.claim);
  });
  for(const t of cands){
    const key = t.slice(0, 60);
    if(S.seenProse.has(key)) continue;
    S.seenProse.add(key);
    return t;
  }
  return null;
}

/* ev (contract) → D (what the card shows). Fields:
     kind/label/detail  the head
     quote              the AGENT's own words, verbatim
     narr               DERIVED by this dashboard — rendered muted with `›`
     face               raw truth excerpt (the command, or body line 1)
     body               expander text                                       */
function derive(ev){
  const k0 = ICON[ev.kind] ? ev.kind : 'SYSTEM';
  const D = { kind:k0, label:ev.label || '', detail:ev.detail || '',
              narr:'', face:'', quote:ev.quote || '', think:null,
              body: ev.body == null ? '' : String(ev.body), code:k0 === 'WRITE' };

  if(k0 === 'RUN'){
    const raw = D.body || D.label;
    const r = readCmd(raw);
    if(r){ D.kind = r.kind; D.label = r.label; D.detail = r.detail; D.narr = r.narr; }
    else  { D.label = cut(shellOf(raw).replace(/^\$ /, ''), 40); D.detail = ''; D.mono = true; }
    D.face = shellOf(raw);
    if(ev.detail && /^exit\s+(?!0\s*$)/.test(ev.detail))
      D.detail = (D.detail ? D.detail + ' · ' : '') + ev.detail;
  }
  else if(k0 === 'EMIT'){
    const raw = D.body || ev.label || '';
    const j = tryJSON(raw) || salvageJSON(raw);
    if(j){
      const conf = typeof j.confidence === 'number' ? j.confidence : null;
      D.label  = 'draft result.json';
      D.detail = [conf != null ? 'confidence ' + conf.toFixed(2) : '',
                  j.positions && j.positions.length
                    ? j.positions.length + ' position' + (j.positions.length === 1 ? '' : 's') : '',
                  j.citations && j.citations.length
                    ? j.citations.length + ' citation' + (j.citations.length === 1 ? '' : 's') : '',
                  j._partial ? 'body truncated at 4 000 chars' : ''
                 ].filter(Boolean).join(' · ');
      D.quote  = typeof j.headline === 'string' ? j.headline : '';
      D.narr   = 'its working answer so far — rewritten every time it learns something';
      D.body   = j._partial ? raw : JSON.stringify(j, null, 1);
      D.code   = true;
      D.think  = pickProse(j);
    } else if(raw){
      /* prose, not a payload — that is the agent talking */
      D.kind = 'THOUGHT'; D.quote = cut(raw, 420);
      D.label = ''; D.body = '';
    }
  }
  else if(k0 === 'WRITE'){
    if(!D.label || /^(write|edit|apply_?patch|create)$/i.test(D.label)){
      D.detail = D.detail || D.label || 'apply_patch';
      D.label  = 'a file into /work';
    }
    D.narr = 'writing the analysis code it is about to run';
    D.face = firstLine(D.body);
  }
  else if(k0 === 'SEARCH'){
    /* Codex's own web_search item — label is already the query it typed */
    D.detail = D.detail || 'web search';
    D.narr   = 'going out to the open web for its own evidence';
    D.face   = D.body.trim().indexOf('\n') > 0 ? firstLine(D.body) : '';
  }
  else {
    D.narr = sysNarr(D.label);
    /* a one-line body is already fully shown by the expander — no echo */
    D.face = D.body.trim().indexOf('\n') > 0 ? firstLine(D.body) : '';
  }

  /* THOUGHT — the model's OWN words, so no derived styling, ever.
     Codex reasoning items are TITLE LINES only: `**Planning agent setup**`,
     sometimes two stacked, never a title-plus-prose-body. So strip the
     markers and show EVERY line; there is no body to split off, and a
     headline-only card must look finished rather than broken. */
  if(D.kind === 'THOUGHT'){
    const lines = String(D.quote || D.body || D.label || '').split('\n')
      .map(l => l.replace(/\*\*/g, '').replace(/^\s*[#>]+\s*/, '').trim())
      .filter(Boolean);
    D.quote  = lines.join('\n');
    D.label  = '';
    D.detail = ev.detail && !/^thought$/i.test(ev.detail) ? ev.detail
             : lines.length > 1 ? lines.length + ' reasoning steps' : 'reasoning · the agent’s own words';
    D.body   = ''; D.face = ''; D.narr = '';
  }

  if(D.face && D.face === D.quote) D.face = '';
  return D;
}

function scrollRail(){
  const y = Math.max(0, rail.offsetHeight + 24 - railWrap.clientHeight);
  rail.style.transform = `translate3d(0,${-y}px,0)`;
}

function collapseOpen(){
  if(typer){ clearInterval(typer.h); typer.finish(); typer = null; }
  if(openRow){ openRow.classList.remove('open'); openRow.classList.add('dim'); openRow = null; }
}

function trimRail(){
  while(rail.children.length > MAX_ROWS){
    const dead = rail.firstElementChild;
    for(const [k, v] of rowsById) if(v === dead) rowsById.delete(k);
    dead.remove();
  }
}

/* an honest marker for time the replay compressed away */
function gapChip(seconds){
  $('#railHint').classList.add('gone');
  rail.appendChild(el('div', 'gapchip', `⋯ thinking ${Math.round(seconds)}s`));
  trimRail();
  requestAnimationFrame(scrollRail);
}

function onTool(ev){
  $('#railHint').classList.add('gone');
  const D = derive(ev);

  /* a THOUGHT card in the agent's own words, lifted out of the draft it is
     emitting — shown BEFORE the draft row that carried it */
  if(D.think) onTool({type:'tool', kind:'THOUGHT', status:'ok',
                      id:(ev.id || 'e' + rail.children.length) + '#think',
                      detail:'its own words · from the draft it just emitted',
                      quote:D.think});

  const kind = D.kind;

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
       <div class="rowface">
         <div class="quote" hidden></div>
         <div class="narr" hidden title="Written by this dashboard from the command that ran — NOT the agent's own words."><b>&rsaquo;</b><span></span></div>
         <div class="raw" hidden></div>
       </div>
       <div class="rowbody"><pre></pre></div>`;
    rail.appendChild(row);
    if(ev.id) rowsById.set(ev.id, row);
    row.classList.add('clickable');
    row.addEventListener('click', () => openRowDetail(row));
    trimRail();
    showLegend();
  }
  /* keep the FULL event on the node — the start event carries the command,
     the completion event carries exit/ms/tokens. The drawer wants both. */
  row._ev = Object.assign({}, row._ev || {}, ev);
  row._D  = D;

  row.dataset.status = ev.status || 'ok';
  row.className = 'row k-' + kind +
    (row.classList.contains('open') ? ' open' : '') +
    (row.classList.contains('dim')  ? ' dim'  : '') +
    (D.mono ? ' mono' : '');
  if(ev.status === 'fail') row.classList.add('fail');

  row.querySelector('.ic').textContent     = ICON[kind] || '·';
  row.querySelector('.kind').textContent   = VERB[kind] || kind;
  row.querySelector('.label').textContent  = D.label;
  row.querySelector('.detail').textContent = D.detail;
  row.querySelector('.tok').textContent    = ev.tokens ? fmtTok(ev.tokens) + ' tok' : '';
  row.querySelector('.ms').textContent     = ev.ms ? ev.ms + 'ms' : '';
  row.querySelector('.st').textContent     = kind === 'THOUGHT' ? '' : (MARK[ev.status] || '✓');

  const q = row.querySelector('.quote');
  q.hidden = !D.quote; if(D.quote) q.textContent = mend(D.quote);
  const nr = row.querySelector('.narr');
  nr.hidden = !D.narr; if(D.narr) nr.querySelector('span').textContent = D.narr;
  const rw = row.querySelector('.raw');
  rw.hidden = !D.face; if(D.face) rw.textContent = D.face;
  row.querySelector('.rowface').hidden = !(D.quote || D.narr || D.face);

  if(ev.tokens){
    S.tally[ev.id || ('_' + rail.children.length)] = ev.tokens;
    setTokens(Object.values(S.tally).reduce((a, b) => a + b, 0));
  }

  /* expand once per distinct body — the completion event repeats the command
     verbatim, and re-typing it was half of why the rail read as a terminal */
  if(D.body){
    const sig = D.body.length + ':' + D.body.slice(0, 48);
    if(row.dataset.sig !== sig){
      row.dataset.sig = sig;
      if(openRow && openRow !== row) collapseOpen();
      row.classList.remove('dim'); row.classList.add('open');
      openRow = row;
      startBody(row, D.code, D.body);
    }
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

function startBody(row, code, body){
  const lines = body.replace(/\s+$/,'').split('\n');
  const shown = lines.slice(0, BODY_LINES).join('\n');
  const extra = Math.max(0, lines.length - BODY_LINES);
  const pre   = row.querySelector('pre');

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
let lastLog = 0;

function spawnSlip(txt, cls, dur){
  const n = document.createElement('div');
  n.className = 'slipline ' + cls;
  n.textContent = txt;
  n.style.left   = (20 + Math.random()*430) + 'px';
  n.style.bottom = (18 + Math.random()*300) + 'px';
  n.style.animationDuration = dur + 'ms';
  n.addEventListener('animationend', () => {
    n.remove();
    const i = live.indexOf(n); if(i >= 0) live.splice(i,1);
  }, {once:true});
  slip.appendChild(n); live.push(n);
  while(live.length > MAX_SLIP) live.shift().remove();
}

function onLog(ev){
  S.logLines++;
  const txt = String(ev.text || '').replace(/\s+$/,'').slice(0, 96);
  if(!txt) return;
  lastLog = Date.now();
  setThinking(false);
  spawnSlip(txt, BAD.test(txt) ? 's-bad' : (ev.stream === 'stderr' ? 's-err' : 's-out'),
            760 + Math.random()*180);
}

/* ── the quiet ────────────────────────────────────────────────────────
   The agent genuinely goes silent for 30–60s at a stretch. Rather than
   let the panel die, SAY SO: abstract particles plus an honest counter.
   None of this is invented agent output — it is the dashboard admitting
   it is waiting, which is what makes the wait read as suspense.        */
const IDLE_GLYPH = ['·','∴','⋯','┈','◦','∘'];
const thinkBar = el('div', 'thinkbar',
  '<span class="tdots"><i></i><i></i><i></i></span><span class="ttxt"></span>');
railWrap.appendChild(thinkBar);

const legend = el('div', 'raillegend',
  '<b>&rsaquo;</b> italic lines are this dashboard’s label for the action — not the agent’s words');
railWrap.appendChild(legend);
function showLegend(){ legend.classList.add('on'); }

function setThinking(on, secs){
  thinkBar.classList.toggle('on', !!on);
  if(on) thinkBar.querySelector('.ttxt').textContent =
    'agent thinking · ' + secs + 's since last output';
}

setInterval(() => {
  const alive = S.t0 && /^(spawning|running|verifying)$/.test(S.phase) && $('#tomb').hidden;
  if(!alive || (typeof A2 !== 'undefined' && A2.open)){ setThinking(false); return; }
  const gap = Date.now() - (lastLog || S.t0);
  if(gap < 1400){ setThinking(false); return; }
  setThinking(true, Math.round(gap / 1000));
  if(Math.random() < 0.72)
    spawnSlip(IDLE_GLYPH[(Math.random() * IDLE_GLYPH.length) | 0], 's-idle', 1500 + Math.random()*520);
}, 420);

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
  S.lastVerdict = v;
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
  paintNowNote();
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
  S.runId = ev.run_id || d.run_id || RP.id || S.runId || '';
  if(typeof navReady === 'function') navReady();
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
  .then(() => {
    connect();
    /* ?auto=1 — presentation mode: no chrome, no click, straight through */
    if(AUTO) document.body.classList.add('auto');
    if(REPLAY){ RP.on = true; refreshNow(); runReplay(REPLAY); }
    else if(ACT2Q) jumpToAct2(ACT2Q);
  });

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
    if(!S.t0) $('#railHint').textContent = 'idle · press SPACE or ▶ RUN ANALYSIS';
  }, 3500);
}

/* ══════════════════════════════════════════════════════════════════════
   REPLAY — re-emit a stored REAL run through the same handle() pipeline.
   GET /api/runs        -> [{run_id, ...}, ...]   (newest first)
   GET /api/runs/<id>   -> {events:[...]} | [...]
   Entries may be a bare event, or {t, event} / {ts, event}. Original
   inter-event timing is honoured when timestamps exist, else paced by type.
   ══════════════════════════════════════════════════════════════════════ */
const tsOf = e => {
  if(!e || typeof e !== 'object') return null;
  for(const k of ['t','ts','time','at','offset','elapsed_s'])
    if(typeof e[k] === 'number') return e[k];
  return null;
};
const evOf = e => (e && typeof e === 'object' && e.event && !e.type) ? e.event : e;

/* ── pacing ────────────────────────────────────────────────────────────
   "Appear the same way full, but be fast": every event plays, none is
   skipped. Only DEAD AIR is compressed, and every second removed is
   announced on the rail as `⋯ thinking 47s`, so the audience always sees
   that time passed and how much.

     rate 1  true original timing, nothing collapsed
     rate 2  gap × 0.35, capped at 1200ms   ← default, ~650s run in ~70s
     rate 4  gap × 0.175, capped at 600ms

   Older recordings carry no timestamps at all; those fall back to a
   per-type rhythm scaled by the same rate. Both paths must work.       */
function gapMs(prev, cur){
  const r = RP.rate;
  const a = tsOf(prev), b = tsOf(cur);
  if(a != null && b != null){
    const raw = (b - a) * ((Math.abs(b - a) < 1000) ? 1000 : 1);   // seconds vs ms
    if(isFinite(raw) && raw >= 0){
      if(r <= 1) return { ms: Math.min(30000, Math.max(8, raw)), skipped: 0 };
      const cap = 1200 * 2 / r, f = 0.35 * 2 / r;
      const ms  = Math.min(cap, raw * f);
      return { ms: Math.max(8, ms), skipped: raw * f > cap ? raw / 1000 : 0 };
    }
  }
  const t = (evOf(cur) || {}).type;
  const base = t === 'log' ? 42 : t === 'tool' ? 300 : 520;
  return { ms: Math.max(8, base * 2 / r), skipped: 0 };
}

function playEvents(list, meta){
  const evs = (Array.isArray(list) ? list : (list && (list.events || list.stream)) || [])
    .filter(Boolean);
  if(!evs.length){ toast('run has no recorded stream'); return false; }
  resetRun();
  RP.on = true;
  RP.headline = (meta && meta.headline) || RP.headline || '';
  RP.id = (meta && meta.run_id) || RP.id || '';
  setNow('replay');
  $('#railHint').textContent = 'REPLAY · ' + (RP.id || 'recorded run');
  const token = ++RP.token;
  let i = 0;
  (function step(){
    if(token !== RP.token || i >= evs.length){ if(token === RP.token) RP.done = true; return; }
    const cur = evs[i];
    handle(evOf(cur));
    i++;
    if(i >= evs.length){ RP.done = true; return; }
    const g = gapMs(cur, evs[i]);
    if(g.skipped >= 3) gapChip(g.skipped);
    setTimeout(step, g.ms);
  })();
  return true;
}

const runsIndex = () => fetch('/api/runs').then(r => r.ok ? r.json() : Promise.reject(r.status))
  .then(l => (Array.isArray(l) ? l : (l && l.runs) || []));
const runIdOf = r => typeof r === 'string' ? r : (r && (r.run_id || r.id)) || null;

function resolveRun(id){
  if(id && id !== 'last' && id !== '1') return Promise.resolve(id);
  return runsIndex().then(rs => {
    const first = runIdOf(rs[0]);
    return first || Promise.reject('no stored runs');
  });
}
function fetchRun(id){
  return resolveRun(id)
    .then(rid => fetch('/api/runs/' + encodeURIComponent(rid)).then(r => r.ok ? r.json() : Promise.reject(r.status)));
}
function runReplay(id){
  fetchRun(id)
    .then(run => {
      const meta = { run_id: (run && (run.run_id || run.id)) || (typeof id === 'string' ? id : ''),
                     headline: (run && ((run.news || {}).headline || run.headline ||
                                        ((run.result || {}).headline))) || '' };
      /* a run with no recorded stream is not broken — it just has no arena */
      if(!playEvents(run, meta) && run && run.result){
        RP.on = true; RP.headline = meta.headline; RP.id = meta.run_id;
        setNow('replay'); S.lastResult = run.result; openAct2(run.result);
      }
    })
    .catch(e => { toast('replay unavailable · ' + String(e).slice(0,50)); });
}
/* ?act2=<id|last> — skip the arena, open Act II on that run's result */
function jumpToAct2(id){
  fetchRun(id)
    .then(run => {
      const evs = (Array.isArray(run) ? run : (run && (run.events || run.stream)) || []).map(evOf);
      const res = evs.filter(e => e && e.type === 'result').pop();
      if(!res || !res.data) return Promise.reject('run has no result event');
      S.lastResult = res.data;
      openAct2(res.data);
    })
    .catch(e => toast('cannot open Act II · ' + String(e).slice(0,50)));
}

/* ══════════════════════════════════════════════════════════════════════
   PART 1 · RUN CONTROLS — news strip, RUN button, SPACE, live scan
   ══════════════════════════════════════════════════════════════════════ */
let NEWS_EVENTS = [];
S.sel = new Set();                       // multi-select: any number, or all

function newsMeta(n){
  const d = (n.published_at || '').slice(0,10);
  const tk = (n.tickers_hint || []).slice(0,4).join(' ');
  return [tk, d].filter(Boolean).join('  ·  ');
}
function renderNewsStrip(){
  const box = $('#newsStrip'); box.innerHTML = '';
  NEWS_EVENTS.slice(0,5).forEach(n => {
    const on = S.sel.has(n.id);
    const b = el('button', 'nchip' + (on ? ' sel' : ''),
      `<span class="nbox">${on ? '☑' : '☐'}</span>
       <span class="ntxt"><span class="nh">${esc(n.headline || n.id)}</span>
       <span class="nm">${esc(newsMeta(n))}</span></span>`);
    b.title = n.summary || '';
    b.onclick = () => {
      S.sel.has(n.id) ? S.sel.delete(n.id) : S.sel.add(n.id);
      if(!S.sel.size) S.sel.add(n.id);          // never leave RUN with nothing
      renderNewsStrip(); updateRunLabel();
    };
    box.appendChild(b);
  });
  $('#allBtn').textContent = S.sel.size === NEWS_EVENTS.length ? '☑ ALL' : '☐ ALL';
}
function selectedNews(){ return NEWS_EVENTS.filter(n => S.sel.has(n.id)); }
function updateRunLabel(){
  const n = S.sel.size;
  const t = $('#runBtn').querySelector('.rbHint');
  if(t && !S.running) t.textContent = n > 1 ? n + ' EVENTS · SPACE' : 'press SPACE';
}
function adoptNews(list){
  const arr = (Array.isArray(list) ? list : (list && (list.events || list.news)) || [])
    .filter(n => n && (n.headline || n.title));
  if(!arr.length) return false;                 // never empty the strip
  NEWS_EVENTS = arr.map(n => Object.assign({}, n, {
    id: n.id || n.news_id || (n.url || n.headline || '').slice(0,60),
    headline: n.headline || n.title
  }));
  const keep = new Set(NEWS_EVENTS.filter(n => S.sel.has(n.id)).map(n => n.id));
  S.sel = keep.size ? keep : new Set([NEWS_EVENTS[0].id]);
  renderNewsStrip(); updateRunLabel();
  NEWS = NEWS_EVENTS.map(n => n.headline).slice(0,8);
  renderTicker();
  return true;
}

$('#allBtn').onclick = () => {
  S.sel = S.sel.size === NEWS_EVENTS.length
    ? new Set(NEWS_EVENTS.slice(0,1).map(n => n.id))
    : new Set(NEWS_EVENTS.map(n => n.id));
  renderNewsStrip(); updateRunLabel();
};

fetch('/api/news').then(r => r.ok ? r.json() : Promise.reject(0))
  .then(l => adoptNews(l))
  .catch(() => { $('#newsStrip').innerHTML = '<div class="nempty">no news wire · GET /api/news unavailable</div>'; });

/* ── read-only prompt panel ───────────────────────────── */
$('#promptBtn').onclick = () => {
  const p = $('#a2prompt');
  if(!p.hidden){ p.hidden = true; return; }
  p.innerHTML = '<div class="evTitle">CODEX PROMPT · READ-ONLY</div><pre class="pmt">loading…</pre>';
  p.hidden = false;
  fetch('/api/prompt').then(r => r.ok ? r.text() : Promise.reject(r.status))
    .then(t => {
      let s = t;
      try{ const j = JSON.parse(t); s = typeof j === 'string' ? j : (j.prompt || j.text || t); }catch(_){}
      p.querySelector('.pmt').textContent = s;
    })
    .catch(e => { p.querySelector('.pmt').textContent = 'GET /api/prompt unavailable (' + e + ')'; });
  p.onclick = ev => { if(ev.target === p) p.hidden = true; };
};

/* ══════════════════════════════════════════════════════════════════════
   THE NOW CHIP — what is on this screen, right now, readable from the back
   of the room. A replay must never be mistakable for a live run; the
   content is genuine either way, so saying which costs us nothing.
   ══════════════════════════════════════════════════════════════════════ */
const NOWC = {
  live    : ['●', 'LIVE',         'nowlive'],
  external: ['●', 'EXTERNAL RUN', 'nowext'],
  replay  : ['▷', 'REPLAY',       'nowrep'],
  idle    : ['○', 'IDLE',         'nowidle'],
};
let nowChip = null, nowMode = 'idle';
function ensureNow(){
  if(nowChip) return nowChip;
  nowChip = el('div', 'hudcell hudnow nowidle',
    '<span class="hudlab">STATUS</span>' +
    '<div class="nowRow"><span class="nowGlyph">○</span><span class="nowWord">IDLE</span>' +
    '<span class="nowNote"></span></div>');
  const hs = $('#hudStats'); if(hs) hs.insertBefore(nowChip, hs.firstChild);
  return nowChip;
}
function setNow(mode){
  ensureNow();
  if(mode) nowMode = mode;
  const d = NOWC[nowMode] || NOWC.idle;
  nowChip.className = 'hudcell hudnow ' + d[2];
  nowChip.querySelector('.nowGlyph').textContent = d[0];
  nowChip.querySelector('.nowWord').textContent  = d[1];
  paintNowNote();
}
function paintNowNote(){
  if(!nowChip) return;
  const t = fmtMS(S.elapsed);
  nowChip.querySelector('.nowNote').textContent =
    nowMode === 'replay' ? (RP.rate + 'x · ' + clipTxt(RP.headline || RP.id || 'recorded run', 46) + ' · ' + t)
  : nowMode === 'live'   ? (S.phase === 'idle' ? '' : S.phase) + ' · ' + t
  : nowMode === 'external' ? 'started in another tab'
  : 'press SPACE to run · L to replay';
}
const clipTxt = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
ensureNow(); setNow('idle');

/* ══════════════════ THE REPLAY PICKER — compact, keyboard `L` ═════════ */
const rpBtn = el('button', 'rpBtn', '▷<span>REPLAY</span>');
const rpPanel = el('div', 'rpPanel');
rpPanel.hidden = true;
(function mountPicker(){
  const hn = $('#hudNews');
  if(hn) hn.insertBefore(rpBtn, hn.children[2] || null);
  $('#viewport').appendChild(rpPanel);
})();

function rpHead(){
  return `<div class="rpTop"><b>▷ REPLAY A PAST RUN</b>
    <span class="rpSp">
      ${[1,2,4].map(r => `<button data-r="${r}" class="${RP.rate===r?'on':''}">${r}x</button>`).join('')}
    </span>
    <span class="rpHint">1x = true original timing · 2x/4x collapse only the dead air, every event still plays</span>
    <span class="rpX">ESC</span></div>`;
}
function rpRow(r){
  const hz = [r.short_base, r.medium_base, r.long_base]
    .map(v => typeof v === 'number' ? (v >= 0 ? '+' : '') + v.toFixed(2) : '—').join(' / ');
  const when = r.started_at
    ? new Date(r.started_at * (r.started_at > 1e11 ? 1 : 1000)).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'})
    : '—';
  return `<button class="rpRow${r.has_events === false ? ' noev' : ''}" data-id="${esc(r.run_id)}" data-ev="${r.has_events === false ? 0 : 1}">
    <span class="rpV ${r.passed ? 'p' : 'f'}">${r.passed ? 'PASS' : 'FAIL'}</span>
    <span class="rpH">${esc(clipTxt(r.headline || r.run_id, 54))}</span>
    <span class="rpM">${when}</span>
    <span class="rpM">${r.elapsed_s ? Math.round(r.elapsed_s) + 's' : '—'}</span>
    <span class="rpM">${r.has_events === false ? 'result only' : (r.event_count || '') + ' events'}</span>
    <span class="rpZ">${hz}</span></button>`;
}
function renderPicker(){
  let body;
  try{ body = RP.runs.slice(0, 8).map(rpRow).join(''); }
  catch(e){ body = ''; RP.err = String(e).slice(0, 90); }
  rpPanel.innerHTML = rpHead() + (body ||
    `<div class="rpEmpty">${esc(RP.err || 'loading past runs…')}</div>`);
  rpPanel.querySelectorAll('.rpSp button').forEach(b => b.onclick = e => {
    e.stopPropagation(); RP.rate = +b.dataset.r; renderPicker(); paintNowNote();
  });
  rpPanel.querySelectorAll('.rpRow').forEach(b => b.onclick = () => {
    closePicker();
    closeAct2(true);
    RP.headline = ''; RP.id = b.dataset.id;
    if(b.dataset.ev === '0'){ jumpToAct2(b.dataset.id); RP.on = true; setNow('replay'); }
    else runReplay(b.dataset.id);
  });
  rpPanel.querySelector('.rpX').onclick = closePicker;
}
function openPicker(){
  rpPanel.hidden = false; renderPicker();
  runsIndex().then(rs => { RP.runs = rs.filter(r => r && r.run_id); renderPicker(); })
             .catch(() => renderPicker());
}
function closePicker(){ rpPanel.hidden = true; }
rpBtn.onclick = () => rpPanel.hidden ? openPicker() : closePicker();

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
  S.seenProse = new Set(); S.seenSearch = new Set();
  lastLog = 0; setThinking(false); legend.classList.remove('on');
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
  if(!on){ S.mine = false; S.external = false; }
  const b = $('#runBtn');
  b.disabled = on;
  b.classList.toggle('busy', on);
  b.classList.toggle('ext', !!(on && S.external));
  b.classList.toggle('rep', !!(on && RP.on));
  /* a replay must never wear the live run's label */
  b.querySelector('.rbTxt').textContent =
    !on ? 'RUN ANALYSIS' : RP.on ? 'REPLAY' : S.external ? 'EXTERNAL RUN' : 'RUNNING…';
  b.querySelector('.rbIcon').textContent = on ? (RP.on ? '▷' : '◐') : '▶';
  const h = b.querySelector('.rbHint');
  if(h) h.textContent = !on ? ((S.sel && S.sel.size > 1) ? S.sel.size + ' EVENTS · SPACE' : 'press SPACE · L to replay')
       : RP.on ? 'recorded run · ' + RP.rate + 'x'
       : S.external ? 'started in another tab' : 'this tab';
  refreshNow();
}

function triggerRun(){
  if(S.running) return;
  const news = selectedNews();
  if(!news.length){ toast('select at least one news event'); return; }
  RP.on = false; RP.token++;              // a live run cancels any playback
  S.mine = true; S.external = false;
  setRunning(true);                       // disable immediately — belt and braces
  resetRun();
  // full objects, never ids — one combined analysis, one sandbox
  fetch('/api/trigger', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({news})
  })
  .then(r => r.ok ? r.json() : r.text().then(t => Promise.reject(r.status + ' ' + t)))
  .catch(e => { toast('could not start run · ' + String(e).slice(0,60));
                S.mine = false; setRunning(false); });
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

/* Health probe keeps the HUD honest if a run was started elsewhere. A run
   this tab did not start is labelled EXTERNAL RUN — never silently "busy". */
setInterval(() => {
  if(RP.on) return;                         // playback owns the chip
  fetch('/api/health').then(r => r.json()).then(h => {
    const r = (h && h.run) || {};
    if(typeof r.active !== 'boolean') return;
    S.external = !!(r.active && !S.mine);
    if(r.active !== S.running) setRunning(r.active);
    else { setRunning(r.active); }          // refresh caption / chip in place
  }).catch(() => {});
}, 3000);

addEventListener('keydown', e => {
  if(e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k = e.key;
  if(k === 'l' || k === 'L'){ e.preventDefault(); rpPanel.hidden ? openPicker() : closePicker(); return; }
  if(!rpPanel.hidden && k === 'Escape'){ e.preventDefault(); closePicker(); return; }
  if(k === ' ' || k === 'Spacebar'){ e.preventDefault(); closePicker(); closeAct2(); triggerRun(); return; }
  /* the drawer owns ESC while it is up */
  if(k === 'Escape' && drawerOpen()){ e.preventDefault(); closeRowDetail(); return; }
  if(k === 's' || k === 'S'){ e.preventDefault(); goView('analysis'); return; }
  if(!A2.open){
    if(k === 'a' || k === 'A' || k === 'Escape'){ e.preventDefault(); goView('arena'); return; }
    if(k === 'v' || k === 'V'){ e.preventDefault(); S.lastResult ? openAct2(S.lastResult) : jumpToAct2('last'); }
    return;
  }
  if(/^[123]$/.test(k)){ e.preventDefault(); setHorizon(HZ[+k - 1]); return; }
  if(k === 'Escape'){ e.preventDefault(); if(!$('#a2detail').hidden || !$('#a2evpanel').hidden) closeDetail(); else closeAct2(); }
  else if(k === 'a' || k === 'A'){ e.preventDefault(); closeAct2(); }
  else if(k === 'ArrowRight'){ e.preventDefault(); stepCard(1); }
  else if(k === 'ArrowLeft'){ e.preventDefault(); stepCard(-1); }
});

/* ══════════════════════════════════════════════════════════════════════
   PART 2 · ACT II — THE VERDICT
   ══════════════════════════════════════════════════════════════════════ */
const A2 = { open:false, cards:[], order:[], sel:-1, timers:[], fall:null,
             cites:[], byTicker:{}, data:null, hz:'long_term', dom:1, casc:null, focus:0 };

/* A2.instant collapses every beat to "now" — used when RE-ENTERING an
   analysis that was already built, so the switcher feels like a tab and
   not like a replay of the reveal. The first open is always cinematic. */
const after = (ms, fn) => {
  if(A2.instant){ try{ fn(); }catch(e){ console.error('beat', e); } return; }
  A2.timers.push(setTimeout(fn, ms / SPEED));
};
const clearBeats = () => { A2.timers.forEach(clearTimeout); A2.timers = []; };
const clip = (s, n) => String(s||'').length > n ? String(s).slice(0, n - 1) + '…' : String(s||'');
const dots = c => { const f = Math.round(Math.max(0, Math.min(1, c || 0)) * 5);
  return '<b>' + '●'.repeat(f) + '</b>' + '○'.repeat(5 - f); };
const host = u => { try{ return new URL(u).host.replace(/^www\./,''); }catch(_){ return String(u||'').slice(0,42); } };

/* ── horizon model · every field optional, nothing may blank ──── */
const HZ = ['short_term','medium_term','long_term'];
const HZLAB = {short_term:'SHORT', medium_term:'MEDIUM', long_term:'LONG'};
const num = (v, alt) => typeof v === 'number' && isFinite(v) ? v : alt;

function hzOf(p, h){ return (p && p.horizons && p.horizons[h]) || null; }

/* impact band in pct for one position at one horizon; falls all the way back
   to a flat impact_pct so a payload with no horizons still renders. */
function band(p, h){
  const o = hzOf(p, h), ip = o && o.impact_pct;
  if(ip && typeof ip === 'object' && typeof ip.base === 'number')
    return { low:num(ip.low, ip.base), base:ip.base, high:num(ip.high, ip.base) };
  if(typeof ip === 'number') return { low:ip, base:ip, high:ip };
  const f = num(p && p.impact_pct, 0);
  return { low:f, base:f, high:f };
}
function bandUsd(p, h){
  const o = hzOf(p, h), iu = o && o.impact_usd;
  if(iu && typeof iu === 'object' && typeof iu.base === 'number')
    return { low:num(iu.low, iu.base), base:iu.base, high:num(iu.high, iu.base) };
  const b = band(p, h), v = num(p && p.value_before_usd, 0);
  const f = x => v * x / 100;
  return { low:f(b.low), base:num(p && p.impact_usd, f(b.base)), high:f(b.high) };
}
/* portfolio band: declared if present, else summed from the positions */
function pBand(d, h){
  const o = (d.horizons && d.horizons[h]) || null, ip = o && o.impact_pct;
  if(ip && typeof ip === 'object' && typeof ip.base === 'number')
    return { low:num(ip.low, ip.base), base:ip.base, high:num(ip.high, ip.base) };
  const acc = { low:0, base:0, high:0 };
  (d.positions || []).forEach(p => {
    const b = band(p, h), w = num(p.weight_pct, 0) / 100;
    acc.low += w * b.low; acc.base += w * b.base; acc.high += w * b.high;
  });
  if(!(d.positions || []).length) { const f = num(d.portfolio_impact_pct, 0); return {low:f,base:f,high:f}; }
  return acc;
}
function pBandUsd(d, h){
  const o = (d.horizons && d.horizons[h]) || null, iu = o && o.impact_usd;
  if(iu && typeof iu === 'object' && typeof iu.base === 'number')
    return { low:num(iu.low, iu.base), base:iu.base, high:num(iu.high, iu.base) };
  const acc = { low:0, base:0, high:0 };
  (d.positions || []).forEach(p => { const b = bandUsd(p, h); acc.low += b.low; acc.base += b.base; acc.high += b.high; });
  return acc;
}
/* which horizons does this payload actually carry? */
function liveHorizons(d){
  const hit = HZ.filter(h => (d.positions || []).some(p => hzOf(p, h)));
  return hit.length ? hit : ['long_term'];
}

/* ── big-money formatting ──────────────────────────────────── */
function fmtBig(n){
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if(a >= 1e12) return s + '$' + (a/1e12).toFixed(2) + 'tn';
  if(a >= 1e9)  return s + '$' + (a/1e9).toFixed(1)  + 'bn';
  if(a >= 1e6)  return s + '$' + (a/1e6).toFixed(0)  + 'm';
  if(a >= 1e3)  return s + '$' + (a/1e3).toFixed(0)  + 'k';
  return s + '$' + a.toFixed(0);
}
const pctOf = f => (f * 100).toFixed(f * 100 % 1 ? 1 : 0) + '%';

/* ══ BEAT A · the value cascade ═════════════════════════════════
   Six challengeable steps from the position's own fundamentals.    */
const WHY = {
  revenue_line_usd : 'The annual revenue line actually exposed to this event — not total company revenue. Narrowing to the exposed line is what keeps the estimate honest.',
  affected_fraction: 'The share of that revenue line the disruption actually touches. Everything outside it keeps earning normally.',
  duration_months  : 'How long the disruption runs, expressed as a fraction of a year. A two-week outage cannot destroy a year of revenue.',
  permanent_share  : 'Of the revenue disrupted, the share that is permanently lost rather than merely deferred. Deferred revenue arrives late; it is not destroyed.',
  margin           : 'Revenue is not value. Only the profit on lost revenue is lost, so the operating margin converts the top line into forgone earnings.',
  earnings_multiple: 'The market capitalises earnings. Multiplying the permanent earnings loss by the multiple converts an income effect into a value effect.',
  market_cap_usd   : 'Dividing the value at stake by market capitalisation expresses the damage as a share price move — comparable across the whole book.'
};

function cascadeOf(p){
  const f = ['revenue_line_usd','affected_fraction','duration_months',
             'permanent_share','margin','earnings_multiple','market_cap_usd'];
  if(!f.every(k => typeof p[k] === 'number' && isFinite(p[k]))) return null;
  const steps = [];
  let v = p.revenue_line_usd;
  steps.push({ head:true, op:'REVENUE LINE', lab:p.value_basis || 'exposed annual revenue', val:v, key:'revenue_line_usd' });
  v *= p.affected_fraction;
  steps.push({ op:'× ' + pctOf(p.affected_fraction), lab:'affected', val:v, key:'affected_fraction' });
  v *= p.duration_months / 12;
  steps.push({ op:'× ' + p.duration_months + '/12', lab:'months disrupted', val:v, key:'duration_months' });
  v *= p.permanent_share;
  steps.push({ op:'× ' + pctOf(p.permanent_share), lab:'permanently lost', val:v, key:'permanent_share' });
  v *= p.margin;
  steps.push({ op:'× ' + pctOf(p.margin), lab:'margin', val:v, key:'margin', sfx:'profit forgone' });
  v *= p.earnings_multiple;
  steps.push({ op:'× ' + p.earnings_multiple, lab:'earnings multiple', val:v, key:'earnings_multiple', sfx:'value at stake' });
  const vas = num(p.value_at_stake_usd, v);
  const sign = band(p, 'long_term').base >= 0 ? 1 : -1;
  const pct = sign * Math.abs(vas / p.market_cap_usd * 100);
  steps.push({ fin:true, op:'÷ ' + fmtBig(p.market_cap_usd), lab:'market cap', pct:pct, key:'market_cap_usd' });
  return { steps, vas, pct };
}

function buildCascade(i, animate){
  const p = A2.order[i]; if(!p) return;
  A2.focus = i;
  const box = $('#a2casc');
  $('#a2cascTk').textContent = p.ticker;
  const c = cascadeOf(p);
  A2.casc = c;
  box.innerHTML = '';
  if(!c){
    box.appendChild(el('div','cscNone',
      `no fundamental chain supplied for ${esc(p.ticker)} · showing ${fmtPct(band(p, A2.hz).base)} at ${HZLAB[A2.hz]} horizon`));
    return;
  }
  c.steps.forEach((s, k) => {
    const r = el('div', 'csr' + (s.head ? ' head' : '') + (s.fin ? ' fin' : ''),
      `<span class="op">${esc(s.op)}</span>
       <span class="lb">${esc(s.lab)}</span>
       <span class="vl">${s.pct != null ? fmtPct(s.pct) : fmtBig(s.val)}
         ${s.sfx ? `<span class="sfx">${esc(s.sfx)}</span>` : ''}</span>`);
    if(s.fin) r.querySelector('.vl').style.color = s.pct < 0 ? 'var(--red)' : 'var(--green)';
    if(animate){ r.classList.add('pend'); after(k * 300 + 40, () => r.classList.remove('pend')); }
    r.onclick = () => {
      box.querySelectorAll('.csr').forEach(x => x.classList.remove('on'));
      r.classList.add('on');
      $('#a2cascWhy').innerHTML = `<b>${esc(s.lab)}</b> — ${esc(WHY[s.key] || '')}` +
        (p.variant_basis ? ` <i style="color:var(--overlay)">${esc(p.variant_basis)}</i>` : '');
    };
    box.appendChild(r);
  });
  const why = el('div', '', ''); why.id = 'a2cascWhy';
  why.textContent = 'Click any step above to see why it is there. Every step is separately challengeable.';
  box.appendChild(why);
}

/* ══ BEAT B · the fan ═══════════════════════════════════════════ */
function fanDomain(positions){
  let m = 0.6;
  positions.forEach(p => HZ.forEach(h => { const b = band(p, h);
    m = Math.max(m, Math.abs(b.low), Math.abs(b.high), Math.abs(b.base)); }));
  return m * 1.08;
}
const fFrac = v => (v + A2.dom) / (2 * A2.dom);

function fanHTML(p, hzs){
  return `<div class="fan">` + hzs.map(h => {
    const b = band(p, h);
    return `<div class="fnr" data-h="${h}">
      <span class="fnl">${HZLAB[h][0]}</span>
      <span class="fnt"><span class="fnz" style="left:${(fFrac(0)*100).toFixed(2)}%"></span>
        <span class="fnb"></span><span class="fnk" style="left:${(fFrac(b.base)*100).toFixed(2)}%"></span></span>
      <span class="fnv">${fmtPct(b.base)}</span></div>`;
  }).join('') + `</div>`;
}
function paintFans(card, p, hzs){
  card.querySelectorAll('.fnr').forEach(row => {
    const h = row.dataset.h, b = band(p, h);
    const lo = fFrac(Math.min(b.low, b.high)), hi = fFrac(Math.max(b.low, b.high));
    const bar = row.querySelector('.fnb');
    bar.style.background = b.base < 0 ? 'rgba(243,139,168,.55)' : b.base > 0 ? 'rgba(166,227,161,.55)' : 'rgba(108,112,134,.5)';
    bar.style.transform = `translateX(${(lo*100).toFixed(3)}%) scaleX(${Math.max(0.012, hi - lo).toFixed(4)})`;
    const v = row.querySelector('.fnv');
    v.textContent = fmtPct(b.base);
    v.style.color = b.base < 0 ? 'var(--red)' : b.base > 0 ? 'var(--green)' : 'var(--overlay)';
    row.querySelector('.fnk').style.left = (fFrac(b.base)*100).toFixed(2) + '%';
    row.style.opacity = h === A2.hz ? '1' : '.5';
  });
}

/* ══ BEAT C · sentiment vs value ════════════════════════════════
   short_term is a sentiment method, long_term is the fundamental
   chain — so a gap between them is real signal, not decoration.   */
function divergence(p){
  const st = band(p, 'short_term').base, lt = band(p, 'long_term').base;
  if(!hzOf(p, 'short_term') || !hzOf(p, 'long_term')) return null;
  const d = st - lt, th = Math.max(0.75, Math.abs(lt) * 0.3);
  if(Math.abs(d) < th) return null;
  return d < 0
    ? { cls:'over',  txt:'SENTIMENT OVERSHOOT', gap:d,
        why:`The market is marking this down ${Math.abs(d).toFixed(2)}pp harder in the short term than the fundamental value damage justifies. Panic exceeds the value loss.` }
    : { cls:'under', txt:'UNDERPRICED', gap:d,
        why:`The short-term move is ${Math.abs(d).toFixed(2)}pp shallower than the long-term value damage. The market has not yet caught up to the fundamentals.` };
}

/* ══ BEAT D · horizon scrubber ══════════════════════════════════ */
function buildScrubber(d){
  const hzs = liveHorizons(d);
  const box = $('#a2hz'); box.innerHTML = '';
  hzs.forEach(h => {
    const b = el('button', 'hzb' + (h === A2.hz ? ' on' : ''), HZLAB[h]);
    b.onclick = () => setHorizon(h);
    b.dataset.h = h;
    box.appendChild(b);
  });
  if(!hzs.includes(A2.hz)) A2.hz = hzs[hzs.length - 1];
}
function setHorizon(h){
  if(!A2.open || !A2.data) return;
  if(!liveHorizons(A2.data).includes(h)) return;
  A2.hz = h;
  $$('#a2hz .hzb').forEach(b => b.classList.toggle('on', b.dataset.h === h));
  repriceBook();
}
/* one control, whole-screen consequence: cards, fans, band, waterfall
   and the arena treemap underneath all re-price together */
function repriceBook(){
  const d = A2.data, hzs = liveHorizons(d);
  A2.order.forEach((p, i) => {
    const c = A2.cards[i]; if(!c) return;
    const b = band(p, A2.hz);
    const imp = c.querySelector('.cImp');
    imp.textContent = fmtPct(b.base);
    imp.style.color = Math.abs(b.base) < 1e-9 ? 'var(--overlay)' : impactColor(b.base);
    c.style.borderLeftColor = Math.abs(b.base) < 1e-9 ? 'var(--surface2)' : impactColor(b.base);
    const m = c.querySelector('.cMath');
    if(m) m.innerHTML = `<em>w</em> ${num(p.weight_pct,0).toFixed(2)}% <em>×</em> ${fmtPct(b.base)} <em>=</em> ${((num(p.weight_pct,0)/100)*b.base).toFixed(2)}pp`;
    paintFans(c, p, hzs);
  });
  paintPortfolioBand();
  buildFall(A2.order, d, true);
  // the arena treemap re-prices too, so Esc returns to a consistent book
  if(S.portfolio) repaintTreemapAt(d, A2.hz);
}
function paintPortfolioBand(){
  const d = A2.data, b = pBand(d, A2.hz), u = pBandUsd(d, A2.hz);
  // the book band gets its OWN domain: portfolio moves are an order of
  // magnitude smaller than single-name moves and vanish on the shared scale
  let m = 0.25;
  HZ.forEach(h => { const x = pBand(d, h); m = Math.max(m, Math.abs(x.low), Math.abs(x.high)); });
  m *= 1.15;
  const pf = v => (v + m) / (2 * m);
  const track = $('#a2pband');
  track.innerHTML = `<span class="pz" style="left:${(pf(0)*100).toFixed(2)}%"></span>
    <span class="pb"></span><span class="pk" style="left:${(pf(b.base)*100).toFixed(2)}%"></span>`;
  const lo = pf(Math.min(b.low, b.high)), hi = pf(Math.max(b.low, b.high));
  const bar = track.querySelector('.pb');
  bar.style.background = b.base < 0 ? 'rgba(243,139,168,.55)' : 'rgba(166,227,161,.55)';
  requestAnimationFrame(() => {
    bar.style.transform = `translateX(${(lo*100).toFixed(3)}%) scaleX(${Math.max(0.008, hi-lo).toFixed(4)})`;
  });
  const n = $('#a2bandNum');
  n.textContent = fmtPct(b.base);
  n.style.color = b.base < 0 ? 'var(--red)' : 'var(--green)';
  n.title = `${fmtPct(b.low)} … ${fmtPct(b.high)}`;
  $('#a2usd').textContent = fmtUSD(num(d.portfolio_value_before_usd, 0)) + '  →  ' +
    fmtUSD(num(d.portfolio_value_before_usd, 0) + u.base);
  const pc = $('#a2pct');
  pc.textContent = fmtPct(b.base);
  pc.style.color = b.base < 0 ? 'var(--red)' : 'var(--green)';
}

/* the arena treemap, re-coloured for a horizon */
function repaintTreemapAt(d, h){
  const by = {}; (d.positions || []).forEach(p => by[p.ticker] = p);
  maxAbs = Math.max(0.01, ...(d.positions||[]).map(p => Math.abs(band(p, h).base)));
  tmData.forEach(t => {
    const p = by[t.name]; if(!p) return;
    const v = band(p, h).base;
    t.imp = v; t.itemStyle = { color: impactColor(v) }; t.label = { rich: rich(true) };
  });
  paint(true);
}

/* ══ open / close ═══════════════════════════════════════════════ */
function openAct2(d){
  if(!d || !Array.isArray(d.positions) || !d.positions.length || A2.open) return;
  S.lastResult = d;
  A2.open = true; A2.data = d; A2.sel = -1;
  if(typeof navReady === 'function'){ navReady(); setNav('analysis'); }
  clearBeats();
  A2.dom = fanDomain(d.positions);
  const hzs = liveHorizons(d);
  A2.hz = hzs[hzs.length - 1];
  maxAbs = Math.max(0.01, ...d.positions.map(p => Math.abs(band(p, A2.hz).base)));

  $('#grid').classList.remove('back'); $('#hud').classList.remove('back');
  $('#grid').classList.add('away');    $('#hud').classList.add('away');
  // opaque immediately — the arena collapsing over it is the transition.
  // No rAF-gated entrance class: a dropped frame must never leave it see-through.
  const a2 = $('#act2');
  a2.hidden = false; a2.classList.remove('closing', 'pre');

  const order = d.positions.slice().sort((a,b) => {
    const za = Math.abs(band(a,'long_term').base) < 1e-9, zb = Math.abs(band(b,'long_term').base) < 1e-9;
    if(za !== zb) return za ? 1 : -1;                      // zero-impact deal LAST
    return Math.abs(band(b, A2.hz).base) - Math.abs(band(a, A2.hz).base);
  });
  A2.order = order;
  matchCitations(d, order);
  buildHero(d);
  buildScrubber(d);

  after(200,  () => paintPortfolioBand());
  after(300,  () => buildCascade(0, true));                     // BEAT A
  after(2500, () => dealCards(order, d, hzs));                  // BEAT B + C
  after(2500 + order.length * 190 + 500, () => buildFall(order, d)); // BEAT E
}

function closeAct2(instant){
  if(!A2.open) return;
  A2.open = false; clearBeats(); closeDetail();
  if(typeof setNav === 'function') setNav('arena');
  const a = $('#act2');
  if(instant){ a.hidden = true; a.classList.remove('closing'); }
  else { a.classList.add('closing');
    setTimeout(() => { a.hidden = true; a.classList.remove('closing'); }, 460); }
  $('#grid').classList.remove('away'); $('#hud').classList.remove('away');
  $('#grid').classList.add('back');    $('#hud').classList.add('back');
}

function buildHero(d){
  $('#a2thesis').textContent = d.thesis || d.headline || '';
  $('#a2method').textContent = String(d.methodology || 'fundamental value').replace(/_/g,' ');
  const n = (d.citations || []).length;
  $('#a2evidence').textContent = 'EVIDENCE ×' + n;
  $('#a2evidence').onclick = () => openEvidence(d);
  const c = Math.max(0, Math.min(1, num(d.confidence, 0)));
  $('#a2confNum').textContent = c.toFixed(2);
  $('#a2confBar').style.transform = 'scaleX(0)';
  after(240, () => $('#a2confBar').style.transform = 'scaleX(' + c + ')');
}

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

/* ══ cards — fan (B) + divergence flag (C) ══════════════════════ */
function dealCards(order, d, hzs){
  const box = $('#a2cards'); box.innerHTML = ''; A2.cards = [];
  const top = order[0] ? order[0].ticker : null;

  order.forEach((p, i) => {
    const b = band(p, A2.hz);
    const zero = Math.abs(band(p, 'long_term').base) < 1e-9 && Math.abs(b.base) < 1e-9;
    const dv = divergence(p);
    const cite = A2.byTicker[p.ticker];
    const flags = ((!zero && p.ticker === top) ? '<span class="cFlag">★ TOP IMPACT</span>' : '') +
                  (dv ? `<span class="cFlagS ${dv.cls}">${dv.txt}</span>` : '');
    const c = el('div', 'a2card' + (zero ? ' zero' : ''),
      `<div class="cTop">
         <span class="cTk">${esc(p.ticker)}</span>
         <span class="cSec">${esc(p.sector || '')}</span>
         <span class="cImp">${fmtPct(b.base)}</span>
       </div>
       ${flags ? `<div class="cFlagRow">${flags}</div>` : ''}
       <div class="cNil">no material exposure</div>
       ${fanHTML(p, hzs)}
       <div class="cMath"><em>w</em> ${num(p.weight_pct,0).toFixed(2)}% <em>×</em> ${fmtPct(b.base)} <em>=</em> ${((num(p.weight_pct,0)/100)*b.base).toFixed(2)}pp${cite ? ' <em>·</em> &#128279;' : ''}</div>`);
    c.classList.add('pend');
    after(i * 170 + 40, () => c.classList.remove('pend'));
    c.dataset.ticker = p.ticker;
    c.style.borderLeftColor = zero ? 'var(--surface2)' : impactColor(b.base);
    c.querySelector('.cImp').style.color = zero ? 'var(--overlay)' : impactColor(b.base);
    c.onclick = () => { buildCascade(i, true); openDetail(i); };
    box.appendChild(c); A2.cards.push(c);
    after(i * 170 + 240, () => paintFans(c, p, hzs));
  });
}

/* ══ BEAT E · banded reconciliation waterfall ═══════════════════ */
function buildFall(order, d, instant){
  const el2 = $('#a2fall');
  if(!A2.fall){
    A2.fall = echarts.init(el2, null, {renderer:'canvas'});
    A2.fall.on('click', p => {
      // custom series: category index lives in value[0], not params.name
      const idx = Array.isArray(p.value) ? p.value[0] : -1;
      const i = idx > 0 ? idx - 1 : A2.order.findIndex(o => o.ticker === p.name);
      if(i >= 0 && i < A2.order.length){ buildCascade(i, true); selectCard(i, true); }
    });
  }
  const cats = ['START'].concat(order.map(p => p.ticker)).concat(['Σ BOOK']);
  const cb = order.map(p => {
    const b = band(p, A2.hz), w = num(p.weight_pct, 0) / 100;
    return { low:w*Math.min(b.low,b.high), base:w*b.base, high:w*Math.max(b.low,b.high) };
  });
  const tot = cb.reduce((a,x) => ({low:a.low+x.low, base:a.base+x.base, high:a.high+x.high}), {low:0,base:0,high:0});

  /* Bars are drawn with a custom renderItem, NOT two stacked bar series:
     ECharts stacks positive and negative values on separate stacks, which
     silently flips any bar whose running total crosses zero. */
  const bars = [], whisk = [];
  let run = 0;
  cb.forEach((c, i) => {
    const from = run, to = run + c.base;
    bars.push({ value:[i + 1, from, to],
      itemStyle:{ color: Math.abs(c.base) < 1e-9 ? '#45475a' : impactColor(c.base) } });
    whisk.push([i + 1, from + c.low, from + c.high]);
    run = to;
  });
  bars.push({ value:[cats.length - 1, 0, tot.base], itemStyle:{ color:'#cba6f7' } });
  whisk.push([cats.length - 1, Math.min(tot.low, tot.high), Math.max(tot.low, tot.high)]);

  const mono = 'JetBrains Mono,monospace';
  const barRI = (pm, api) => {
    const x  = api.coord([api.value(0), 0])[0];
    const y0 = api.coord([0, api.value(1)])[1];
    const y1 = api.coord([0, api.value(2)])[1];
    const w  = Math.max(6, api.size([1, 0])[0] * 0.58);
    return { type:'rect',
      shape:{ x:x - w/2, y:Math.min(y0, y1), width:w, height:Math.max(2, Math.abs(y1 - y0)) },
      style: api.style() };
  };
  const bandRI = (pm, api) => {
    const x  = api.coord([api.value(0), 0])[0];
    const y1 = api.coord([0, api.value(1)])[1];
    const y2 = api.coord([0, api.value(2)])[1];
    if(Math.abs(y2 - y1) < 1.5) return { type:'group', children:[] };
    const st = { stroke:'rgba(205,214,244,.9)', lineWidth:2 };
    return { type:'group', children:[
      {type:'line', shape:{x1:x, y1:y1, x2:x, y2:y2}, style:st},
      {type:'line', shape:{x1:x-7, y1:y1, x2:x+7, y2:y1}, style:st},
      {type:'line', shape:{x1:x-7, y1:y2, x2:x+7, y2:y2}, style:st}
    ]};
  };
  A2.fall.setOption({
    animationDuration: 380, animationEasing:'cubicOut',
    grid:{left:62, right:14, top:20, bottom:56},
    xAxis:{ type:'category', data:cats,
      axisLabel:{color:'#a6adc8', fontSize:14, fontFamily:mono, interval:0, rotate:38},
      axisLine:{lineStyle:{color:'rgba(205,214,244,.18)'}}, axisTick:{show:false} },
    yAxis:{ type:'value', axisLabel:{color:'#6c7086', fontSize:13.5, fontFamily:mono,
        formatter: v => v.toFixed(1) + '%' },
      splitLine:{lineStyle:{color:'rgba(205,214,244,.07)'}} },
    series:[
      {name:'bar',  type:'custom', renderItem:barRI,  data:[], encode:{x:0, y:[1,2]}},
      {name:'band', type:'custom', renderItem:bandRI, data:[], z:9, silent:true, encode:{x:0, y:[1,2]}}
    ]
  }, {replaceMerge:['series']});

  const paintTo = k => A2.fall.setOption({
    series:[{ data: bars.slice(0, k) }, { data: whisk.slice(0, k) }] });
  const setRun = v => {
    const r = $('#a2running');
    r.textContent = (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    r.style.color = v < 0 ? 'var(--red)' : 'var(--green)';
  };

  if(instant){ paintTo(bars.length); setRun(tot.base); return; }
  let k = 0, shown = 0;
  const tick = () => {
    k++; paintTo(k);
    if(k <= cb.length) shown += cb[k-1].base;
    if(k === bars.length) shown = tot.base;
    setRun(shown);
    if(k < bars.length) after(200, tick);
  };
  after(120, tick);
}

/* ══ BEAT interactive ═══════════════════════════════════════════ */
function selectCard(i, raiseOnly){
  A2.sel = i;
  A2.cards.forEach((c, j) => c.classList.toggle('raised', j === i));
  if(!raiseOnly) openDetail(i);
}
function stepCard(dir){
  if(!A2.order.length) return;
  const n = A2.order.length;
  A2.sel = ((A2.sel < 0 ? (dir > 0 ? -1 : 0) : A2.sel) + dir + n) % n;
  buildCascade(A2.sel, true);
  selectCard(A2.sel);
}
function closeDetail(){ $('#a2detail').hidden = true; $('#a2evpanel').hidden = true; }

function openDetail(i){
  const p = A2.order[i]; if(!p) return;
  A2.sel = i;
  A2.cards.forEach((c, j) => c.classList.toggle('raised', j === i));
  const b = band(p, A2.hz), u = bandUsd(p, A2.hz);
  const dv = divergence(p);
  const cite = A2.byTicker[p.ticker];
  const o = hzOf(p, A2.hz);
  const col = Math.abs(b.base) < 1e-9 ? 'var(--overlay)' : impactColor(b.base);
  $('#a2evpanel').hidden = true;
  const bx = $('#a2detail');
  bx.innerHTML =
    `<div class="dTop">
       <span class="dTk">${esc(p.ticker)}</span>
       <span class="dSec">${esc(p.sector || '')} · ${HZLAB[A2.hz]} HORIZON</span>
       <span class="dImp" style="color:${col}">${fmtPct(b.base)}</span>
     </div>
     <div class="a2conf" style="max-width:520px">
       <span class="a2clab">CONFIDENCE</span>
       <span class="a2meter"><b style="transform:scaleX(${Math.max(0,Math.min(1,num(p.confidence,0)))})"></b></span>
       <span class="a2cnum">${num(p.confidence,0).toFixed(2)}</span>
     </div>
     ${dv ? `<div class="dCite" style="border-left-color:var(--${dv.cls==='over'?'mauve':'amber'});background:rgba(203,166,247,.10)">
        <div class="cl"><b>${dv.txt}</b> — ${esc(dv.why)}</div></div>` : ''}
     <div class="dRat">${esc(p.rationale || 'no rationale supplied')}</div>
     <div class="dMath"><em>range</em> ${fmtPct(b.low)} … ${fmtPct(b.high)}
       <em>&nbsp;·&nbsp;base</em> ${fmtPct(b.base)}
       <em>&nbsp;·&nbsp;</em> ${fmtUSD(u.base)}
       <em>&nbsp;·&nbsp;w</em> ${num(p.weight_pct,0).toFixed(2)}%
       <em>=</em> ${((num(p.weight_pct,0)/100)*b.base).toFixed(3)}pp</div>
     ${o && o.method ? `<div class="dNav" style="margin-top:12px">METHOD · ${esc(o.method)}${o.note ? ' — ' + esc(o.note) : ''}</div>` : ''}
     ${cite ? `<div class="dCite"><div class="cl">&#128279; ${esc(cite.claim || '')}</div>
        <div class="cu">${esc(cite.source ? cite.source + ' · ' : '')}${esc(cite.url || '')}</div></div>` : ''}
     <div class="dNav">← → step companies · 1/2/3 horizon · ESC close · ${i+1} of ${A2.order.length}</div>`;
  bx.hidden = false;
  bx.onclick = closeDetail;
}

function openEvidence(d){
  $('#a2detail').hidden = true;
  const b = $('#a2evpanel');
  const cs = d.citations || [];
  b.innerHTML = `<div class="evTitle">EVIDENCE · ${cs.length} CITATION${cs.length===1?'':'S'}</div>` +
    (cs.map(c => `<div class="evRow"><div class="cl">${esc(c.claim || '')}</div>
      <div class="cu">${esc(c.source ? c.source + ' · ' : '')}${esc(c.url || '')}${c.published_at ? ' · ' + esc(c.published_at) : ''}</div></div>`).join('') ||
    '<div class="evRow"><div class="cl">no citations supplied</div></div>');
  b.hidden = false;
  b.onclick = closeDetail;
}

/* charts inside Act II must resize with the stage too */
addEventListener('resize', () => { if(A2.fall) A2.fall.resize(); });

})();
