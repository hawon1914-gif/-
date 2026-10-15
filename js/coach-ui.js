// 코칭 탭: 실시간 연결(브리지)·기록 파일·데모 세션 → 랩 분석, 지도 고스트, 코너별 비교, 코칭, 음성 안내
import { analyzeSession, coachLap, sessionSummary, cornerMetrics, cornerReasons } from './coach.js';
import { LineChart } from './chart.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
const fmt = (t) => {
  if (!Number.isFinite(t)) return '–';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
};
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const sign = (x, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;

export function createCoach({ root, getCar, getCarId, getEnv }) {
  const $ = (s) => root.querySelector(s);
  const map = $('#co-map');
  const charts = {
    speed: new LineChart($('#co-c-speed'), { xLabel: 'm', yLabel: 'km/h', height: 200 }),
    pedal: new LineChart($('#co-c-pedal'), { xLabel: 'm', yLabel: '%', height: 170 }),
    delta: new LineChart($('#co-c-delta'), { xLabel: 'm', yLabel: '초', height: 150 }),
    line: new LineChart($('#co-c-line'), { xLabel: 'm', yLabel: 'm', height: 150 }),
  };
  const zoom = $('#co-zoom');
  let target = ''; // '' = 코너별 내 최고, 'o:<id>' = 상대 차 베스트 랩
  let zoomCorner = 0;
  let showAllInc = false;
  let focusIdx = -1; // 사고 지점 (차트 표시)
  const incHtml = (e, withLap) => `<div class="tip-head"><b>${withLap ? `랩 ${e.lap} · ` : ''}${e.corner}번 코너 ${esc(e.name)}</b>
    <span class="loss">${e.loss > 0.05 ? `−${e.loss.toFixed(2)}초` : '시간 손해 없음'}</span>
    <span class="meta">${e.phase} · ${e.speed.toFixed(0)} km/h${e.peakSlip > 5 ? ` · 최대 미끄러짐 ${e.peakSlip.toFixed(0)}°` : ''}</span></div>
    ${e.kind === 'off' && e.loss <= 0.05 ? '<p>시간은 잃지 않았지만 트랙 밖으로 나갔습니다. 대회라면 트랙 리밋 경고·무효 랩 대상입니다.</p>' : ''}
    ${e.causes.map((c) => `<p>${esc(c)}</p>`).join('')}${e.evidence ? `<p class="meta">${esc(e.evidence)}</p>` : ''}`;
  let samples = [];
  let A = null; // 분석 결과
  let lapIdx = -1; // 비교 랩
  let sessionName = '';
  let visible = false;

  const status = (t) => { $('#co-status').textContent = t; };

  // ---------- 데이터 소스 ----------
  let es = null;
  let live = null; // 실시간 상태
  function connect() {
    if (es) { es.close(); es = null; $('#co-live-btn').textContent = '실시간 연결'; status('연결을 끊었습니다.'); $('#co-live').hidden = true; return; }
    const port = +$('#co-port').value || 8770;
    samples = [];
    A = null;
    live = { lapStartT: null, lap: null, dist: 0, last: null, cornerSpoken: new Set(), cars: null, carsT: 0, trafficIdx: -1 };
    es = new EventSource(`http://127.0.0.1:${port}/stream`);
    $('#co-live-btn').textContent = '연결 끊기';
    status(`127.0.0.1:${port}에 연결 중… 브리지(lmu_bridge.py)가 켜져 있어야 합니다.`);
    let first = true;
    es.onmessage = (e) => {
      const s = JSON.parse(e.data);
      if (first) { first = false; sessionName = `${s.track || '트랙'} · ${s.car || ''}`; status(`연결됨: ${sessionName}`); $('#co-live').hidden = false; }
      onLiveSample(s);
    };
    es.onerror = () => status(first
      ? `브리지에 연결할 수 없습니다 (127.0.0.1:${port}). 브리지를 켜고 다시 누르세요.`
      : `브리지와 연결이 끊겼습니다. 다시 켜지면 자동으로 이어집니다. 지금까지 받은 ${samples.length.toLocaleString()}개 샘플은 그대로 분석되어 있습니다.`);
  }

  function loadFile(file) {
    file.text().then((txt) => {
      samples = txt.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      sessionName = `${samples[0]?.track || file.name} · ${samples[0]?.car || ''}`;
      analyze();
    }).catch((err) => status(`파일을 읽지 못했습니다: ${err.message}`));
  }

  // ---------- 분석 ----------
  function analyze(keepLap = false) {
    const res = analyzeSession(samples);
    if (res.error) { status(res.error); A = null; render(); return; }
    A = res;
    if (!keepLap || lapIdx < 0 || lapIdx >= A.laps.length) {
      // 기본 비교 랩: 베스트가 아닌 유효 랩 중 가장 최근
      const others = A.laps.map((l, i) => i).filter((i) => A.laps[i] !== A.best);
      lapIdx = others.length ? others[others.length - 1] : 0;
    }
    const bad = A.laps.filter((l) => !l.valid).length;
    status(`${sessionName} · 완주 랩 ${A.laps.length}개 ${bad ? `(피트·랩 거리 이상 등으로 기준 계산에서 뺀 랩 ${bad}개)` : ''} · 사고·실수 ${A.incidents.length}건 · 코너 ${A.corners.length}개 검출${A.mixed ? ` · 파일에 트랙·차 조합이 ${A.mixed}개 섞여 있어 가장 긴 세션만 분석` : ''}`);
    render();
  }

  // ---------- 실시간 ----------
  function onLiveSample(s) {
    samples.push(s);
    const L = live;
    if (L.lap !== s.lap) {
      const finished = L.lap !== null;
      L.lap = s.lap; L.lapStartT = s.t; L.dist = 0; L.cornerSpoken = new Set(); L.trafficIdx = -1;
      // 랩이 끝날 때마다 세션을 다시 분석
      if (finished) analyze(true);
    }
    if (L.last) L.dist += Math.hypot(s.x - L.last.x, s.z - L.last.z);
    L.last = s;
    const t = s.t - L.lapStartT;
    $('#co-live-speed').textContent = (s.v * 3.6).toFixed(0);
    $('#co-live-gear').textContent = s.gear <= 0 ? (s.gear < 0 ? 'R' : 'N') : s.gear;
    $('#co-live-lap').textContent = fmt(t);
    $('#co-live-thr').style.width = `${(s.thr * 100).toFixed(0)}%`;
    $('#co-live-brk').style.width = `${(s.brk * 100).toFixed(0)}%`;
    if (s.cars) { L.cars = s.cars; L.carsT = s.t; }
    const traffic = liveTraffic(s, L);
    if (s.off) $('#co-live-flag').textContent = '트랙 이탈 · 이번 랩 무효';
    else $('#co-live-flag').textContent = traffic ? '앞차와 가까움 · 이 구간은 코칭에서 뺍니다' : '';
    if (!A) { drawMap({ live: { x: s.x, z: s.z }, cars: L.cars }); return; }
    // 베스트 랩의 같은 거리 지점과 시간 비교 (주행 거리는 위치 변화로 누적)
    const R = A.ref;
    const idx = Math.min(R.n - 1, Math.floor((L.dist / R.length) * R.n));
    if (traffic) L.trafficIdx = idx;
    const d = t - R.t[idx];
    const dEl = $('#co-live-delta');
    dEl.textContent = sign(d);
    dEl.className = d > 0 ? 'slow' : 'fast';
    // 막대: 가운데에서 느리면 오른쪽(빨강), 빠르면 왼쪽(초록)으로 1초까지
    const k = Math.max(-1, Math.min(1, d));
    const bar = $('#co-live-bar').firstElementChild;
    bar.style.left = `${k >= 0 ? 50 : 50 + k * 50}%`;
    bar.style.width = `${Math.abs(k) * 50}%`;
    bar.style.background = k >= 0 ? css('--drag') : css('--ok');
    drawMap({ live: { x: s.x, z: s.z }, ghost: ghostAt(t), cars: L.cars });
    // 코너를 빠져나가면 그 코너만 바로 평가해서 음성으로 알려준다
    if ($('#co-voice').checked) {
      for (const c of A.corners) {
        if (idx > c.to && idx < c.to + 40 && !L.cornerSpoken.has(c.id)) {
          L.cornerSpoken.add(c.id);
          // 이 코너에서 다른 차에 막혔으면 말하지 않는다
          if (L.trafficIdx < c.from) speakCorner(c, L);
        }
      }
    }
  }

  // 앞차·뒤차 간격. 브리지가 주는 랩 거리(lapDist, ld)로 트랙을 따라 잰다. 없으면 직선 거리.
  function liveTraffic(s, L) {
    const cars = L.cars && s.t - L.carsT < 1 ? L.cars.filter((o) => !o.pit) : [];
    const len = s.trackLen || A?.ref.length || 0;
    let ahead = null, behind = null;
    for (const o of cars) {
      let d;
      if (Number.isFinite(o.ld) && Number.isFinite(s.lapDist) && len) {
        d = (((o.ld - s.lapDist) % len) + len) % len;
        if (d > len / 2) d -= len;
      } else {
        const p = L.last && L.prev ? L.prev : null;
        const dist = Math.hypot(o.x - s.x, o.z - s.z);
        const hx = p ? s.x - p.x : 0, hz = p ? s.z - p.z : 0;
        d = (o.x - s.x) * hx + (o.z - s.z) * hz >= 0 ? dist : -dist;
      }
      if (d >= 0 && (!ahead || d < ahead.d)) ahead = { d, o };
      if (d < 0 && (!behind || -d < behind.d)) behind = { d: -d, o };
    }
    L.prev = s;
    const show = (el, nm, g) => {
      $(el).textContent = g ? `${g.d.toFixed(0)} m` : '–';
      $(nm).textContent = g ? ` ${(g.d / Math.max(5, s.v)).toFixed(1)}초 · ${g.o.n || ''}${g.o.c ? ' (' + g.o.c + ')' : ''}` : '';
    };
    show('#co-live-ahead', '#co-live-ahead-n', ahead);
    show('#co-live-behind', '#co-live-behind-n', behind);
    return (ahead && ahead.d < 30) || (behind && behind.d < 12);
  }

  // 베스트 랩에서 같은 경과 시간에 있던 위치 = 고스트
  function ghostAt(t) {
    const R = A.ref;
    let lo = 0, hi = R.n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (R.t[mid] < t) lo = mid + 1; else hi = mid; }
    return { x: R.x[lo], z: R.z[lo] };
  }

  function speakCorner(c, L) {
    // 이번 랩의 이 코너 구간만 재샘플해 기준 랩과 비교
    const lapSamples = samples.filter((s) => s.lap === L.lap);
    if (lapSamples.length < 20) return;
    const R = A.ref;
    const d = new Float64Array(lapSamples.length);
    for (let i = 1; i < lapSamples.length; i++) d[i] = d[i - 1] + Math.hypot(lapSamples[i].x - lapSamples[i - 1].x, lapSamples[i].z - lapSamples[i - 1].z);
    const cur = { n: R.n, t: new Float32Array(R.n), v: new Float32Array(R.n), thr: new Float32Array(R.n), brk: new Float32Array(R.n), steer: new Float32Array(R.n) };
    let j = 0;
    for (let k = 0; k <= Math.min(R.n - 1, c.to + 1); k++) {
      const target = (k / R.n) * R.length;
      while (j < lapSamples.length - 2 && d[j + 1] < target) j++;
      const s = lapSamples[j];
      cur.t[k] = s.t - lapSamples[0].t; cur.v[k] = s.v; cur.thr[k] = s.thr; cur.brk[k] = s.brk; cur.steer[k] = s.steer;
    }
    const m = cornerMetrics(cur, c);
    const r = A.best.corners[c.id - 1];
    const loss = m.time - r.time;
    if (loss < 0.15) return;
    const why = cornerReasons(m, r)[0]?.short;
    say(`${c.id}번, ${loss.toFixed(1)}초${why ? ', ' + why : ''}`);
  }

  function say(text) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = 1.15;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  // ---------- 지도 ----------
  let mapXf = null;
  function setupMap() {
    const w = map.clientWidth || 600;
    const h = Math.round(Math.min(420, Math.max(260, w * 0.62)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    map.width = w * dpr; map.height = h * dpr; map.style.height = h + 'px';
    if (!A) { mapXf = null; return; }
    const R = A.ref;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < R.n; i++) { minX = Math.min(minX, R.x[i]); maxX = Math.max(maxX, R.x[i]); minZ = Math.min(minZ, R.z[i]); maxZ = Math.max(maxZ, R.z[i]); }
    const pad = 26;
    const sc = Math.min((w - 2 * pad) / (maxX - minX || 1), (h - 2 * pad) / (maxZ - minZ || 1));
    const ox = (w - (maxX - minX) * sc) / 2;
    const oy = (h - (maxZ - minZ) * sc) / 2;
    // 게임 좌표 z를 화면 세로로 (위에서 내려다본 모습)
    mapXf = (x, z) => [ox + (x - minX) * sc, oy + (z - minZ) * sc];
  }

  function drawMap(extra = {}) {
    const ctx = map.getContext('2d');
    const dpr = map.width / (map.clientWidth || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, map.width, map.height);
    if (!A || !mapXf) return;
    const R = A.ref;
    const lap = A.laps[lapIdx];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = css('--line');
    ctx.lineWidth = 10;
    ctx.beginPath();
    for (let i = 0; i < R.n; i += 3) { const [px, py] = mapXf(R.x[i], R.z[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.stroke();
    // 비교 랩: 구간마다 시간을 잃으면 빨강, 벌면 초록
    if (lap && lap !== A.best) {
      const step = 6;
      for (let i = step; i < R.n; i += step) {
        const g = lap.delta[i] - lap.delta[i - step];
        const col = g > 0.004 ? css('--drag') : g < -0.004 ? css('--ok') : css('--ink-2');
        ctx.strokeStyle = col;
        ctx.lineWidth = 4;
        const [ax, ay] = mapXf(lap.R.x[i - step], lap.R.z[i - step]);
        const [bx, by] = mapXf(lap.R.x[i], lap.R.z[i]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }
    }
    // 코너 번호
    ctx.font = `600 11px ${css('--font-data')}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of A.corners) {
      const [px, py] = mapXf(R.x[c.apex], R.z[c.apex]);
      ctx.fillStyle = css('--panel');
      ctx.beginPath(); ctx.arc(px, py, 10, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = css('--ink');
      ctx.fillText(String(c.id), px, py + 0.5);
    }
    const [sx, sy] = mapXf(R.x[0], R.z[0]);
    ctx.fillStyle = css('--ink');
    ctx.fillRect(sx - 2, sy - 9, 4, 18);
    const dot = (p, color, r = 7) => {
      if (!p) return;
      const [px, py] = mapXf(p.x, p.z);
      ctx.fillStyle = color; ctx.strokeStyle = css('--panel'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    };
    for (const o of extra.cars || []) if (!o.pit) dot(o, css('--ink-2'), 4);
    dot(extra.opp, css('--c2'), 6);
    dot(extra.ghost, css('--front'), 6);
    dot(extra.cur, css('--accent'));
    dot(extra.live, css('--accent'));
  }

  // 고스트 재생: 베스트(파랑)와 비교 랩(주황)을 같은 시간축으로 움직인다
  // 고스트 재생: 고른 랩(또는 세션 전체를 이어서)과 고스트 랩을 같은 시간축으로 움직인다.
  // 고스트는 랩마다 처음부터 다시 출발한다.
  let replay = null;
  function ghostLaps() {
    const out = [{ key: 'best', name: `내 베스트 (랩 ${A.best.lap})`, lap: A.best }];
    A.laps.forEach((l, i) => { if (l.valid && l !== A.best) out.push({ key: 'l' + i, name: `랩 ${l.lap} (${fmt(l.time)})`, lap: l }); });
    for (const o of A.opponents) out.push({ key: 'o' + o.id, name: `${o.name} (${o.cls}) ${fmt(o.best.time)}`, lap: o.best });
    return out;
  }
  function fillReplaySelects() {
    const lapSel = $('#co-rp-lap'), gSel = $('#co-rp-ghost');
    const keepL = lapSel.value, keepG = gSel.value;
    lapSel.innerHTML = `<option value="sel">선택한 랩</option><option value="all">세션 전체 이어서</option>`;
    gSel.innerHTML = ghostLaps().map((g) => `<option value="${g.key}">${esc(g.name)}</option>`).join('');
    if ([...lapSel.options].some((o) => o.value === keepL)) lapSel.value = keepL;
    if ([...gSel.options].some((o) => o.value === keepG)) gSel.value = keepG;
  }
  function stopReplay() { replay = null; $('#co-play').textContent = '고스트 재생'; }
  function toggleReplay() {
    if (replay) { stopReplay(); drawMap(); return; }
    if (!A) return;
    $('#co-play').textContent = '정지';
    // 이어서 재생하면 완주 랩을 순서대로 (무효 랩 포함, 끊긴 조각은 이미 빠져 있다)
    const seq = $('#co-rp-lap').value === 'all' ? A.laps.slice() : [A.laps[lapIdx]];
    const ghost = ghostLaps().find((g) => g.key === $('#co-rp-ghost').value) || ghostLaps()[0];
    const start = performance.now();
    const speedUp = +$('#co-speedup').value || 1;
    const token = {};
    replay = token;
    const at = (R, t) => {
      let lo = 0, hi = R.n - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (R.t[mid] < t) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const tick = (now) => {
      if (replay !== token) return;
      let t = ((now - start) / 1000) * speedUp;
      // 지금 몇 번째 랩을 재생 중인가
      let k = 0;
      while (k < seq.length - 1 && t > seq[k].time) { t -= seq[k].time; k++; }
      const lap = seq[k];
      if (k === seq.length - 1 && t > Math.max(lap.time, ghost.lap.time) + 1) { toggleReplay(); return; }
      const ci = at(lap.R, t);
      const G = ghost.lap.R;
      const gi = at(G, t);
      drawMap({ ghost: { x: G.x[gi], z: G.z[gi] }, cur: { x: lap.R.x[ci], z: lap.R.z[ci] } });
      const dd = lap.R.t[ci] - G.t[ci];
      $('#co-replay-info').textContent = `랩 ${lap.lap}${seq.length > 1 ? ` (${k + 1}/${seq.length})` : ''} · ${t.toFixed(1)}초 · ${ghost.name} 대비 ${sign(dd)}초${lap.valid ? '' : ' · 무효 랩'}`;
      if (lap === A.laps[lapIdx]) for (const ch of Object.values(charts)) { ch.markers = [{ x: ci, label: '', color: '--accent' }]; ch.draw(); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------- 표·차트·코칭 ----------
  function render() {
    setupMap();
    drawMap();
    const has = !!A;
    $('#co-results').hidden = !has;
    if (!has) return;
    const lap = A.laps[lapIdx];
    const opp = targetOpp();
    const incTag = (l) => l.incidents.map((e) => `${e.name.replace(' (추정)', '')} ${e.corner}번`).join(', ');
    const tag = (l) => {
      const ks = A.corners.filter((c, k) => l.traffic[k]).map((c) => c.id);
      return ks.length ? `트래픽 ${ks.join(',')}번` : '';
    };
    // 랩 목록
    $('#co-laps').innerHTML = A.laps.map((l, i) => `<tr class="${i === lapIdx ? 'sel' : ''}" data-i="${i}">
      <td>랩 ${l.lap}</td><td>${fmt(l.time)}</td><td title="${esc(l.why.join(', '))}">${l === A.best ? '베스트' : l.valid ? sign(l.time - A.best.time, 3) : '기준 제외 · ' + esc(l.why[0] || '')}</td><td class="traffic">${[incTag(l), tag(l)].filter(Boolean).join(' · ')}</td></tr>`).join('');
    // 사고·실수: 세션 전체, 손해 큰 순
    const incs = A.incidents.slice().sort((a, b) => b.loss - a.loss);
    $('#co-inc-box').hidden = !incs.length;
    // 많으면 손해 큰 6건만 펼치고 나머지는 접어 둔다
    $('#co-incidents').innerHTML = incs.map((e, n) => `<li data-n="${n}" class="${A.laps[lapIdx]?.lap === e.lap && zoomCorner === e.cornerIdx ? 'sel' : ''}" ${n >= 6 && !showAllInc ? 'hidden' : ''}>${incHtml(e, true)}</li>`).join('')
      + (incs.length > 6 ? `<button type="button" id="co-inc-more">${showAllInc ? '접기' : `${incs.length - 6}건 더 보기`}</button>` : '');
    $('#co-inc-more')?.addEventListener('click', () => { showAllInc = !showAllInc; render(); });
    $('#co-incidents').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
      const e = incs[+li.dataset.n];
      lapIdx = A.laps.findIndex((l) => l.lap === e.lap);
      zoomCorner = e.cornerIdx;
      focusIdx = e.refIdx;
      stopReplay(); render();
      $('#co-zoom').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    // 같이 달린 차
    $('#co-opp-box').hidden = !A.opponents.length;
    $('#co-opps').innerHTML = A.opponents.map((o) => `<tr class="${target === 'o:' + o.id ? 'sel' : ''}" data-id="${o.id}">
      <td>${esc(o.name)}</td><td class="co-tag">${esc(o.cls)}</td><td>${fmt(o.best.time)}</td><td>${o.best.time < A.best.time ? `나보다 ${(A.best.time - o.best.time).toFixed(3)}초 빠름` : `나보다 ${(o.best.time - A.best.time).toFixed(3)}초 느림`}</td></tr>`).join('');
    for (const tr of $('#co-opps').querySelectorAll('tr')) tr.addEventListener('click', () => { target = target === 'o:' + tr.dataset.id ? '' : 'o:' + tr.dataset.id; stopReplay(); render(); });
    $('#co-target').innerHTML = `<option value="">코너마다 내 최고 기록</option>` + A.opponents.map((o) => `<option value="o:${o.id}">${esc(o.name)} (${esc(o.cls)}) ${fmt(o.best.time)}</option>`).join('');
    $('#co-target').value = opp ? target : '';
    for (const tr of $('#co-laps').querySelectorAll('tr')) tr.addEventListener('click', () => { lapIdx = +tr.dataset.i; focusIdx = -1; stopReplay(); render(); });
    $('#co-best').textContent = fmt(A.best.time);
    $('#co-theory').textContent = fmt(A.theoretical);
    $('#co-gap').textContent = sign(A.best.time - A.theoretical, 3);
    // 세션 요약: 손해 큰 코너
    const sum = sessionSummary(A).slice(0, 4);
    $('#co-summary').innerHTML = sum.map((s) => `<li><b>${s.corner}번 코너</b> 랩마다 평균 ${s.avgLoss.toFixed(2)}초 손해${s.spread > 0.1 ? `, 랩마다 편차 ${s.spread.toFixed(2)}초 (일관성 부족)` : ''}</li>`).join('');
    // 비교 랩 코칭
    $('#co-lapname').textContent = `랩 ${lap.lap} (${fmt(lap.time)}${lap.valid ? '' : ', 기준 계산에서 제외: ' + lap.why.join(', ')})`;
    fillReplaySelects();
    const { tips, skipped } = coachLap(A, lap, opp ? { lap: opp.best, name: opp.name } : null);
    const lapInc = lap.incidents.map((e) => `<li class="co-inc-tip">${incHtml(e, false)}</li>`).join('');
    $('#co-tips').innerHTML = lapInc + (tips.length
      ? tips.slice(0, 6).map((t) => `<li><div class="tip-head"><b>${t.corner}번 코너</b><span class="loss">−${t.loss.toFixed(2)}초</span><span class="ref">기준: ${esc(t.refName)}</span></div>${t.reasons.map((r) => `<p>${r}</p>`).join('')}</li>`).join('')
      : `<li><p>${lap === A.best && !opp ? '베스트 랩입니다. 다른 랩이나 같이 달린 차를 골라 비교하세요.' : '사고 구간을 뺀 모든 코너에서 기준과 0.04초 이내입니다.'}</p></li>`);
    $('#co-skipped').hidden = !skipped.length;
    $('#co-skipped').textContent = skipped.length ? `${skipped.join(', ')}번 코너는 다른 차와 가까이 붙어 달려서 코칭에서 뺐습니다 (막혔거나 슬립스트림을 탄 구간은 실력 비교가 안 됩니다).` : '';
    // 코너 표 (비교 랩 vs 기준). 상대가 기준이면 페달 칸 대신 속도 지표만.
    const ln = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? sign(a - b, 1) : '–');
    const rows = A.corners.map((c, k) => {
      const tr = lap.traffic[k] ? ' <span class="co-tag">트래픽</span>' : '';
      const L = lap.line[k];
      if (opp) {
        const m = lap.speed[k], r = opp.best.speed[k], R2 = opp.best.line[k];
        return `<tr><td>${c.id}${tr}</td><td class="${m.time - r.time > 0.04 ? 'bad' : m.time - r.time < -0.04 ? 'good' : ''}">${sign(m.time - r.time)}</td>
          <td>${m.decelStart - r.decelStart > 0 ? '+' : ''}${m.decelStart - r.decelStart}</td><td>${sign(m.minSpeed - r.minSpeed, 0)}</td><td>${sign(m.exitSpeed - r.exitSpeed, 0)}</td>
          <td>${ln(L.turnIn, R2.turnIn)}</td><td>${ln(L.apex, R2.apex)}</td><td>${ln(L.exit, R2.exit)}</td></tr>`;
      }
      const m = lap.corners[k], r = A.best.corners[k], R2 = A.best.line[k];
      const d = (a, b) => (a === null || b === null ? '–' : `${a - b > 0 ? '+' : ''}${a - b}`);
      return `<tr><td>${c.id}${tr}</td><td class="${m.time - r.time > 0.04 ? 'bad' : m.time - r.time < -0.04 ? 'good' : ''}">${sign(m.time - r.time)}</td>
        <td>${d(m.brakePoint, r.brakePoint)}</td><td>${(m.peak * 100).toFixed(0)} / ${(r.peak * 100).toFixed(0)}</td>
        <td>${m.releaseDist} / ${r.releaseDist}</td><td>${m.coast} / ${r.coast}</td>
        <td>${sign(m.minSpeed - r.minSpeed, 0)}</td><td>${d(m.thrPoint, r.thrPoint)}</td>
        <td>${ln(L.turnIn, R2.turnIn)}</td><td>${ln(L.apex, R2.apex)}</td><td>${ln(L.exit, R2.exit)}</td></tr>`;
    }).join('');
    const lineHead = '<th>턴인 라인 m</th><th>꼭짓점 라인 m</th><th>탈출 라인 m</th>';
    $('#co-corners').innerHTML = opp
      ? `<thead><tr><th>코너</th><th>시간</th><th>감속 시작 m</th><th>최저 속도</th><th>탈출 속도</th>${lineHead}</tr></thead><tbody>${rows}</tbody>`
      : `<thead><tr><th>코너</th><th>시간</th><th>제동 시점 m</th><th>최대 제동 %</th><th>해제 거리 m</th><th>코스팅 m</th><th>최저 속도</th><th>가속 시점 m</th>${lineHead}</tr></thead><tbody>${rows}</tbody>`;
    // 차트 (x: 베스트 랩 기준 거리)
    const R = A.ref;
    const xs = [];
    for (let i = 0; i < R.n; i += 3) xs.push(i);
    const pick = (arr, f = (v) => v) => xs.map((i) => f(arr[i]));
    const markers = A.corners.map((c) => ({ x: c.apex, label: String(c.id), color: '--ink-2' }));
    for (const e of lap.incidents) markers.push({ x: e.refIdx, label: '!', color: '--drag' });
    charts.speed.set([
      { name: '베스트', color: '--front', x: xs, y: pick(R.v, (v) => v * 3.6) },
      ...(opp ? [{ name: opp.name, color: '--c2', x: xs, y: pick(opp.best.R.v, (v) => v * 3.6) }] : []),
      { name: `랩 ${lap.lap}`, color: '--accent', x: xs, y: pick(lap.R.v, (v) => v * 3.6) },
    ], { markers, yMin: 0 });
    charts.pedal.set([
      { name: '스로틀', color: '--ok', x: xs, y: pick(lap.R.thr, (v) => v * 100) },
      { name: '브레이크', color: '--drag', x: xs, y: pick(lap.R.brk, (v) => v * 100) },
      { name: '베스트 스로틀', color: '--ok', x: xs, y: pick(R.thr, (v) => v * 100), dash: [4, 4], width: 1 },
      { name: '베스트 브레이크', color: '--drag', x: xs, y: pick(R.brk, (v) => v * 100), dash: [4, 4], width: 1 },
    ], { markers, yMin: 0, yMax: 100 });
    const delta = opp ? Float32Array.from(lap.R.t, (t, i) => t - opp.best.R.t[i]) : lap.delta;
    $('#co-delta-name').textContent = opp ? opp.name : '베스트';
    charts.delta.set([{ name: `${opp ? opp.name : '베스트'} 대비`, color: '--accent', x: xs, y: pick(delta) }], { markers });
    // 라인 차이: 기준 라인에 대한 가로 위치를, 그 지점이 속한 코너의 안쪽 방향을 + 로
    const inside = insideSign();
    const base = opp ? opp.best.offset : null;
    const rel = (off) => Float32Array.from(off, (v, i) => inside[i] * (v - (base ? base[i] : 0)));
    charts.line.set([
      { name: `랩 ${lap.lap}`, color: '--accent', x: xs, y: pick(rel(lap.offset)) },
      { name: '기준', color: opp ? '--c2' : '--front', x: xs, y: xs.map(() => 0), dash: [4, 4], width: 1 },
    ], { markers });
    // 코너 확대
    $('#co-zoom-corner').innerHTML = A.corners.map((c, k) => `<option value="${k}">${c.id}번</option>`).join('');
    if (zoomCorner >= A.corners.length) zoomCorner = 0;
    $('#co-zoom-corner').value = String(zoomCorner);
    drawZoom();
  }

  function targetOpp() {
    if (!A || !target.startsWith('o:')) return null;
    return A.opponents.find((o) => 'o:' + o.id === target) || null;
  }

  // 각 지점이 속한 코너의 회전 방향 (코너 구간 밖은 가장 가까운 코너를 따른다)
  function insideSign() {
    const out = new Int8Array(A.ref.n).fill(1);
    A.corners.forEach((c, k) => {
      const end = k + 1 < A.corners.length ? A.corners[k + 1].from : A.ref.n;
      for (let i = k === 0 ? 0 : c.from; i < end; i++) out[i] = c.turn;
    });
    return out;
  }

  // 코너 확대 지도: 실제 축척으로 두 라인과 트랙 폭
  function drawZoom() {
    const w = zoom.parentElement.clientWidth || 600;
    const h = Math.round(Math.min(380, Math.max(240, w * 0.5)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    zoom.width = w * dpr; zoom.height = h * dpr; zoom.style.height = h + 'px';
    const ctx = zoom.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!A) return;
    const c = A.corners[zoomCorner];
    const lap = A.laps[lapIdx];
    const opp = targetOpp();
    const R = A.ref;
    const a = Math.max(0, Math.min(c.turnIn, c.entry) - 60), b = Math.min(R.n - 1, c.exit + 60);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = a; i <= b; i++) { minX = Math.min(minX, R.x[i]); maxX = Math.max(maxX, R.x[i]); minZ = Math.min(minZ, R.z[i]); maxZ = Math.max(maxZ, R.z[i]); }
    const pad = 30;
    const sc = Math.min((w - 2 * pad) / (maxX - minX + 20 || 1), (h - 2 * pad) / (maxZ - minZ + 20 || 1));
    const ox = (w - (maxX - minX) * sc) / 2, oy = (h - (maxZ - minZ) * sc) / 2;
    const P = (x, z) => [ox + (x - minX) * sc, oy + (z - minZ) * sc];
    // 회색 띠: 기준 라인 주변 12 m (대략적인 트랙 폭)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = css('--line');
    ctx.lineWidth = Math.max(4, 2 * 6 * sc);
    ctx.beginPath();
    for (let i = a; i <= b; i++) { const [px, py] = P(R.x[i], R.z[i]); i === a ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
    ctx.stroke();
    // 라인 차이는 보통 1~3 m라 실제 축척에선 겹쳐 보인다. 기준 라인에서의 가로 거리만 EX배로 키워 그린다.
    const EX = 4;
    const path = (off, color, width) => {
      ctx.strokeStyle = css(color); ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = a; i <= b; i++) {
        const i0 = Math.max(0, i - 2), i1 = Math.min(R.n - 1, i + 2);
        const tx = R.x[i1] - R.x[i0], tz = R.z[i1] - R.z[i0];
        const tl = Math.hypot(tx, tz) || 1;
        const o = off ? off[i] * EX : 0;
        const [px, py] = P(R.x[i] - (tz / tl) * o, R.z[i] + (tx / tl) * o);
        i === a ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
    };
    path(null, '--front', 2);
    if (opp) path(opp.best.offset, '--c2', 2);
    if (lap && lap !== A.best) path(lap.offset, '--accent', 2.5);
    // 사고 지점: 비교 랩 위치에 빨간 표시
    if (lap) for (const e of lap.incidents) {
      if (e.refIdx < a || e.refIdx > b) continue;
      const k = e.refIdx;
      const i0 = Math.max(0, k - 2), i1 = Math.min(R.n - 1, k + 2);
      const tx = R.x[i1] - R.x[i0], tz = R.z[i1] - R.z[i0], tl = Math.hypot(tx, tz) || 1;
      const o = lap.offset ? lap.offset[k] * EX : 0;
      const [px, py] = P(R.x[k] - (tz / tl) * o, R.z[k] + (tx / tl) * o);
      ctx.strokeStyle = css('--drag'); ctx.lineWidth = e.refIdx === focusIdx ? 4 : 3;
      ctx.beginPath(); ctx.moveTo(px - 7, py - 7); ctx.lineTo(px + 7, py + 7); ctx.moveTo(px + 7, py - 7); ctx.lineTo(px - 7, py + 7); ctx.stroke();
      ctx.fillStyle = css('--drag'); ctx.textAlign = 'left'; ctx.font = `600 11px ${css('--font-data')}`;
      ctx.fillText(e.name, px + 10, py + 4);
    }
    // 턴인·꼭짓점·탈출 표시 (기준 랩 위)
    ctx.font = `600 11px ${css('--font-data')}`;
    ctx.fillStyle = css('--ink');
    ctx.textAlign = 'center';
    for (const [i, label] of [[c.turnIn, '턴인'], [c.apex, '꼭짓점'], [Math.min(R.n - 1, c.exit), '탈출']]) {
      const [px, py] = P(R.x[i], R.z[i]);
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillText(label, px, py - 9);
    }
    // 축척 막대 10 m
    ctx.strokeStyle = css('--ink-2'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(12, h - 14); ctx.lineTo(12 + 10 * sc, h - 14); ctx.stroke();
    ctx.fillStyle = css('--ink-2'); ctx.textAlign = 'left';
    ctx.fillText(`10 m · 라인 사이 가로 거리는 ${EX}배 확대`, 16 + 10 * sc, h - 10);
    const L = lap.line[zoomCorner], B = (opp ? opp.best : A.best).line[zoomCorner];
    const edgeTxt = Number.isFinite(L.apexEdge) && L.apexEdge !== null ? ` · 꼭짓점에서 안쪽 가장자리까지 ${L.apexEdge.toFixed(1)} m` : '';
    $('#co-zoom-info').textContent = lap === A.best && !opp ? '베스트 랩입니다. 다른 랩을 고르면 두 라인이 겹쳐 보입니다.'
      : `기준 대비 (안쪽 +) 턴인 ${sign(L.turnIn - B.turnIn, 1)} m · 꼭짓점 ${sign(L.apex - B.apex, 1)} m · 탈출 ${sign(L.exit - B.exit, 1)} m${edgeTxt}`;
  }

  // ---------- 컨트롤 ----------
  $('#co-live-btn').addEventListener('click', connect);
  $('#co-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; });
  $('#co-play').addEventListener('click', toggleReplay);
  $('#co-target').addEventListener('change', (e) => { target = e.target.value; stopReplay(); render(); });
  $('#co-zoom-corner').addEventListener('change', (e) => { zoomCorner = +e.target.value; drawZoom(); });
  new ResizeObserver(() => { if (A) drawZoom(); }).observe(zoom.parentElement);
  new ResizeObserver(() => { setupMap(); drawMap(); }).observe(map.parentElement);

  return {
    setVisible(v) { visible = v; if (v) { setupMap(); drawMap(); } },
    themeChanged() { if (visible) render(); },
    _debug: () => ({ A, samples }),
  };
}
