// 코칭 탭: 실시간 연결(브리지)·기록 파일·데모 세션 → 랩 분석, 지도 고스트, 코너별 비교, 코칭, 음성 안내
import { engineFor } from './drivetrain.js';
import { buildTrack, TRACKS } from './track.js';
import { analyzeSession, coachLap, sessionSummary, cornerMetrics, cornerReasons } from './coach.js';
import { makeDemoSession } from './coach-demo.js';
import { LineChart } from './chart.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
const fmt = (t) => {
  if (!Number.isFinite(t)) return '–';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
};
const sign = (x, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;

export function createCoach({ root, getCar, getCarId, getEnv }) {
  const $ = (s) => root.querySelector(s);
  const map = $('#co-map');
  const charts = {
    speed: new LineChart($('#co-c-speed'), { xLabel: 'm', yLabel: 'km/h', height: 200 }),
    pedal: new LineChart($('#co-c-pedal'), { xLabel: 'm', yLabel: '%', height: 170 }),
    delta: new LineChart($('#co-c-delta'), { xLabel: 'm', yLabel: '초', height: 150 }),
  };
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
    live = { lapStartT: null, lap: null, dist: 0, last: null, cornerSpoken: new Set() };
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

  function demo() {
    status('데모 세션을 만드는 중…');
    setTimeout(() => {
      const tid = $('#co-demo-track').value;
      const D = makeDemoSession(getCar(), getEnv(), engineFor(getCarId()), buildTrack(tid), { laps: 6, seed: Math.floor(Math.random() * 1000) });
      samples = D.samples;
      sessionName = D.name;
      analyze();
    }, 30);
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
    status(`${sessionName} · 완주 랩 ${A.laps.length}개 · 코너 ${A.corners.length}개 검출`);
    render();
  }

  // ---------- 실시간 ----------
  function onLiveSample(s) {
    samples.push(s);
    const L = live;
    if (L.lap !== s.lap) {
      const finished = L.lap !== null;
      L.lap = s.lap; L.lapStartT = s.t; L.dist = 0; L.cornerSpoken = new Set();
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
    if (s.off) $('#co-live-flag').textContent = '트랙 이탈 · 이번 랩 무효';
    else $('#co-live-flag').textContent = '';
    if (!A) return;
    // 베스트 랩의 같은 거리 지점과 시간 비교 (주행 거리는 위치 변화로 누적)
    const R = A.ref;
    const idx = Math.min(R.n - 1, Math.floor((L.dist / R.length) * R.n));
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
    drawMap({ live: { x: s.x, z: s.z }, ghost: ghostAt(t) });
    // 코너를 빠져나가면 그 코너만 바로 평가해서 음성으로 알려준다
    if ($('#co-voice').checked) {
      for (const c of A.corners) {
        if (idx > c.to && idx < c.to + 40 && !L.cornerSpoken.has(c.id)) {
          L.cornerSpoken.add(c.id);
          speakCorner(c, L);
        }
      }
    }
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
    dot(extra.ghost, css('--front'), 6);
    dot(extra.cur, css('--accent'));
    dot(extra.live, css('--accent'));
  }

  // 고스트 재생: 베스트(파랑)와 비교 랩(주황)을 같은 시간축으로 움직인다
  let replay = null;
  function toggleReplay() {
    if (replay) { replay = null; $('#co-play').textContent = '고스트 재생'; drawMap(); return; }
    if (!A) return;
    $('#co-play').textContent = '정지';
    const lap = A.laps[lapIdx];
    const start = performance.now();
    const speedUp = +$('#co-speedup').value || 1;
    replay = { lap };
    const tick = (now) => {
      if (!replay || replay.lap !== lap) return;
      const t = ((now - start) / 1000) * speedUp;
      const at = (R) => {
        let lo = 0, hi = R.n - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (R.t[mid] < t) lo = mid + 1; else hi = mid; }
        return lo;
      };
      const gi = at(A.ref);
      const ci = at(lap.R);
      drawMap({ ghost: { x: A.ref.x[gi], z: A.ref.z[gi] }, cur: { x: lap.R.x[ci], z: lap.R.z[ci] } });
      $('#co-replay-info').textContent = `${t.toFixed(1)}초 · 지금 지점에서 베스트 대비 ${sign(lap.delta[ci])}초`;
      for (const ch of Object.values(charts)) { ch.markers = [{ x: ci, label: '', color: '--accent' }]; ch.draw(); }
      if (t > Math.max(lap.time, A.best.time) + 1) { toggleReplay(); return; }
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
    // 랩 목록
    $('#co-laps').innerHTML = A.laps.map((l, i) => `<tr class="${i === lapIdx ? 'sel' : ''}" data-i="${i}">
      <td>랩 ${l.lap}</td><td>${fmt(l.time)}</td><td>${l === A.best ? '베스트' : l.valid ? sign(l.time - A.best.time, 3) : '무효'}</td></tr>`).join('');
    for (const tr of $('#co-laps').querySelectorAll('tr')) tr.addEventListener('click', () => { lapIdx = +tr.dataset.i; replay = null; render(); });
    $('#co-best').textContent = fmt(A.best.time);
    $('#co-theory').textContent = fmt(A.theoretical);
    $('#co-gap').textContent = sign(A.best.time - A.theoretical, 3);
    // 세션 요약: 손해 큰 코너
    const sum = sessionSummary(A).slice(0, 4);
    $('#co-summary').innerHTML = sum.map((s) => `<li><b>${s.corner}번 코너</b> 랩마다 평균 ${s.avgLoss.toFixed(2)}초 손해${s.spread > 0.1 ? `, 랩마다 편차 ${s.spread.toFixed(2)}초 (일관성 부족)` : ''}</li>`).join('');
    // 비교 랩 코칭
    $('#co-lapname').textContent = `랩 ${lap.lap} (${fmt(lap.time)}${lap.valid ? '' : ', 무효'})`;
    const tips = coachLap(A, lap);
    $('#co-tips').innerHTML = tips.length
      ? tips.slice(0, 6).map((t) => `<li><div class="tip-head"><b>${t.corner}번 코너</b><span class="loss">−${t.loss.toFixed(2)}초</span><span class="ref">기준: 랩 ${t.refLap}</span></div>${t.reasons.map((r) => `<p>${r}</p>`).join('')}</li>`).join('')
      : `<li><p>${lap === A.best ? '베스트 랩입니다. 다른 랩을 골라 비교하세요.' : '모든 코너에서 코너별 최고 기록과 0.04초 이내입니다.'}</p></li>`;
    // 코너 표 (비교 랩 vs 베스트)
    const rows = A.corners.map((c, k) => {
      const m = lap.corners[k], r = A.best.corners[k];
      const d = (a, b) => (a === null || b === null ? '–' : `${a - b > 0 ? '+' : ''}${a - b}`);
      return `<tr><td>${c.id}</td><td class="${m.time - r.time > 0.04 ? 'bad' : m.time - r.time < -0.04 ? 'good' : ''}">${sign(m.time - r.time)}</td>
        <td>${d(m.brakePoint, r.brakePoint)}</td><td>${(m.peak * 100).toFixed(0)} / ${(r.peak * 100).toFixed(0)}</td>
        <td>${m.releaseDist} / ${r.releaseDist}</td><td>${m.coast} / ${r.coast}</td>
        <td>${sign(m.minSpeed - r.minSpeed, 0)}</td><td>${d(m.thrPoint, r.thrPoint)}</td></tr>`;
    }).join('');
    $('#co-corners').innerHTML = `<thead><tr><th>코너</th><th>시간</th><th>제동 시점 m</th><th>최대 제동 %</th><th>해제 거리 m</th><th>코스팅 m</th><th>최저 속도</th><th>가속 시점 m</th></tr></thead><tbody>${rows}</tbody>`;
    // 차트 (x: 베스트 랩 기준 거리)
    const R = A.ref;
    const xs = [];
    for (let i = 0; i < R.n; i += 3) xs.push(i);
    const pick = (arr, f = (v) => v) => xs.map((i) => f(arr[i]));
    const markers = A.corners.map((c) => ({ x: c.apex, label: String(c.id), color: '--ink-2' }));
    charts.speed.set([
      { name: '베스트', color: '--front', x: xs, y: pick(R.v, (v) => v * 3.6) },
      { name: `랩 ${lap.lap}`, color: '--accent', x: xs, y: pick(lap.R.v, (v) => v * 3.6) },
    ], { markers, yMin: 0 });
    charts.pedal.set([
      { name: '스로틀', color: '--ok', x: xs, y: pick(lap.R.thr, (v) => v * 100) },
      { name: '브레이크', color: '--drag', x: xs, y: pick(lap.R.brk, (v) => v * 100) },
      { name: '베스트 스로틀', color: '--ok', x: xs, y: pick(R.thr, (v) => v * 100), dash: [4, 4], width: 1 },
      { name: '베스트 브레이크', color: '--drag', x: xs, y: pick(R.brk, (v) => v * 100), dash: [4, 4], width: 1 },
    ], { markers, yMin: 0, yMax: 100 });
    charts.delta.set([{ name: '베스트 대비', color: '--accent', x: xs, y: pick(lap.delta) }], { markers });
  }

  // ---------- 컨트롤 ----------
  $('#co-live-btn').addEventListener('click', connect);
  $('#co-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; });
  $('#co-demo').addEventListener('click', demo);
  $('#co-play').addEventListener('click', toggleReplay);
  $('#co-demo-track').innerHTML = Object.entries(TRACKS).filter(([id]) => id !== 'oval').map(([id, t]) => `<option value="${id}">${t.name}</option>`).join('');
  new ResizeObserver(() => { setupMap(); drawMap(); }).observe(map.parentElement);

  return {
    setVisible(v) { visible = v; if (v) { setupMap(); drawMap(); } },
    themeChanged() { if (visible) render(); },
    _debug: () => ({ A, samples }),
  };
}
