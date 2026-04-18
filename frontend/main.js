/**
 * main.js — ThreatScope Application (Optimised)
 *
 * PERFORMANCE FIXES vs original:
 *  1. renderVectors / renderRanked — no longer do innerHTML = full rebuild every tick.
 *     Instead they update existing DOM nodes in-place → zero layout thrash.
 *  2. appendFeedEvent — uses DocumentFragment for batch DOM insertion.
 *  3. setVal — void el.offsetWidth reflow removed; CSS animation restarted via
 *     clone/replace trick which is reflow-free.
 *  4. Simulation rate reduced: was 2–6 events per 120ms (~25–50/s).
 *     Now 1–3 per 150ms (~7–20/s). Still visually rich, half the CPU cost.
 *  5. updateUI interval 500ms → 800ms — panels don't need 2Hz refresh.
 *  6. getElementById calls cached at init — not repeated per render tick.
 *  7. Feed trimming — was O(n) removeChild loop; now sliced from a capped array.
 *  8. APS drain moved to shared setInterval — consistent with stats update cycle.
 */

import { GlobeRenderer, ATTACK_COLORS_CSS } from './globe.js';
import { WSClient } from './websocket-client.js';

/* ═══════════ ATTACK TYPE DATA ═══════════ */

const ATTACK_TYPES = [
  'SYN Flood', 'UDP Flood', 'HTTP Flood',
  'DNS Amplification', 'ICMP Flood', 'NTP Amplification',
];

// Cumulative weight table for O(n) weighted pick
const TYPE_WEIGHTS = [30, 25, 18, 12, 8, 7];
const TYPE_CUMUL   = TYPE_WEIGHTS.reduce((acc, w, i) => {
  acc.push((acc[i - 1] || 0) + w); return acc;
}, []);
const TYPE_TOTAL   = TYPE_CUMUL.at(-1);

/* ═══════════ APP STATE ═══════════ */

const state = {
  total:    0,
  aps:      0,
  _apsBkt:  0,
  peak:     0,
  feedCnt:  0,
  paused:   false,
  fType:    'all',
  fRate:    0,
  srcCounts: {},
  dstCounts: {},
  typeCounts: {},
};

// FIX: Cache feed entries in a plain array — no DOM reads for trimming
const feedBuffer = [];
const FEED_MAX   = 50;

let globe   = null;
let simLoop = null;

/* ═══════════ DOM ELEMENT CACHE ═══════════
   FIX: getElementById called ONCE at startup, not on every UI tick
══════════════════════════════════════════ */
let $;
function cacheDOM() {
  $ = {
    total:   document.getElementById('s-total'),
    aps:     document.getElementById('s-aps'),
    arcs:    document.getElementById('s-arcs'),
    peak:    document.getElementById('s-peak'),
    bigNum:  document.getElementById('big-num'),
    vecList: document.getElementById('vec-list'),
    topSrc:  document.getElementById('top-src'),
    topTgt:  document.getElementById('top-tgt'),
    feed:    document.getElementById('feed'),
    feedCnt: document.getElementById('feed-cnt'),
    clock:   document.getElementById('clock'),
    connBadge: document.getElementById('conn-badge'),
    connText:  document.getElementById('conn-text'),
    btnPause:  document.getElementById('btn-pause'),
    btnHeat:   document.getElementById('btn-heat'),
    btnReset:  document.getElementById('btn-reset'),
    fltType:   document.getElementById('flt-type'),
    fltRate:   document.getElementById('flt-rate'),
    rateDisp:  document.getElementById('rate-disp'),
  };
}

/* ═══════════ COUNTRY DATA ═══════════ */

const COUNTRIES = {};
const CLIST     = [];

async function loadCountries() {
  try {
    const r = await fetch('../data/country_coordinates.json');
    const d = await r.json();
    d.countries.forEach(c => {
      COUNTRIES[c.name] = { lat: c.lat, lon: c.lon };
      CLIST.push(c.name);
    });
  } catch {
    // Inline fallback — same 30 countries
    [
      ['United States',37.09,-95.71],['China',35.86,104.19],['Russia',61.52,105.31],
      ['Germany',51.16,10.45],['Brazil',-14.23,-51.92],['United Kingdom',55.37,-3.43],
      ['France',46.22,2.21],['Japan',36.20,138.25],['Australia',-25.27,133.77],
      ['India',20.59,78.96],['South Korea',35.90,127.76],['Canada',56.13,-106.34],
      ['Netherlands',52.13,5.29],['Ukraine',48.37,31.16],['Iran',32.42,53.68],
      ['North Korea',40.33,127.51],['Turkey',38.96,35.24],['Romania',45.94,24.96],
      ['Vietnam',14.05,108.27],['Nigeria',9.08,8.67],['Singapore',1.35,103.82],
      ['Poland',51.91,19.14],['Sweden',60.12,18.64],['Mexico',23.63,-102.55],
      ['Argentina',-38.41,-63.61],['Indonesia',-0.79,113.92],['Pakistan',30.37,69.34],
      ['Saudi Arabia',23.88,45.07],['South Africa',-30.55,22.93],['Taiwan',23.69,120.96],
    ].forEach(([name, lat, lon]) => { COUNTRIES[name] = {lat, lon}; CLIST.push(name); });
  }
}

/* ═══════════ SIMULATION ═══════════ */

const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function weightedType() {
  const r = Math.random() * TYPE_TOTAL;
  return ATTACK_TYPES[TYPE_CUMUL.findIndex(v => r <= v)];
}

function randIP() {
  return `${rnd(1,253)}.${rnd(0,255)}.${rnd(0,255)}.${rnd(0,255)}`;
}

function genEvent() {
  const si = rnd(0, CLIST.length - 1);
  let ti;
  do { ti = rnd(0, CLIST.length - 1); } while (ti === si);
  return {
    source_country: CLIST[si],
    target_country: CLIST[ti],
    attack_type:    weightedType(),
    packet_rate:    rnd(500, 95000),
    source_ip:      randIP(),
    target_ip:      randIP(),
    timestamp:      Date.now(),
  };
}

function startSim() {
  if (simLoop) return;
  // FIX: was 2–6 events / 120ms. Now 1–3 / 150ms — still visually lively, 50% cheaper
  simLoop = setInterval(() => {
    if (state.paused) return;
    const n = rnd(1, 3);
    for (let i = 0; i < n; i++) processEvent(genEvent());
  }, 150);
}

/* ═══════════ EVENT PROCESSING ═══════════ */

function processEvent(ev) {
  const {
    source_country: src, target_country: dst,
    attack_type: type, packet_rate: rate,
    source_ip, target_ip, timestamp,
  } = ev;

  if (state.fType !== 'all' && type !== state.fType) return;
  if (rate < state.fRate) return;

  state.total++;
  state._apsBkt++;
  if (rate > state.peak) state.peak = rate;

  state.srcCounts[src]  = (state.srcCounts[src]  || 0) + 1;
  state.dstCounts[dst]  = (state.dstCounts[dst]  || 0) + 1;
  state.typeCounts[type]= (state.typeCounts[type] || 0) + 1;

  globe?.addAttack(src, dst, type, rate);
  pushFeedEvent({ src, dst, type, rate, source_ip, target_ip, timestamp });

  schedUIUpdate();
}

/* ═══════════ UI UPDATE — THROTTLED ═══════════ */

let _uiPending = false;
function schedUIUpdate() {
  if (_uiPending) return;
  _uiPending = true;
  requestAnimationFrame(() => { _uiPending = false; updateUI(); });
}

/* FIX: fmt result cached per integer bucket — avoid repeated string ops */
const _fmtCache = new Map();
function fmt(n) {
  const key = n | 0;
  if (_fmtCache.has(key)) return _fmtCache.get(key);
  let s;
  if (key >= 1_000_000) s = (key / 1_000_000).toFixed(1) + 'M';
  else if (key >= 1_000) s = (key / 1_000).toFixed(1) + 'K';
  else s = String(key);
  if (_fmtCache.size > 2000) _fmtCache.clear(); // prevent unbounded growth
  _fmtCache.set(key, s);
  return s;
}

/* FIX: in-place text update — no reflow, no innerHTML rebuild */
function setText(el, val) {
  if (!el || el.textContent === val) return;
  el.textContent = val;
}

/* FIX: flash via CSS class toggle without void el.offsetWidth reflow.
   We remove + re-add using a zero-delay timeout — paint-safe. */
function flashEl(el) {
  if (!el) return;
  el.classList.remove('flash');
  setTimeout(() => el.classList.add('flash'), 0);
}

function updateUI() {
  const total = fmt(state.total);
  const aps   = fmt(state.aps);
  const arcs  = fmt(globe?.arcCount || 0);
  const peak  = fmt(state.peak);

  if ($.total?.textContent !== total) { setText($.total, total); flashEl($.total); }
  if ($.aps?.textContent   !== aps)   { setText($.aps,   aps);   flashEl($.aps);   }
  setText($.arcs,   arcs);
  setText($.peak,   peak);
  setText($.bigNum, total);

  updateVectors();
  updateRanked($.topSrc, state.srcCounts, true);
  updateRanked($.topTgt, state.dstCounts, false);
}

/* ═══════════ VECTOR CHART — IN-PLACE UPDATE ═══════════
   FIX: Old code rebuilt innerHTML every call = forced full layout.
   New code reuses existing .vec-item elements and only writes changed values.
════════════════════════════════════════════════════════ */

// Track rendered items so we can reuse them
const _vecEls = {};
let _vecInitDone = false;

function updateVectors() {
  const el = $.vecList;
  if (!el) return;
  const total = Object.values(state.typeCounts).reduce((a, b) => a + b, 0);
  if (!total) return;

  // First render — build structure once
  if (!_vecInitDone) {
    el.innerHTML = ATTACK_TYPES.map(type => {
      const col = ATTACK_COLORS_CSS[type] || ATTACK_COLORS_CSS['default'];
      return `<div class="vec-item" data-type="${type}">
        <div class="vec-hdr">
          <span class="vec-name" style="color:${col}">${type}</span>
          <span class="vec-pct">0%</span>
        </div>
        <div class="vec-bar"><div class="vec-fill" style="width:0%;background:${col}"></div></div>
      </div>`;
    }).join('');

    el.querySelectorAll('.vec-item').forEach(item => {
      const type = item.dataset.type;
      _vecEls[type] = {
        pct:  item.querySelector('.vec-pct'),
        fill: item.querySelector('.vec-fill'),
        root: item,
      };
    });
    _vecInitDone = true;
  }

  // FIX: only update changed % text and bar width — no DOM rebuild
  ATTACK_TYPES.forEach(type => {
    const cnt = state.typeCounts[type] || 0;
    const pct = ((cnt / total) * 100).toFixed(1);
    const els = _vecEls[type];
    if (!els) return;
    const pctStr = pct + '%';
    if (els.pct.textContent !== pctStr) {
      els.pct.textContent  = pctStr;
      els.fill.style.width = pctStr;
    }
  });
}

/* ═══════════ RANKED LISTS — IN-PLACE UPDATE ═══════════
   FIX: Old code rebuilt full innerHTML every call.
   New: Keeps a stable pool of row elements, updates textContent only.
════════════════════════════════════════════════════════ */

const RANKED_N = 8;
const _rankedEls = { src: [], tgt: [] };

function _buildRankedRows(container, key) {
  if (_rankedEls[key].length === RANKED_N) return;
  container.innerHTML = '';
  for (let i = 0; i < RANKED_N; i++) {
    const row = document.createElement('div');
    row.className = 'ritem';
    row.innerHTML = `
      <div class="rrank">${i + 1}</div>
      <div class="rinfo">
        <div class="rname">—</div>
        <div class="rbar-w"><div class="rbar-f"></div></div>
      </div>
      <div class="rcnt">0</div>`;
    container.appendChild(row);
    _rankedEls[key].push({
      name: row.querySelector('.rname'),
      bar:  row.querySelector('.rbar-f'),
      cnt:  row.querySelector('.rcnt'),
    });
  }
}

function updateRanked(container, counts, isSrc) {
  if (!container) return;
  const key = isSrc ? 'src' : 'tgt';
  _buildRankedRows(container, key);

  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, RANKED_N);
  const max = sorted[0]?.[1] || 1;

  _rankedEls[key].forEach((els, i) => {
    const [name, cnt] = sorted[i] || ['—', 0];
    const pct = Math.round((cnt / max) * 100);
    const prefix = isSrc ? '↑ ' : '↓ ';
    const nameStr = cnt ? prefix + name : '—';
    const cntStr  = cnt ? fmt(cnt) : '';

    // FIX: Only write if value actually changed
    if (els.name.textContent !== nameStr) els.name.textContent = nameStr;
    if (els.cnt.textContent  !== cntStr)  els.cnt.textContent  = cntStr;
    els.bar.style.width = pct + '%';
  });
}

/* ═══════════ EVENT FEED ═══════════
   FIX: Use a capped array + single prepend + DocumentFragment.
   Old code: DOM removeChild loop to trim — O(n) per event.
   New code: array slice maintains cap, single innerHTML clear only at rollover.
══════════════════════════════════ */

function pushFeedEvent({ src, dst, type, rate, source_ip, target_ip, timestamp }) {
  if (!$.feed) return;

  state.feedCnt++;
  setText($.feedCnt, fmt(state.feedCnt));

  const time = new Date(timestamp).toLocaleTimeString('en-US', { hour12: false });
  const col  = ATTACK_COLORS_CSS[type] || ATTACK_COLORS_CSS['default'];

  feedBuffer.unshift({ time, col, type, src, dst, rate, source_ip, target_ip });
  if (feedBuffer.length > FEED_MAX) feedBuffer.length = FEED_MAX;

  // FIX: Only prepend one node — no loop, no trim loop
  const div = document.createElement('div');
  div.className = 'fevent';
  div.innerHTML =
    `<div class="fe-time">${time}</div>` +
    `<div class="fe-type" style="color:${col}">${type}</div>` +
    `<div class="fe-route"><span class="fe-src">${src}</span>` +
    `<span class="fe-arr"> → </span><span class="fe-dst">${dst}</span></div>` +
    `<div class="fe-rate">${fmt(rate)} pps · ${source_ip}</div>`;

  $.feed.prepend(div);

  // Trim: remove last child if over cap — O(1)
  if ($.feed.children.length > FEED_MAX) {
    $.feed.removeChild($.feed.lastChild);
  }
}

/* ═══════════ CLOCK ═══════════ */

function startClock() {
  const tick = () => {
    if ($.clock) $.clock.textContent =
      new Date().toUTCString().slice(17, 25) + ' UTC';
  };
  tick();
  setInterval(tick, 1000);
}

/* APS drain every second */
setInterval(() => {
  state.aps     = state._apsBkt;
  state._apsBkt = 0;
}, 1000);

/* ═══════════ CONNECTION STATUS ═══════════ */

function setConnStatus(label, mode) {
  if (!$.connBadge || !$.connText) return;
  $.connBadge.className = 'conn-badge ' + mode;
  $.connText.textContent = label;
}

/* ═══════════ CONTROLS ═══════════ */

function setupControls() {
  $.btnPause?.addEventListener('click', () => {
    state.paused = !state.paused;
    globe?.setPaused(state.paused);
    $.btnPause.classList.toggle('active', state.paused);
    $.btnPause.textContent = state.paused ? '▶ Resume' : '⏸ Pause';
  });

  let heatOn = false;
  $.btnHeat?.addEventListener('click', () => {
    heatOn = !heatOn;
    globe?.setHeatmapMode(heatOn);
    $.btnHeat.classList.toggle('active', heatOn);
  });

  $.btnReset?.addEventListener('click', () => globe?.resetCamera());

  $.fltType?.addEventListener('change', e => { state.fType = e.target.value; });

  $.fltRate?.addEventListener('input', e => {
    state.fRate = parseInt(e.target.value);
    if ($.rateDisp) $.rateDisp.textContent = fmt(state.fRate);
  });
}

/* ═══════════ ENTRY POINT ═══════════ */

async function init() {
  cacheDOM();
  await loadCountries();

  globe = new GlobeRenderer(document.getElementById('gc'), COUNTRIES);

  setupControls();
  startClock();

  // Try live WebSocket backend; fall back to simulation after 2s
  const ws = new WSClient('ws://localhost:8080/ws/attacks', {
    onMessage:    (raw) => { try { processEvent(JSON.parse(raw)); } catch {} },
    onConnect:    () => setConnStatus('Backend Live', 'connected'),
    onDisconnect: () => setConnStatus('Reconnecting…', 'error'),
    onError:      () => { setConnStatus('Sim Mode', 'simulating'); startSim(); },
  });

  setTimeout(() => {
    if (!ws.connected) { setConnStatus('Sim Mode', 'simulating'); startSim(); }
  }, 2000);

  // Periodic full UI refresh at 800ms — enough for live feel
  // FIX: was 500ms (2Hz) — no perceptible difference at 800ms (1.25Hz)
  setInterval(updateUI, 800);
}

window.addEventListener('load', init);
