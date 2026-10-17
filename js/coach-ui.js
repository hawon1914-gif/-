// 코칭 탭: 실시간 연결(브리지)·기록 파일 → 기준 랩(세션 최고) 비교, 지도·고스트·미니맵, 개선할 것, 사고 분석, 브레이킹 구간
import { cornerGuide, guideText } from './coach.js';
import { analyzeSession, coachLap, sessionSummary, cornerMetrics, cornerReasons, speedMetrics, speedReasons, defaultReference, externalCandidates, referenceCandidates, FIX } from './coach.js';
import { LineChart } from './chart.js';
import { findShape, alignShape, makeBins, addBin, binsToObs, layoutFromBins, cornersFromShape } from './track-maps.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
const fmt = (t) => {
  if (!Number.isFinite(t)) return '–';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
};
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const sign = (x, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
// "1:28.500" 또는 "88.5" → 초
const parseTime = (txt) => {
  const m = String(txt).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? (m[1] ? +m[1] * 60 : 0) + +m[2] : null;
};
const SESSION = (n) => (n === 0 ? '테스트' : n <= 4 ? '연습' : n <= 8 ? '예선' : n === 9 ? '웜업' : n <= 13 ? '레이스' : '');
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 못 해도 동작에는 문제없다 */ } },
};

export function createCoach({ root }) {
  const $ = (s) => root.querySelector(s);
  const map = $('#co-map');
  const zoom = $('#co-zoom');
  const charts = {
    speed: new LineChart($('#co-c-speed'), { xLabel: 'm', yLabel: 'km/h', height: 200 }),
    delta: new LineChart($('#co-c-delta'), { xLabel: 'm', yLabel: '초', height: 150 }),
    line: new LineChart($('#co-c-line'), { xLabel: 'm', yLabel: 'm', height: 150 }),
  };
  const incChart = new LineChart($('#co-c-inc'), { xLabel: '초', yLabel: 'km/h · %', height: 220 });

  let samples = [];
  let A = null; // 분석 결과 (완주 랩 있음)
  let N = null; // 완주 랩이 없어 사고 분석만 된 결과
  let refKey = ''; // 직접 고른 기준 랩 (비어 있으면 자동: 같은 클래스에서 가장 빠른 랩)
  let extraRefs = []; // 기준 랩 파일에서 가져온 후보
  let lapIdx = -1; // 비교 랩
  let selInc = null;
  let zoomCorner = 0;
  let zoomView = null; // 코너 라인 확대 { k, dx, dy }
  let showAllInc = false;
  let sessionName = '';
  let visible = false;
  let liveInfo = null;
  let liveLayout = null; // 실시간: 트랙 지도 (저장된 것, 실제 서킷 모양을 맞춘 것, 주행 위치로 만든 것)
  let liveShape = null; // 이 트랙의 실제 서킷 모양 (아직 게임 좌표에 맞추기 전)
  let liveBins = null; // 랩 거리별로 모은 나·다른 차 위치

  const status = (t) => { $('#co-status').textContent = t; };
  const ref = () => (A ? A.refs.find((c) => c.key === refKey && c.lap) || defaultReference(A) : null);
  const refR = () => ref()?.lap?.R || A?.ref;
  const trackName = () => (A?.best.samples[0].track || N?.samples?.[0]?.track || samples[0]?.track || '');

  // ---------- 데이터 소스 ----------
  let es = null;
  let live = null;
  let autoBlocked = false; // 직접 "연결 끊기"를 누르면 자동 연결을 멈춘다 (자동 연결을 다시 켜면 풀림)
  function connect(auto = false) {
    if (es && auto) return;
    if (es) { autoBlocked = true; es.close(); es = null; $('#co-live-btn').textContent = '실시간 연결'; status('연결을 끊었습니다.'); $('#co-live').hidden = true; live = null; return; }
    const port = +$('#co-port').value || 8770;
    try { localStorage.setItem('aerolab-port', String(port)); } catch { /* 무시 */ }
    samples = [];
    A = null; N = null; refKey = ''; extraRefs = []; liveLayout = null; liveShape = null; liveBins = null;
    live = { lapStartT: null, lap: null, dist: 0, last: null, prev: null, cornerSpoken: new Set(), cars: null, carsPrev: new Map(), carsT: 0, trafficIdx: -1 };
    es = new EventSource(`http://127.0.0.1:${port}/stream`);
    $('#co-live-btn').textContent = '연결 끊기';
    status(`127.0.0.1:${port}에 연결 중… 브리지(lmu_bridge.py)가 켜져 있어야 합니다.`);
    let first = true;
    es.onmessage = (e) => {
      const s = JSON.parse(e.data);
      if (first) {
        first = false;
        sessionName = `${s.track || '트랙'} · ${s.car || ''}`;
        liveLayout = store.get('aerolab.layout.' + (s.track || ''));
        liveShape = liveLayout ? null : findShape(s.track);
        liveBins = s.trackLen > 100 ? makeBins(s.trackLen) : null;
        status(`연결됨: ${sessionName}${liveLayout ? '' : liveShape ? ' · 트랙 지도를 띄웠습니다. 달리기 시작하면 몇 초 안에 위치가 맞춰집니다' : ' · 이 트랙은 지도 데이터가 없어 나와 다른 차가 지나간 위치로 지도를 만듭니다'}`);
        $('#co-live').hidden = false;
        setupMap();
      }
      onLiveSample(s);
    };
    es.onerror = () => status(first
      ? `브리지에 연결할 수 없습니다 (127.0.0.1:${port}). 브리지를 켜고 다시 누르세요.`
      : `브리지와 연결이 끊겼습니다. 다시 켜지면 자동으로 이어집니다. 지금까지 받은 ${samples.length.toLocaleString()}개 샘플은 그대로 분석되어 있습니다.`);
  }

  const readJsonl = (file) => file.text().then((txt) => txt.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
  function loadFile(file) {
    readJsonl(file).then((rows) => {
      samples = rows;
      extraRefs = [];
      refKey = '';
      sessionName = `${samples[0]?.track || file.name} · ${samples[0]?.car || ''}`;
      analyze();
    }).catch((err) => status(`파일을 읽지 못했습니다: ${err.message}`));
  }
  function loadRefFile(file) {
    if (!A) { status('먼저 분석할 주행(실시간 또는 기록 파일)이 있어야 기준 랩을 붙일 수 있습니다.'); return; }
    readJsonl(file).then((rows) => {
      const label = file.name.replace(/\.jsonl?$/, '').slice(0, 24);
      const res = externalCandidates(A, rows, label);
      if (res.error) { status(`기준 랩 파일: ${res.error}`); return; }
      extraRefs = [...extraRefs.filter((c) => !c.key.startsWith('f:' + label + ':')), ...res.list];
      A.refs = referenceCandidates(A, extraRefs);
      A._layout = null; A._guide = null;
      status(`기준 랩 파일에서 ${res.list.length}개 랩을 후보로 추가했습니다.`);
      render();
    }).catch((err) => status(`파일을 읽지 못했습니다: ${err.message}`));
  }

  // ---------- 분석 ----------
  function analyze(keepLap = false) {
    if (!keepLap) selInc = null;
    const res = analyzeSession(samples);
    N = res.noRef ? res : null;
    if (res.error) {
      status(live ? `${sessionName} · 주행 중 · 랩 비교는 완주 랩이 생기면 시작합니다${liveLayout?.t ? ` · 지금 기준: 저장된 ${liveLayout.refWho} ${fmt(liveLayout.refTime)}` : ''}` : `${sessionName} · ${res.error}`);
      A = null; render(); return;
    }
    A = res;
    if (extraRefs.length) A.refs = referenceCandidates(A, extraRefs);
    if (!A.refs.some((c) => c.key === refKey && c.lap)) refKey = '';
    if (!keepLap || lapIdx < 0 || lapIdx >= A.laps.length) {
      // 기본 비교 랩: 내 베스트 (기준이 다른 사람일 때), 기준이 나면 가장 최근 다른 랩
      const R = ref();
      const others = A.laps.map((l, i) => i).filter((i) => A.laps[i] !== R.lap);
      lapIdx = R.mine ? (others.length ? others[others.length - 1] : 0) : A.laps.indexOf(A.best);
    }
    saveLayout();
    const bad = A.laps.filter((l) => !l.valid).length;
    status(`${sessionName} · 완주 랩 ${A.laps.length}개${bad ? ` (기준 계산에서 뺀 랩 ${bad}개)` : ''} · 사고·실수 ${A.incidents.length}건${A.mixed ? ` · 파일에 트랙·차 조합이 ${A.mixed}개 섞여 있어 가장 긴 세션만 분석` : ''}`);
    render();
  }

  // ---------- 트랙 레이아웃 (지도용, 트랙별로 저장해 다음 실시간 주행에서 첫 랩 전에도 쓴다) ----------
  // { track, x[], z[] (2 m 간격), corners: [{ id, i, v, gear }], sectors: [i], brake: [[a, b]] }
  function layoutFromA() {
    if (!A) return null;
    if (A._layout && A._layout.refKey === ref().key) return A._layout;
    const R = A.ref, RF = refR(), rf = ref();
    const step = 2;
    const x = [], z = [], t = [];
    for (let i = 0; i < R.n; i += step) { x.push(R.x[i]); z.push(R.z[i]); t.push(RF.t[i]); }
    // 제동 구간: 기준 랩 페달이 있으면 그 브레이크, 없으면 기준 랩 속도의 감속(0.5 g 이상)
    const brake = [];
    let from = -1;
    for (let i = 0; i < R.n; i++) {
      let on;
      if (rf?.pedals) on = RF.brk[i] > 0.15;
      else { const j = Math.min(R.n - 1, i + 4); on = RF.v[i] > 5 && ((RF.v[i] - RF.v[j]) / 4) * RF.v[i] / 9.81 > 0.5; }
      if (on && from < 0) from = i;
      if (!on && from >= 0) { if (i - from > 8) brake.push([Math.floor(from / step), Math.floor(i / step)]); from = -1; }
    }
    const corners = A.corners.map((c) => {
      let vmin = Infinity, at = c.apex;
      for (let i = c.entry; i <= Math.min(R.n - 1, c.exit); i++) if (RF.v[i] < vmin) { vmin = RF.v[i]; at = i; }
      const gear = rf?.pedals ? RF.gear[at] : A.ref.gear[at];
      return { id: c.id, i: Math.floor(at / step), v: Math.round(vmin * 3.6), gear };
    });
    // t: 기준 랩이 각 지점을 지난 시간 → 다음 실시간 주행에서 첫 랩부터 기준 대비 시간·고스트를 보여 준다
    A._layout = { track: trackName(), step, x, z, t, len: R.length, refWho: rf.mine ? '내 베스트' : rf.who, refTime: rf.time, corners, sectors: A.sectorIdx.map((i) => Math.floor(i / step)), brake, refKey: rf.key };
    return A._layout;
  }
  function saveLayout() {
    const L = layoutFromA();
    if (!L || !L.track) return;
    const round = (a) => a.map((v) => Math.round(v * 10) / 10);
    const prev = store.get('aerolab.layout.' + L.track);
    // 저장된 기준보다 느린 기준으로 덮어쓰지 않는다 (지도는 갱신)
    const keepRef = prev?.t && prev.refTime < L.refTime && prev.x.length === L.x.length;
    store.set('aerolab.layout.' + L.track, { ...L, x: round(L.x), z: round(L.z), t: keepRef ? prev.t : L.t.map((v) => Math.round(v * 1000) / 1000), refWho: keepRef ? prev.refWho : L.refWho, refTime: keepRef ? prev.refTime : L.refTime });
  }
  function currentLayout() {
    if (A) return layoutFromA();
    if (live && liveLayout) return liveLayout;
    return null;
  }

  // ---------- 지도 그리기 (본 지도·미니맵 창 공용) ----------
  function fitter(L, pts, W, H, top) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const grow = (x, z) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); };
    if (L) for (let i = 0; i < L.x.length; i++) grow(L.x[i], L.z[i]);
    else for (const p of pts) grow(p.x, p.z);
    if (!Number.isFinite(minX)) return null;
    const pad = 22;
    const sc = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - top - 2 * pad) / (maxZ - minZ || 1));
    const ox = (W - (maxX - minX) * sc) / 2, oy = top + (H - top - (maxZ - minZ) * sc) / 2;
    // 게임 좌표 z를 화면 세로로 (위에서 내려다본 모습)
    const f = (x, z) => [ox + (x - minX) * sc, oy + (z - minZ) * sc];
    f.sc = sc;
    return f;
  }

  function drawTrack(ctx, L, xf, { compact = false, noStart = false } = {}) {
    const n = L.x.length;
    const P = (i) => xf(L.x[(i + n) % n], L.z[(i + n) % n]);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // 트랙 띠
    ctx.strokeStyle = css('--line'); ctx.lineWidth = compact ? 7 : 11;
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const [px, py] = P(i); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath(); ctx.stroke();
    // 제동 구간
    ctx.strokeStyle = css('--drag'); ctx.globalAlpha = 0.55; ctx.lineWidth = compact ? 7 : 11;
    for (const [a, b] of L.brake || []) {
      ctx.beginPath();
      for (let i = a; i <= b; i++) { const [px, py] = P(i); i === a ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // 결승선·섹터 경계: 트랙에 수직인 짧은 선
    const tick = (i, label, color) => {
      const [ax, ay] = P(i - 2), [bx, by] = P(i + 2), [px, py] = P(i);
      const tl = Math.hypot(bx - ax, by - ay) || 1;
      const nx = -(by - ay) / tl, ny = (bx - ax) / tl;
      const r = compact ? 7 : 10;
      ctx.strokeStyle = color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(px - nx * r, py - ny * r); ctx.lineTo(px + nx * r, py + ny * r); ctx.stroke();
      if (!compact || label === 'S/F') {
        ctx.fillStyle = color; ctx.font = `600 ${compact ? 9 : 10}px ${css('--font-data')}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, px + nx * (r + 9), py + ny * (r + 9));
      }
    };
    if (noStart) return;
    tick(0, 'S/F', css('--ink'));
    (L.sectors || []).forEach((i, k) => tick(i, `S${k + 2}`, css('--c2')));
    // 진행 방향 화살표 (결승선 조금 뒤)
    if (!compact && n > 30) {
      const [ax, ay] = P(12), [bx, by] = P(22);
      const ang = Math.atan2(by - ay, bx - ax);
      ctx.fillStyle = css('--ink-2');
      ctx.save(); ctx.translate(bx, by); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-5, -5); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    // 코너: 번호 + (최저 속도·기어)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const placed = []; // 겹치는 라벨은 건너뛴다
    for (const c of L.corners || []) {
      const [px, py] = P(c.i);
      const r = compact ? 7 : 9;
      ctx.fillStyle = css('--panel'); ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = css('--ink'); ctx.font = `600 ${compact ? 9 : 10}px ${css('--font-data')}`;
      ctx.fillText(String(c.id), px, py + 0.5);
      if (!compact && Number.isFinite(c.v)) {
        // 라벨은 트랙 바깥쪽(지도 중심 반대편)으로
        const [cx, cy] = [ctx.canvas.clientWidth / 2, ctx.canvas.clientHeight / 2];
        const dx = px - cx, dy = py - cy, dl = Math.hypot(dx, dy) || 1;
        const lx = px + (dx / dl) * 28, ly = py + (dy / dl) * 18;
        if (placed.every(([qx, qy]) => Math.abs(qx - lx) > 46 || Math.abs(qy - ly) > 13)) {
          placed.push([lx, ly]);
          ctx.font = `500 10px ${css('--font-data')}`;
          ctx.fillStyle = css('--ink-2');
          ctx.fillText(`${c.v}${c.gear > 0 ? ` · ${c.gear}단` : ''}`, lx, ly);
        }
      }
    }
  }

  // 위에서 본 작은 차 모양 (앞쪽이 진행 방향)
  function drawCar(ctx, px, py, ang, color, size = 1) {
    ctx.save();
    ctx.translate(px, py); ctx.rotate(ang); ctx.scale(size, size);
    ctx.fillStyle = color; ctx.strokeStyle = css('--panel'); ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(9, 0); ctx.lineTo(5, -4); ctx.lineTo(-7, -4.5); ctx.lineTo(-8, 0); ctx.lineTo(-7, 4.5); ctx.lineTo(5, 4); ctx.closePath();
    ctx.fill(); ctx.stroke();
    // 앞날개·뒷날개·조종석
    ctx.fillStyle = css('--panel');
    ctx.fillRect(-1, -1.6, 4, 3.2);
    ctx.fillStyle = color;
    ctx.fillRect(7, -5, 2, 10);
    ctx.fillRect(-9, -5, 2, 10);
    ctx.restore();
  }
  const headingOf = (xf, a, b) => { const [ax, ay] = xf(a.x, a.z), [bx, by] = xf(b.x, b.z); return Math.atan2(by - ay, bx - ax); };
  const atR = (R, i) => ({ x: R.x[i], z: R.z[i] });
  const headR = (xf, R, i) => headingOf(xf, atR(R, Math.max(0, i - 2)), atR(R, Math.min(R.n - 1, i + 2)));

  // 재생 중 위쪽에 나와 고스트의 속도·기어·스로틀·브레이크
  function drawHud(ctx, W, rows) {
    const h = 20 * rows.length + 8;
    ctx.fillStyle = css('--panel'); ctx.globalAlpha = 0.92;
    ctx.fillRect(6, 6, Math.min(W - 12, 360), h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 1; ctx.strokeRect(6, 6, Math.min(W - 12, 360), h);
    ctx.textBaseline = 'middle';
    rows.forEach((r, k) => {
      const y = 16 + k * 20;
      drawCar(ctx, 18, y, 0, r.color, 0.8);
      ctx.fillStyle = css('--ink'); ctx.textAlign = 'left'; ctx.font = `600 11px ${css('--font-data')}`;
      ctx.fillText(r.name.slice(0, 12), 30, y);
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(r.v * 3.6)} km/h`, 168, y);
      ctx.fillText(r.gear > 0 ? `${r.gear}단` : r.gear === 0 ? 'N' : r.gear < 0 ? 'R' : '', 196, y);
      if (Number.isFinite(r.rpm)) { ctx.font = `10px ${css('--font-data')}`; ctx.fillStyle = css('--ink-2'); ctx.fillText(`${Math.round(r.rpm)}`, 168, y + 9); ctx.font = `600 11px ${css('--font-data')}`; }
      const bar = (x, val, color) => {
        ctx.fillStyle = css('--grid'); ctx.fillRect(x, y - 5, 70, 10);
        if (Number.isFinite(val)) { ctx.fillStyle = color; ctx.fillRect(x, y - 5, 70 * Math.max(0, Math.min(1, val)), 10); }
        else { ctx.fillStyle = css('--ink-2'); ctx.textAlign = 'center'; ctx.font = `10px ${css('--font-data')}`; ctx.fillText('페달 기록 없음', x + 35, y); ctx.font = `600 11px ${css('--font-data')}`; }
      };
      bar(206, r.thr, css('--ok'));
      bar(282, r.brk, css('--drag'));
    });
  }

  let mapXf = null;
  function setupMap() {
    const w = map.clientWidth || 600;
    const h = Math.round(Math.min(460, Math.max(300, w * 0.7)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    map.width = w * dpr; map.height = h * dpr; map.style.height = h + 'px';
    const L = currentLayout() || previewLayout();
    const pts = N ? N.samples.filter((x) => !x.pit && x.v > 1) : samples.filter((x) => !x.pit && x.v > 1);
    mapXf = L || pts.length ? fitter(L, pts, w, h, 52) : null;
  }
  // 위치를 맞추기 전의 실제 서킷 모양 (차 위치는 아직 못 그린다)
  let preview = null;
  function previewLayout() {
    if (A || !live || liveLayout || !liveShape) return null;
    if (preview?.shape !== liveShape) {
      const p = liveShape.pts, x = [], z = [];
      for (let i = 0; i < p.length; i += 2) { x.push(p[i]); z.push(p[i + 1]); }
      preview = { shape: liveShape, layout: { x, z, step: 5, corners: [], preview: true } };
    }
    return preview.layout;
  }

  function drawMap(extra = {}) {
    const ctx = map.getContext('2d');
    const dpr = map.width / (map.clientWidth || 1);
    const W = map.clientWidth, H = map.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!mapXf) return;
    const P = previewLayout();
    if (P) {
      drawTrack(ctx, P, mapXf, { noStart: true });
      ctx.fillStyle = css('--ink-2'); ctx.font = `12px ${css('--font-body')}`; ctx.textAlign = 'center';
      ctx.fillText(`${liveShape.name} · 달리기 시작하면 위치를 맞춥니다`, W / 2, 30);
      return;
    }
    const L = currentLayout();
    if (L) drawTrack(ctx, L, mapXf);
    else drawPath(ctx, N ? N.samples : samples);
    if (A) {
      // 비교 랩: 기준보다 시간을 잃은 곳은 빨강, 번 곳은 초록 (가는 선)
      const lap = A.laps[lapIdx], RF = refR();
      if (lap && lap.R !== RF) {
        const step = 6;
        ctx.lineWidth = 3;
        for (let i = step; i < A.ref.n; i += step) {
          const g = (lap.R.t[i] - RF.t[i]) - (lap.R.t[i - step] - RF.t[i - step]);
          ctx.strokeStyle = g > 0.004 ? css('--drag') : g < -0.004 ? css('--ok') : css('--ink-2');
          const [ax, ay] = mapXf(lap.R.x[i - step], lap.R.z[i - step]);
          const [bx, by] = mapXf(lap.R.x[i], lap.R.z[i]);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        }
      }
    }
    if (N && !A) drawIncidentMarks(ctx, N.incidents);
    for (const o of extra.cars || []) if (!o.pit) drawCar(ctx, ...mapXf(o.x, o.z), o.h ?? 0, css('--ink-2'), 0.8);
    if (extra.ghost) drawCar(ctx, ...mapXf(extra.ghost.x, extra.ghost.z), extra.ghost.h, css('--front'), 1.1);
    if (extra.me) drawCar(ctx, ...mapXf(extra.me.x, extra.me.z), extra.me.h, css('--accent'), 1.2);
    if (extra.hud) drawHud(ctx, W, extra.hud);
  }

  function drawPath(ctx, S) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 9;
    let prev = null;
    ctx.beginPath();
    for (const x of S) {
      if (x.pit || x.v < 1) { prev = null; continue; }
      const [px, py] = mapXf(x.x, x.z);
      if (!prev || (x._seg !== undefined && x._seg !== prev._seg) || Math.hypot(x.x - prev.x, x.z - prev.z) > 30) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      prev = x;
    }
    ctx.stroke();
  }
  function drawIncidentMarks(ctx, list) {
    ctx.font = `600 11px ${css('--font-data')}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    list.forEach((e, n) => {
      const [px, py] = mapXf(e.x, e.z);
      ctx.fillStyle = e === selInc ? css('--drag') : css('--panel');
      ctx.strokeStyle = css('--drag'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = e === selInc ? css('--panel') : css('--drag');
      ctx.fillText(String(n + 1), px, py + 0.5);
    });
  }

  // ---------- 실시간 ----------
  function onLiveSample(s) {
    samples.push(s);
    const L = live;
    if (s.info) liveInfo = s.info;
    if (L.lap !== s.lap) {
      const finished = L.lap !== null;
      L.lap = s.lap; L.lapStartT = s.t; L.dist = 0; L.cornerSpoken = new Set(); L.trafficIdx = -1;
      // 랩 시간은 결승선을 처음 넘은 뒤부터 잰다 (세션 시작 대기·피트 출발·아웃랩은 재지 않는다)
      if (finished) L.timing = true;
      // 랩이 끝날 때마다 세션을 다시 분석
      if (finished) { analyze(true); setupMap(); }
    }
    if (L.last) L.dist += Math.hypot(s.x - L.last.x, s.z - L.last.z);
    const prevPos = L.last;
    L.last = s;
    const t = s.t - L.lapStartT;
    $('#co-live-speed').textContent = (s.v * 3.6).toFixed(0);
    $('#co-live-gear').textContent = s.gear <= 0 ? (s.gear < 0 ? 'R' : 'N') : s.gear;
    $('#co-live-lap').textContent = L.timing ? fmt(t) : '–';
    $('#co-live-lap').title = L.timing ? '' : '결승선을 넘으면 재기 시작합니다';
    buildLiveMap(s);
    $('#co-live-thr').style.width = `${(s.thr * 100).toFixed(0)}%`;
    // 회전수: 85%까지 초록, 95%까지 노랑, 그 위는 빨강 (변속 시점)
    $('#co-live-rpm').textContent = Math.round(s.rpm || 0);
    const rf = s.maxRpm > 0 ? Math.min(1, s.rpm / s.maxRpm) : 0;
    const rb = $('#co-live-rpmbar').firstElementChild;
    rb.style.width = `${(rf * 100).toFixed(0)}%`;
    rb.style.background = rf > 0.95 ? css('--drag') : rf > 0.85 ? css('--warn') : css('--ok');
    $('#co-live-brk').style.width = `${(s.brk * 100).toFixed(0)}%`;
    if (s.cars) {
      // 다른 차의 진행 방향: 지난번 위치와 비교
      for (const o of s.cars) {
        const p = L.carsPrev.get(o.id);
        if (p && Math.hypot(o.x - p.x, o.z - p.z) > 0.3) o.hw = Math.atan2(o.z - p.z, o.x - p.x); else o.hw = p?.hw;
        L.carsPrev.set(o.id, o);
      }
      L.cars = s.cars; L.carsT = s.t;
    }
    const traffic = liveTraffic(s, L);
    $('#co-live-flag').textContent = s.off ? '트랙 이탈' : traffic ? '앞차와 가까움 · 이 구간은 코칭에서 뺍니다' : '';
    // 화면에 그릴 때 쓰는 진행 방향 (월드 좌표 → 지도에서 다시 계산)
    const me = { x: s.x, z: s.z, wx: prevPos ? s.x - prevPos.x : 0, wz: prevPos ? s.z - prevPos.z : 0 };
    let ghost = null, d = null;
    const RF = refR();
    if (!L.timing) {
      $('#co-live-delta').textContent = '–';
      $('#co-live-delta').className = '';
    } else if (!A && liveLayout?.t) {
      // 아직 완주 랩이 없으면 저장된 기준 랩(지난 기록)과 비교
      const LL = liveLayout, n = LL.x.length;
      const len = s.trackLen || LL.len;
      const i = Math.min(n - 1, Math.max(0, Math.floor(((Number.isFinite(s.lapDist) ? s.lapDist : L.dist) / len) * n)));
      d = t - LL.t[i];
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (LL.t[mid] < t) lo = mid + 1; else hi = mid; }
      ghost = { layout: lo };
      showDelta(d, `${LL.refWho} ${fmt(LL.refTime)} 대비`);
    }
    if (A && RF && L.timing) {
      // 지금 위치를 기준 축의 칸으로: 게임의 랩 거리가 있으면 그것, 없으면 이번 랩 주행 거리
      const len = s.trackLen || A.ref.length;
      const idx = Math.min(A.ref.n - 1, Math.max(0, Math.floor(((Number.isFinite(s.lapDist) ? s.lapDist : L.dist) / len) * A.ref.n)));
      if (traffic) L.trafficIdx = idx;
      showNextCorner(idx, s);
      d = t - RF.t[idx];
      let lo = 0, hi = RF.n - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (RF.t[mid] < t) lo = mid + 1; else hi = mid; }
      ghost = { i: lo };
      showDelta(d, `${ref().mine ? "내 베스트" : ref().who} 대비`);
      if ($('#co-voice').checked) {
        for (const c of A.corners) {
          if (idx > c.to && idx < c.to + 40 && !L.cornerSpoken.has(c.id)) {
            L.cornerSpoken.add(c.id);
            if (L.trafficIdx < c.from) speakCorner(c, L);
          }
        }
      }
    }
    // 저장된 지도가 없으면 달린 경로로 그린다: 경로가 커지는 동안 2초마다 다시 맞춘다
    if (!mapXf || (!currentLayout() && samples.length % 120 === 0)) setupMap();
    if (visible && mapXf) {
      const h = (p) => (Math.hypot(p.wx, p.wz) > 0.05 ? headingOf(mapXf, { x: p.x - p.wx, z: p.z - p.wz }, p) : L.h ?? 0);
      L.h = h(me);
      const cars = (L.cars && s.t - L.carsT < 1 ? L.cars : []).map((o) => ({ ...o, h: Number.isFinite(o.hw) ? headingOf(mapXf, { x: o.x - Math.cos(o.hw), z: o.z - Math.sin(o.hw) }, o) : 0 }));
      drawMap({ me: { ...me, h: L.h }, ghost: ghostPos(ghost, mapXf), cars });
    }
    drawMini(s, me, ghost, d);
  }

  // 실시간 트랙 지도: 저장된 게 없으면 나·다른 차 위치를 모아 실제 서킷 모양에 맞추거나, 위치만으로 지도를 만든다
  function buildLiveMap(s) {
    if (liveLayout || !liveBins) return;
    if (!s.pit && s.v > 3) addBin(liveBins, s.x, s.z, s.lapDist);
    if (s.cars) for (const o of s.cars) if (!o.pit && o.v > 3) addBin(liveBins, o.x, o.z, o.ld);
    if (samples.length % 30) return;
    let L = null;
    if (liveShape) L = alignShape(liveShape, binsToObs(liveBins), liveBins.len)?.layout || null;
    if (!L) L = layoutFromBins(liveBins);
    if (!L) return;
    L.corners = cornersFromShape(L);
    L.track = s.track; L.len = liveBins.len; L.sectors = []; L.brake = [];
    liveLayout = L;
    liveShape = null;
    store.set('aerolab.layout.' + s.track, L);
    status(`${sessionName} · 트랙 지도 완성 (${L.source})`);
    setupMap();
  }

  // 다음 코너: 제동까지 남은 거리, 기어, 목표 최저 속도
  function showNextCorner(idx, s) {
    const G = guideFor();
    if (!G) return;
    const n = A.ref.n;
    let best = null;
    for (const g of G) {
      const c = A.corners[g.k];
      const b = Number.isFinite(g.refBrake) ? g.refBrake : c.entry;
      const ahead = (c.apex - idx + n) % n;
      if (ahead > 0 && (!best || ahead < best.ahead)) best = { g, b, ahead, toBrake: (b - idx + n) % n };
    }
    if (!best) return;
    const { g } = best;
    const tb = best.toBrake < best.ahead ? `제동까지 ${best.toBrake} m` : '제동 구간';
    $('#co-live-next').textContent = `다음 ${g.corner}번 · ${tb} · ${g.targetGear ? g.targetGear + '단' : ''} · 최저 ${Math.round(g.refMin ?? g.myMin)} km/h`;
  }
  function guideFor() {
    if (!A) return null;
    const rf = ref();
    if (!A._guide || A._guide.key !== rf.key) A._guide = { key: rf.key, rows: cornerGuide(A, rf) };
    return A._guide.rows;
  }

  function showDelta(d, name) {
    const dEl = $('#co-live-delta');
    dEl.textContent = sign(d);
    dEl.className = d > 0 ? 'slow' : 'fast';
    $('#co-live-dname').textContent = name;
    const k = Math.max(-1, Math.min(1, d));
    const bar = $('#co-live-bar').firstElementChild;
    bar.style.left = `${k >= 0 ? 50 : 50 + k * 50}%`;
    bar.style.width = `${Math.abs(k) * 50}%`;
    bar.style.background = k >= 0 ? css('--drag') : css('--ok');
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
        const p = L.prev;
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

  function speakCorner(c, L) {
    // 이번 랩의 이 코너 구간만 재샘플해 기준 랩과 비교
    const lapSamples = samples.filter((s) => s.lap === L.lap);
    if (lapSamples.length < 20) return;
    const R = A.ref, rf = ref();
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
    const k = c.id - 1;
    let loss, why;
    if (rf.pedals && rf.lap.corners) {
      const m = cornerMetrics(cur, c);
      loss = m.time - rf.lap.corners[k].time;
      why = cornerReasons(m, rf.lap.corners[k])[0]?.short;
    } else {
      const m = speedMetrics(cur, c);
      loss = m.time - rf.lap.speed[k].time;
      why = speedReasons(m, rf.lap.speed[k])[0]?.short;
    }
    if (loss < 0.15) return;
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

  // ---------- 미니맵 창 (항상 위에 뜨는 작은 창) ----------
  let mini = null;
  async function openMini() {
    if (mini) { mini.win.close(); mini = null; return; }
    let win = null;
    try {
      if ('documentPictureInPicture' in window) win = await window.documentPictureInPicture.requestWindow({ width: 340, height: 420 });
    } catch { win = null; }
    let pip = !!win;
    if (!win) { win = window.open('', 'aerolab-mini', 'width=340,height=420'); pip = false; }
    if (!win) { status('미니맵 창을 열지 못했습니다. 브라우저가 팝업을 막았는지 확인하세요.'); return; }
    const d = win.document;
    const vars = ['--bg', '--panel', '--line', '--grid', '--ink', '--ink-2', '--accent', '--front', '--drag', '--ok', '--c2', '--font-data', '--font-display'];
    d.title = 'LMU 코치 미니맵';
    d.head.innerHTML = `<meta charset="utf-8"><style>
      :root { ${vars.map((v) => `${v}: ${css(v)};`).join(' ')} }
      html, body { margin: 0; height: 100%; background: var(--panel); color: var(--ink); font: 12px var(--font-data); overflow: hidden; }
      #top { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 10px 0; }
      #dl { font: 600 30px var(--font-display); }
      #dl.slow { color: var(--drag); } #dl.fast { color: var(--ok); }
      #sg { font-size: 16px; }
      canvas { display: block; width: 100%; }
      .pb { height: 8px; margin: 3px 10px; background: var(--grid); border-radius: 2px; overflow: hidden; }
      .pb i { display: block; height: 100%; width: 0; background: var(--ok); }
      .pb.b i { background: var(--drag); }
    </style>`;
    d.body.innerHTML = '<div id="top"><b id="dl">±0.00</b><span id="sg"></span></div><canvas id="mm"></canvas><div class="pb"><i id="th"></i></div><div class="pb b"><i id="bk"></i></div>';
    mini = { win, d, canvas: d.getElementById('mm'), pip, xf: null, size: '' };
    $('#co-mini-btn').textContent = '미니맵 창 닫기';
    win.addEventListener('pagehide', () => { mini = null; $('#co-mini-btn').textContent = '미니맵 창'; });
    if (!live) status(pip ? '미니맵 창을 열었습니다. 실시간 연결 중에 움직입니다.' : '미니맵 창을 열었습니다 (이 브라우저는 항상 위 창을 지원하지 않아 일반 창으로 열었습니다).');
    drawMini(samples[samples.length - 1], null, null, null);
  }

  // 고스트 위치: 분석된 기준 랩(i) 또는 저장된 지도의 기준 랩(layout)
  function ghostPos(g, xf) {
    if (!g || !xf) return null;
    if (Number.isFinite(g.i)) { const RF = refR(); return RF ? { ...atR(RF, g.i), h: headR(xf, RF, g.i) } : null; }
    const LL = liveLayout, n = LL.x.length, j = g.layout;
    const a = { x: LL.x[Math.max(0, j - 1)], z: LL.z[Math.max(0, j - 1)] }, b = { x: LL.x[Math.min(n - 1, j + 1)], z: LL.z[Math.min(n - 1, j + 1)] };
    return { x: LL.x[j], z: LL.z[j], h: headingOf(xf, a, b) };
  }

  function drawMini(s, me, ghost, d) {
    if (!mini || !s) return;
    const { d: doc, canvas, win } = mini;
    const W = win.innerWidth, H = Math.max(120, win.innerHeight - 70);
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    const L = currentLayout();
    const key = `${W}x${H}:${L ? L.track + L.x.length : 'path' + (samples.length >> 7)}`;
    if (mini.size !== key || !mini.xf) {
      canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + 'px';
      mini.xf = fitter(L, samples.filter((x) => !x.pit && x.v > 1), W, H, 0);
      mini.size = key;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const xf = mini.xf;
    if (!xf) return;
    const saveXf = mapXf;
    mapXf = xf;
    if (L) drawTrack(ctx, L, xf, { compact: true }); else drawPath(ctx, samples);
    mapXf = saveXf;
    const RF = refR();
    const gp = ghostPos(ghost, xf);
    if (gp) drawCar(ctx, ...xf(gp.x, gp.z), gp.h, css('--front'), 1);
    if (live?.cars) for (const o of live.cars) if (!o.pit) drawCar(ctx, ...xf(o.x, o.z), Number.isFinite(o.hw) ? headingOf(xf, { x: o.x - Math.cos(o.hw), z: o.z - Math.sin(o.hw) }, o) : 0, css('--ink-2'), 0.7);
    const m = me || s;
    const h = me && Math.hypot(me.wx, me.wz) > 0.05 ? headingOf(xf, { x: me.x - me.wx, z: me.z - me.wz }, me) : 0;
    drawCar(ctx, ...xf(m.x, m.z), h, css('--accent'), 1.2);
    const dl = doc.getElementById('dl');
    if (d !== null && d !== undefined) { dl.textContent = sign(d); dl.className = d > 0 ? 'slow' : 'fast'; } else dl.textContent = '±0.00';
    doc.getElementById('sg').textContent = `${Math.round(s.v * 3.6)} km/h · ${s.gear > 0 ? s.gear + '단' : s.gear === 0 ? 'N' : 'R'} · ${Math.round(s.rpm || 0)} rpm`;
    doc.getElementById('th').style.width = `${Math.round((s.thr ?? 0) * 100)}%`;
    doc.getElementById('bk').style.width = `${Math.round((s.brk ?? 0) * 100)}%`;
  }

  // ---------- 고스트 재생 ----------
  // 고른 랩(또는 세션 전체를 이어서)과 고스트 랩을 같은 시간축으로 움직인다. 고스트는 랩마다 처음부터 다시 출발한다.
  let replay = null;
  function ghostLaps() {
    const out = A.refs.filter((c) => c.lap).map((c) => ({ key: c.key, name: `${c.who} ${fmt(c.time)}`, short: c.who, lap: c.lap, pedals: c.pedals }));
    A.laps.forEach((l, i) => { if (l.valid && l !== A.best) out.push({ key: 'l' + i, name: `내 랩 ${l.lap} ${fmt(l.time)}`, short: `랩 ${l.lap}`, lap: l, pedals: true }); });
    return out;
  }
  function fillReplaySelects() {
    const lapSel = $('#co-rp-lap'), gSel = $('#co-rp-ghost');
    const keepL = lapSel.value, keepG = gSel.value || ref().key;
    lapSel.innerHTML = `<option value="sel">선택한 랩</option><option value="all">세션 전체 이어서</option>`;
    gSel.innerHTML = ghostLaps().map((g) => `<option value="${g.key}">${esc(g.name)}</option>`).join('');
    if ([...lapSel.options].some((o) => o.value === keepL)) lapSel.value = keepL;
    gSel.value = [...gSel.options].some((o) => o.value === keepG) ? keepG : ref().key;
  }
  function stopReplay() { replay = null; $('#co-play').textContent = '고스트 재생'; }
  function toggleReplay() {
    if (replay) { stopReplay(); drawMap(); return; }
    if (!A) return;
    $('#co-play').textContent = '정지';
    const seq = $('#co-rp-lap').value === 'all' ? A.laps.slice() : [A.laps[lapIdx]];
    const gl = ghostLaps();
    const ghost = gl.find((g) => g.key === $('#co-rp-ghost').value) || gl[0];
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
      let k = 0;
      while (k < seq.length - 1 && t > seq[k].time) { t -= seq[k].time; k++; }
      const lap = seq[k];
      if (k === seq.length - 1 && t > Math.max(lap.time, ghost.lap.time) + 1) { toggleReplay(); return; }
      const ci = at(lap.R, t);
      const G = ghost.lap.R;
      const gi = at(G, t);
      const row = (R, i, name, color, pedals) => ({ name, color, v: R.v[i], gear: pedals ? R.gear[i] : null, rpm: pedals && R.rpm ? R.rpm[i] : NaN, thr: pedals ? R.thr[i] : NaN, brk: pedals ? R.brk[i] : NaN });
      drawMap({
        ghost: { ...atR(G, gi), h: headR(mapXf, G, gi) },
        me: { ...atR(lap.R, ci), h: headR(mapXf, lap.R, ci) },
        hud: [row(lap.R, ci, `랩 ${lap.lap}`, css('--accent'), true), row(G, gi, ghost.short, css('--front'), ghost.pedals)],
      });
      const dd = lap.R.t[ci] - G.t[ci];
      $('#co-replay-info').textContent = `랩 ${lap.lap}${seq.length > 1 ? ` (${k + 1}/${seq.length})` : ''} · ${t.toFixed(1)}초 · ${ghost.short} 대비 ${sign(dd)}초`;
      if (lap === A.laps[lapIdx]) for (const ch of Object.values(charts)) { ch.markers = [{ x: ci, label: '', color: '--accent' }]; ch.draw(); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------- 트랙·차 상태 ----------
  function renderInfo() {
    const info = A?.info || N?.samples?.slice().reverse().find((x) => x.info)?.info || liveInfo;
    const s0 = (A?.best.samples || N?.samples || samples)[0];
    const items = [];
    if (s0?.track) items.push(['트랙', `${s0.track}${s0.trackLen ? ` · ${(s0.trackLen / 1000).toFixed(2)} km` : ''}`]);
    if (info) {
      if (Number.isFinite(info.session)) items.push(['세션', SESSION(info.session) || String(info.session)]);
      if (info.cls) items.push(['클래스', info.cls]);
      if (Number.isFinite(info.air)) items.push(['기온 / 노면', `${info.air.toFixed(0)}°C / ${info.trackT.toFixed(0)}°C`]);
      if (Number.isFinite(info.rain)) items.push(['비 / 젖음', `${Math.round(info.rain * 100)}% / ${Math.round(info.wet * 100)}%`]);
    }
    $('#co-info').hidden = !items.length;
    $('#co-info').innerHTML = items.map(([k, v]) => `<div>${k} <b>${esc(v)}</b></div>`).join('')
      + '';
  }

  // ---------- 사고 ----------
  const incLine = (e, withLap, num) => {
    const rs = (e.reasons || []).filter((r) => r.label);
    const fix = rs.find((r) => r.fix)?.fix;
    return `<div class="row1"><b>${num ? `${num}. ` : ''}${withLap ? `랩 ${e.lap} · ` : ''}${e.corner ? `${e.corner}번 코너` : Number.isFinite(e.lapDist) ? `${e.lapDist.toFixed(0)} m 지점` : ''}</b>
      <span>${esc(e.name.replace(/ \(.*\)/, ''))}</span>${e.loss > 0.05 ? `<span class="loss">−${e.loss.toFixed(2)}초</span>` : ''}
      ${rs.slice(0, 3).map((r) => `<span class="co-chip">${esc(r.label)}</span>`).join('')}${fix ? ` → <span class="fix">${esc(fix)}</span>` : ''}</div>
      ${(e.recoveryTips || []).length ? `<div class="row1 rec"><b>회복</b>${e.recoveryTips.map((r) => `<span class="co-chip ${r.good ? 'good' : ''}">${esc(r.label)}</span>${r.fix ? ` → <span class="fix">${esc(r.fix)}</span>` : ''}`).join(' ')}</div>` : ''}
      <details><summary>자세히</summary>${e.causes.map((c) => `<p>${esc(c)}</p>`).join('')}${e.evidence ? `<p>${esc(e.evidence)}</p>` : ''}</details>`;
  };
  function renderIncidents(list, withLap) {
    const order = withLap ? list.slice().sort((a, b) => (b.loss ?? 0) - (a.loss ?? 0)) : list;
    $('#co-inc-box').hidden = !order.length;
    $('#co-incidents').innerHTML = order.map((e, n) => `<li data-n="${n}" class="${e === selInc ? 'sel' : ''}" ${n >= 5 && !showAllInc ? 'hidden' : ''}>${incLine(e, withLap, withLap ? null : n + 1)}</li>`).join('')
      + (order.length > 5 ? `<button type="button" id="co-inc-more">${showAllInc ? '접기' : `${order.length - 5}건 더 보기`}</button>` : '');
    $('#co-inc-more')?.addEventListener('click', () => { showAllInc = !showAllInc; render(); });
    $('#co-incidents').querySelectorAll('li').forEach((li) => li.addEventListener('click', (ev) => {
      if (ev.target.closest('summary')) return;
      const e = order[+li.dataset.n];
      selInc = e;
      if (A) {
        const i = A.laps.findIndex((l) => l.incidents.includes(e));
        if (i >= 0) lapIdx = i;
        if (e.cornerIdx >= 0) zoomCorner = e.cornerIdx;
      }
      stopReplay(); render();
      $('#co-incfig').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    drawIncChart();
  }
  // 사고 장면: 앞뒤 6초 기록(차트)과 그 구간의 내 주행·주변 차(지도)를 같은 시간으로 맞춰 본다
  let incWin = null, incT = 0, incPlay = null;
  function drawIncChart() {
    const src = A ? A.samples : N?.samples;
    $('#co-incfig').hidden = !selInc || !src;
    if (!selInc || !src) return;
    const e = selInc;
    const t0 = src[e.sample].t;
    const seg = src[e.sample]._seg;
    const W = src.filter((x) => x.t >= t0 - 6 && x.t <= t0 + 6 && x._seg === seg);
    const xs = W.map((x) => +(x.t - t0).toFixed(2));
    $('#co-incfig-name').textContent = `· ${e.name}${e.corner ? ` · ${e.corner}번 코너` : ''}`;
    // 주변 차: 이 구간의 다른 차 위치 (id별 궤적)
    const cars = new Map();
    for (const x of W) if (x.cars) for (const o of x.cars) {
      if (o.pit) continue;
      if (Math.hypot(o.x - src[e.sample].x, o.z - src[e.sample].z) > 250) continue;
      if (!cars.has(o.id)) cars.set(o.id, { n: o.n, pts: [] });
      cars.get(o.id).pts.push({ t: x.t - t0, x: o.x, z: o.z });
    }
    incWin = { W, t0, xs, cars, e };
    incChart.set([
      { name: '속도 km/h', color: '--front', x: xs, y: W.map((x) => x.v * 3.6) },
      { name: '스로틀 %', color: '--ok', x: xs, y: W.map((x) => (x.thr ?? NaN) * 100) },
      { name: '브레이크 %', color: '--drag', x: xs, y: W.map((x) => (x.brk ?? NaN) * 100) },
      { name: '조향 %', color: '--c2', x: xs, y: W.map((x) => (x.steer ?? NaN) * 100) },
      ...(W.some((x) => Number.isFinite(x.slip) && x.slip !== 0) ? [{ name: '미끄러짐 °', color: '--warn', x: xs, y: W.map((x) => x.slip) }] : []),
    ], { markers: [{ x: 0, label: '시작', color: '--drag' }] });
    setIncT(0);
  }
  function setIncT(t) {
    incT = t;
    $('#co-inc-t').value = String(t);
    $('#co-inc-tl').textContent = `${t >= 0 ? '+' : ''}${t.toFixed(1)}초`;
    if (!incWin) return;
    incChart.markers = [{ x: 0, label: '시작', color: '--drag' }, { x: t, label: '', color: '--accent' }];
    incChart.draw();
    drawIncMap();
  }
  function drawIncMap() {
    const cv = $('#co-incmap');
    const W0 = cv.clientWidth || 360, H0 = cv.clientHeight || 260;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W0 * dpr; cv.height = H0 * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W0, H0);
    const { W, t0, cars } = incWin;
    if (W.length < 2) return;
    // 내 궤적 범위 + 여유 40 m
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const x of W) { minX = Math.min(minX, x.x); maxX = Math.max(maxX, x.x); minZ = Math.min(minZ, x.z); maxZ = Math.max(maxZ, x.z); }
    minX -= 40; maxX += 40; minZ -= 40; maxZ += 40;
    const sc = Math.min(W0 / (maxX - minX), H0 / (maxZ - minZ));
    const ox = (W0 - (maxX - minX) * sc) / 2, oy = (H0 - (maxZ - minZ) * sc) / 2;
    const P = (x, z) => [ox + (x - minX) * sc, oy + (z - minZ) * sc];
    // 트랙 (지도가 있으면)
    const L = currentLayout();
    if (L) {
      ctx.strokeStyle = css('--line'); ctx.lineWidth = Math.max(6, 12 * sc); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      let on = false;
      for (let i = 0; i <= L.x.length; i++) {
        const k = i % L.x.length;
        const inside = L.x[k] > minX - 50 && L.x[k] < maxX + 50 && L.z[k] > minZ - 50 && L.z[k] < maxZ + 50;
        if (!inside) { on = false; continue; }
        const [px, py] = P(L.x[k], L.z[k]);
        on ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        on = true;
      }
      ctx.stroke();
    }
    // 주변 차 궤적과 지금 위치
    for (const c of cars.values()) {
      ctx.strokeStyle = css('--ink-2'); ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5;
      ctx.beginPath(); c.pts.forEach((p, i) => { const [px, py] = P(p.x, p.z); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.stroke();
      ctx.globalAlpha = 1;
      let j = 0;
      while (j < c.pts.length - 1 && c.pts[j + 1].t <= incT) j++;
      if (Math.abs(c.pts[j].t - incT) < 0.5) {
        const a = c.pts[Math.max(0, j - 1)], b = c.pts[Math.min(c.pts.length - 1, j + 1)];
        drawCar(ctx, ...P(c.pts[j].x, c.pts[j].z), Math.atan2(P(b.x, b.z)[1] - P(a.x, a.z)[1], P(b.x, b.z)[0] - P(a.x, a.z)[0]), css('--ink-2'), 0.9);
        ctx.fillStyle = css('--ink-2'); ctx.font = `10px ${css('--font-data')}`; ctx.textAlign = 'left';
        ctx.fillText(c.n || '', P(c.pts[j].x, c.pts[j].z)[0] + 9, P(c.pts[j].x, c.pts[j].z)[1] - 6);
      }
    }
    // 내 궤적: 브레이크 빨강 · 스로틀 초록 · 둘 다 아니면 회색
    ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (let i = 1; i < W.length; i++) {
      const x = W[i];
      ctx.strokeStyle = (x.brk ?? 0) > 0.1 ? css('--drag') : (x.thr ?? 0) > 0.1 ? css('--ok') : css('--ink-2');
      ctx.beginPath(); ctx.moveTo(...P(W[i - 1].x, W[i - 1].z)); ctx.lineTo(...P(x.x, x.z)); ctx.stroke();
    }
    // 시작 지점 표시와 지금 위치
    const s0 = W.find((x) => x.t >= t0) || W[0];
    ctx.strokeStyle = css('--drag'); ctx.lineWidth = 2;
    const [sx, sy] = P(s0.x, s0.z);
    ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.stroke();
    let i = 0;
    while (i < W.length - 1 && W[i + 1].t - t0 <= incT) i++;
    const a = W[Math.max(0, i - 2)], b = W[Math.min(W.length - 1, i + 2)];
    const ang = Number.isFinite(b._h) && Math.hypot(b.x - a.x, b.z - a.z) > 0.2 ? Math.atan2(P(b.x, b.z)[1] - P(a.x, a.z)[1], P(b.x, b.z)[0] - P(a.x, a.z)[0]) : 0;
    drawCar(ctx, ...P(W[i].x, W[i].z), ang, css('--accent'), 1.2);
    ctx.fillStyle = css('--ink'); ctx.font = `600 11px ${css('--font-data')}`; ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(W[i].v * 3.6)} km/h · ${W[i].gear > 0 ? W[i].gear + '단' : W[i].gear === 0 ? 'N' : 'R'} · 스로틀 ${Math.round((W[i].thr ?? 0) * 100)}% · 브레이크 ${Math.round((W[i].brk ?? 0) * 100)}%`, 8, 16);
    // 축척 20 m
    ctx.strokeStyle = css('--ink-2'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(8, H0 - 10); ctx.lineTo(8 + 20 * sc, H0 - 10); ctx.stroke();
    ctx.fillStyle = css('--ink-2'); ctx.font = `10px ${css('--font-data')}`; ctx.fillText('20 m', 12 + 20 * sc, H0 - 6);
  }
  function toggleIncPlay() {
    if (incPlay) { cancelAnimationFrame(incPlay); incPlay = null; $('#co-inc-play').textContent = '재생'; return; }
    $('#co-inc-play').textContent = '정지';
    let last = performance.now();
    if (incT >= 5.9) incT = -6;
    const step = (now) => {
      const dt = (now - last) / 1000; last = now;
      const t = Math.min(6, incT + dt);
      setIncT(t);
      if (t >= 6) { incPlay = null; $('#co-inc-play').textContent = '재생'; return; }
      incPlay = requestAnimationFrame(step);
    };
    incPlay = requestAnimationFrame(step);
  }

  // ---------- 개선할 것 (한 눈에) ----------
  function renderImprove(rf) {
    const items = [];
    // 코너: 기준 대비 평균 손해가 큰 곳과 가장 자주 나온 원인
    for (const c of sessionSummary(A, rf).filter((x) => x.avgLoss >= 0.05).slice(0, 3)) {
      const fix = FIX[c.why];
      items.push(`<li><b>${c.corner}번 코너</b> <span class="loss">−${c.avgLoss.toFixed(2)}초/랩</span>${c.why ? ` <span class="co-chip">${esc(c.why)}${c.whyCount > 1 ? ` ×${c.whyCount}` : ''}</span>` : ''}${fix ? ` → <span class="fix">${esc(fix)}</span>` : ''}</li>`);
    }
    // 사고 원인: 같은 원인이 여러 번이면 묶는다
    const byKey = new Map();
    for (const e of A.incidents) for (const r of (e.reasons || []).slice(0, 2)) {
      if (!r.fix) continue;
      const g = byKey.get(r.key) || { n: 0, label: r.label, fix: r.fix, corners: new Set(), loss: 0 };
      g.n++; g.loss += Math.max(0, e.loss ?? 0);
      if (e.corner) g.corners.add(e.corner);
      byKey.set(r.key, g);
    }
    for (const g of [...byKey.values()].sort((a, b) => b.n - a.n || b.loss - a.loss).slice(0, 2)) {
      items.push(`<li><b>사고 원인</b> <span class="co-chip">${esc(g.label)}${g.n > 1 ? ` ×${g.n}` : ''}</span>${g.corners.size ? ` (${[...g.corners].join('·')}번 코너)` : ''} → <span class="fix">${esc(g.fix)}</span></li>`);
    }
    // TC·ABS: 개입이 가장 긴 코너 2곳
    const aids = guideFor().filter((g) => g.abs || g.tc).sort((a, b) => ((b.abs?.m || 0) + (b.tc?.m || 0)) - ((a.abs?.m || 0) + (a.tc?.m || 0))).slice(0, 2);
    for (const g of aids) {
      if (g.abs) items.push(`<li><b>${g.corner}번 코너</b> <span class="co-chip">ABS ${g.abs.m} m</span> → <span class="fix">처음 브레이크 ${Math.round(g.abs.brk * 100)}% → ${Math.max(50, Math.round(g.abs.brk * 100) - 7)}% 정도로</span></li>`);
      if (g.tc) items.push(`<li><b>${g.corner}번 코너</b> <span class="co-chip">TC ${g.tc.m} m</span> → <span class="fix">스로틀 ${Math.max(30, Math.round(g.tc.thr * 100) - 10)}%까지 열고 핸들 풀리면 끝까지</span></li>`);
    }
    $('#co-improve').innerHTML = items.join('') || `<li>${rf.mine ? '내 랩끼리는 큰 차이가 없습니다. 더 빠른 사람의 기록(같은 세션 또는 기준 랩 파일)과 비교하면 더 많이 보입니다.' : '기준 랩과 0.05초 넘게 차이 나는 코너가 없습니다.'}</li>`;
  }

  // ---------- 화면 ----------
  function render() {
    setupMap();
    drawMap();
    renderInfo();
    const has = !!A || !!(N && N.incidents.length);
    $('#co-results').hidden = !has;
    $('#co-lapside').hidden = !A;
    $('#co-lapview').hidden = !A;
    root.querySelector('.co-mapbox .replay').hidden = !A;
    $('#co-map-legend').textContent = currentLayout()
      ? '빨간 띠: 제동 구간 · 숫자: 코너 (최저 속도·기어) · S/F·S2·S3: 결승선·섹터 · 주황 차: 나 · 파랑 차: 기준'
      : '회색: 달린 경로 · 빨간 번호: 사고 지점 (완주 랩이 생기면 트랙 지도로 바뀝니다)';
    if (!A) { if (N) renderIncidents(N.incidents, false); else $('#co-incfig').hidden = true; return; }
    const rf = ref();
    const RF = rf.lap.R;
    const lap = A.laps[lapIdx];
    const myCls = A.myCls;

    // KPI
    $('#co-ref-time').textContent = fmt(rf.time);
    $('#co-ref-who').textContent = `${rf.mine ? '나' : rf.who}${rf.cls ? ` · ${rf.cls}` : ''}${rf.file ? ' · 파일' : ''}`;
    $('#co-best').textContent = fmt(A.best.time);
    $('#co-best-gap').textContent = rf.mine ? '기준 = 내 베스트' : `기준보다 ${sign(A.best.time - rf.time, 3)}`;
    $('#co-theory').textContent = fmt(A.theoretical);
    $('#co-theory-kind').textContent = A.theoryKind;
    // 기준 선택
    $('#co-target').innerHTML = A.refs.map((c) => `<option value="${c.key}" ${c.lap ? '' : 'disabled'}>${esc(c.mine ? '나' : c.who)} ${fmt(c.time)}${c.cls ? ` (${esc(c.cls)})` : ''}${c.lap ? '' : ' · 주행 데이터 없음'}${c.sameClass ? '' : ' · 다른 클래스'}</option>`).join('');
    $('#co-target').value = rf.key;
    // 목표 기록
    const goalKey = `aerolab.goal.${trackName()}|${myCls}`;
    const goal = store.get(goalKey);
    if (document.activeElement !== $('#co-goal')) $('#co-goal').value = goal ? fmt(goal) : '';
    $('#co-goal-gap').textContent = goal ? `목표까지: 내 베스트 ${sign(A.best.time - goal, 3)} · 기준 ${sign(rf.time - goal, 3)}` : '';

    renderImprove(rf);

    // 기록표: 나 + 같이 달린 차, 나와 차이 (+ 느림 / − 빠름)
    const board = [{ key: 'me', who: '나', cls: myCls, time: A.best.time, lap: A.best, me: true }, ...A.refs.filter((c) => !c.mine && !c.file), ...extraRefs]
      .sort((a, b) => a.time - b.time);
    $('#co-board').innerHTML = board.map((c, i) => `<tr class="${c.me ? 'me' : ''} ${(c.me ? 'me' : c.key) === rf.key ? 'sel' : ''}" data-key="${c.me ? 'me' : c.key}">
      <td>${i + 1}</td><td>${esc(c.me ? '나' : c.who)}</td><td class="co-tag">${esc(c.cls || '')}</td><td>${fmt(c.time)}</td>
      <td>${c.me ? '' : sign(c.time - A.best.time, 3)}</td><td class="co-tag">${c.lap ? '' : '데이터 없음'}</td></tr>`).join('');
    for (const tr of $('#co-board').querySelectorAll('tr')) tr.addEventListener('click', () => {
      const c = A.refs.find((x) => x.key === tr.dataset.key);
      if (c?.lap) { refKey = c.key; A._layout = null; stopReplay(); render(); }
    });

    // 내 랩 표: 시간 · 섹터(가장 빠른 섹터 보라) · 기준 대비 · 비고
    const hasSec = A.laps.some((l) => l.sectors);
    const secBest = [0, 1, 2].map((i) => Math.min(...A.laps.filter((l) => l.valid && l.sectors).map((l) => l.sectors[i])));
    $('#co-laps-head').innerHTML = `<tr><th>랩</th><th>시간</th>${hasSec ? '<th>S1</th><th>S2</th><th>S3</th>' : ''}<th>기준 대비</th><th></th></tr>`;
    const tags = (l) => [
      ...l.incidents.map((e) => `${e.name.replace(/ \(.*\)/, '')}${e.corner ? ` ${e.corner}번` : ''}`),
      ...(A.corners.filter((c, k) => l.traffic[k]).length ? [`트래픽 ${A.corners.filter((c, k) => l.traffic[k]).map((c) => c.id).join(',')}번`] : []),
      ...(l.valid ? [] : [`기준 제외: ${l.why[0]}`]),
    ].join(' · ');
    $('#co-laps').innerHTML = A.laps.map((l, i) => `<tr class="${i === lapIdx ? 'sel' : ''}" data-i="${i}">
      <td>랩 ${l.lap}${l === A.best ? ' ★' : ''}</td><td>${fmt(l.time)}</td>
      ${hasSec ? [0, 1, 2].map((k) => `<td class="${l.sectors && l.valid && Math.abs(l.sectors[k] - secBest[k]) < 0.0005 ? 'secbest' : ''}">${l.sectors ? l.sectors[k].toFixed(3) : '–'}</td>`).join('') : ''}
      <td>${l.lap === rf.lap.lap && rf.mine ? '기준' : sign(l.time - rf.time, 3)}</td><td class="traffic">${esc(tags(l))}</td></tr>`).join('');
    for (const tr of $('#co-laps').querySelectorAll('tr')) tr.addEventListener('click', () => { lapIdx = +tr.dataset.i; stopReplay(); render(); });

    renderIncidents(A.incidents, true);
    fillReplaySelects();

    // 코칭 (비교 랩 vs 기준)
    $('#co-lapname').textContent = `랩 ${lap.lap} (${fmt(lap.time)}) vs ${rf.mine ? `내 베스트 랩 ${rf.lap.lap}` : rf.who} (${fmt(rf.time)})`;
    const { tips, skipped } = coachLap(A, lap, rf);
    const lapInc = lap.incidents.map((e) => `<li class="co-inc-tip">${incLine(e, false)}</li>`).join('');
    $('#co-tips').innerHTML = lapInc + (tips.length
      ? tips.slice(0, 6).map((t) => `<li><div class="row1"><b>${t.corner}번 코너</b><span class="loss">−${t.loss.toFixed(2)}초</span>${t.shorts.map((x) => `<span class="co-chip">${esc(x)}</span>`).join('')}${t.fix ? ` → <span class="fix">${esc(t.fix)}</span>` : ''}</div>
          <details><summary>자세히</summary>${t.reasons.map((r) => `<p>${esc(r)}</p>`).join('')}</details></li>`).join('')
      : `<li><p>${lap === rf.lap ? '기준 랩입니다. 내 랩 표에서 다른 랩을 고르세요.' : '사고 구간을 뺀 모든 코너에서 기준과 0.04초 이내입니다.'}</p></li>`);
    $('#co-skipped').hidden = !skipped.length;
    $('#co-skipped').textContent = skipped.length ? `${skipped.join(', ')}번 코너는 다른 차와 붙어 달려서 코칭에서 뺐습니다.` : '';

    renderGuide();
    renderBrakeGrid(lap, rf);
    renderCornerTable(lap, rf);

    // 차트 (x: 기준 축 거리)
    const R = A.ref;
    const xs = [];
    for (let i = 0; i < R.n; i += 3) xs.push(i);
    const pick = (arr, f = (v) => v) => xs.map((i) => f(arr[i]));
    const markers = A.corners.map((c) => ({ x: c.apex, label: String(c.id), color: '--ink-2' }));
    for (const e of lap.incidents) markers.push({ x: e.refIdx, label: '!', color: '--drag' });
    charts.speed.set([
      { name: rf.who, color: '--front', x: xs, y: pick(RF.v, (v) => v * 3.6) },
      { name: `랩 ${lap.lap}`, color: '--accent', x: xs, y: pick(lap.R.v, (v) => v * 3.6) },
    ], { markers, yMin: 0 });
    $('#co-delta-name').textContent = rf.mine ? '내 베스트' : rf.who;
    charts.delta.set([{ name: `${rf.who} 대비`, color: '--accent', x: xs, y: pick(Float32Array.from(lap.R.t, (t, i) => t - RF.t[i])) }], { markers });
    const inside = insideSign();
    const base = rf.lap.offset || new Float32Array(R.n);
    charts.line.set([
      { name: `랩 ${lap.lap}`, color: '--accent', x: xs, y: pick(Float32Array.from(lap.offset, (v, i) => inside[i] * (v - base[i]))) },
      { name: '기준', color: '--front', x: xs, y: xs.map(() => 0), dash: [4, 4], width: 1 },
    ], { markers });
    $('#co-zoom-corner').innerHTML = A.corners.map((c, k) => `<option value="${k}">${c.id}번</option>`).join('');
    if (zoomCorner >= A.corners.length) zoomCorner = 0;
    $('#co-zoom-corner').value = String(zoomCorner);
    drawZoom();
  }

  function renderGuide() {
    const rows = guideFor();
    const hasAids = rows.some((g) => g.hasAids);
    $('#co-guide').innerHTML = `<thead><tr><th>코너</th><th>제동 시점</th><th>기어</th><th>코너 속도</th>${hasAids ? '<th>TC·ABS</th>' : ''}</tr></thead><tbody>${rows.map((g) => {
      const t = guideText(g);
      const cls = (txt) => (/일찍 밟기|과함|지금/.test(txt || '') ? 'warn' : /늦게 밟아도|가능/.test(txt || '') ? 'good' : '');
      return `<tr><td>${g.corner}번</td><td class="${cls(t.brake)}">${esc(t.brake || '–')}</td><td class="${cls(t.gear)}">${esc(t.gear || '–')}${g.recRpm && !g.myGear ? '' : ''}</td><td class="${cls(t.speed)}">${esc(t.speed || '–')}</td>${hasAids ? `<td class="aids">${esc(t.aids || '개입 없음')}</td>` : ''}</tr>`;
    }).join('')}</tbody>`
      + (hasAids ? '' : '<caption class="hint" style="caption-side:bottom;text-align:left">TC·ABS 개입은 새 브리지로 기록한 주행부터 나옵니다.</caption>');
  }

  // 브레이킹 구간만 코너별로: 제동 시작 40 m 전 ~ 꼭짓점 40 m 뒤
  function renderBrakeGrid(lap, rf) {
    const RF = rf.lap.R, R = lap.R;
    const grid = $('#co-brk-grid');
    const cells = [];
    A.corners.forEach((c, k) => {
      const m = lap.corners[k], ms = lap.speed[k];
      const rs = rf.lap.speed[k], rc = rf.pedals ? rf.lap.corners?.[k] : null;
      const starts = [m.brakePoint, rc?.brakePoint, ms.decelStart, rs.decelStart].filter((x) => Number.isFinite(x));
      const a = Math.max(0, Math.min(...starts, c.entry) - 40), b = Math.min(A.ref.n - 1, c.apex + 40);
      const db = m.brakePoint !== null && rc?.brakePoint != null ? m.brakePoint - rc.brakePoint : ms.decelStart - rs.decelStart;
      const dv = ms.minSpeed - rs.minSpeed;
      const dt = rf.pedals && rc ? m.time - rc.time : ms.time - rs.time;
      cells.push({ k, a, b, label: `<b>${c.id}번</b><span>${rc ? '제동' : '감속'} ${db > 0 ? '+' : ''}${db} m · 최저 ${sign(dv, 0)} · <span class="${dt > 0.04 ? 'loss' : ''}">${sign(dt)}초</span></span>` });
    });
    grid.innerHTML = cells.map((x) => `<figure><figcaption>${x.label}</figcaption><canvas data-k="${x.k}"></canvas></figure>`).join('');
    grid.querySelectorAll('canvas').forEach((cv) => {
      const x = cells.find((y) => y.k === +cv.dataset.k);
      const W = cv.clientWidth || 230, H = 110;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = W * dpr; cv.height = H * dpr;
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const X = (i) => 4 + ((i - x.a) / (x.b - x.a || 1)) * (W - 8);
      const Y = (v) => H - 4 - v * (H - 10);
      let vmax = 0;
      for (let i = x.a; i <= x.b; i++) vmax = Math.max(vmax, R.v[i], RF.v[i]);
      const line = (arr, color, dash, width, scale = 1) => {
        ctx.strokeStyle = css(color); ctx.setLineDash(dash); ctx.lineWidth = width;
        ctx.beginPath();
        let started = false;
        for (let i = x.a; i <= x.b; i++) {
          const v = arr[i] * scale;
          if (!Number.isFinite(v)) { started = false; continue; }
          started ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v));
          started = true;
        }
        ctx.stroke(); ctx.setLineDash([]);
      };
      // 속도 (얇은 선, 칸 높이에 맞춤)
      line(RF.v, '--front', [], 1, 1 / (vmax || 1));
      line(R.v, '--accent', [], 1, 1 / (vmax || 1));
      // 페달
      if (rf.pedals) { line(RF.brk, '--drag', [4, 3], 1.5); line(RF.thr, '--ok', [4, 3], 1.5); }
      line(R.brk, '--drag', [], 2);
      line(R.thr, '--ok', [], 2);
      const c = A.corners[x.k];
      ctx.strokeStyle = css('--ink-2'); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(X(c.apex), 2); ctx.lineTo(X(c.apex), H - 2); ctx.stroke(); ctx.setLineDash([]);
    });
  }

  function renderCornerTable(lap, rf) {
    const ln = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? sign(a - b, 1) : '–');
    const pedals = rf.pedals && rf.lap.corners;
    const rows = A.corners.map((c, k) => {
      const tr = lap.traffic[k] ? ' <span class="co-tag">트래픽</span>' : '';
      const L = lap.line[k], R2 = rf.lap.line[k];
      if (!pedals) {
        const m = lap.speed[k], r = rf.lap.speed[k];
        return `<tr><td>${c.id}${tr}</td><td class="${m.time - r.time > 0.04 ? 'bad' : m.time - r.time < -0.04 ? 'good' : ''}">${sign(m.time - r.time)}</td>
          <td>${m.decelStart - r.decelStart > 0 ? '+' : ''}${m.decelStart - r.decelStart}</td><td>${sign(m.minSpeed - r.minSpeed, 0)}</td><td>${sign(m.exitSpeed - r.exitSpeed, 0)}</td>
          <td>${ln(L.turnIn, R2.turnIn)}</td><td>${ln(L.apex, R2.apex)}</td><td>${ln(L.exit, R2.exit)}</td></tr>`;
      }
      const m = lap.corners[k], r = rf.lap.corners[k];
      const d = (a, b) => (a === null || b === null ? '–' : `${a - b > 0 ? '+' : ''}${a - b}`);
      return `<tr><td>${c.id}${tr}</td><td class="${m.time - r.time > 0.04 ? 'bad' : m.time - r.time < -0.04 ? 'good' : ''}">${sign(m.time - r.time)}</td>
        <td>${d(m.brakePoint, r.brakePoint)}</td><td>${(m.peak * 100).toFixed(0)} / ${(r.peak * 100).toFixed(0)}</td>
        <td>${m.releaseDist} / ${r.releaseDist}</td><td>${m.coast} / ${r.coast}</td>
        <td>${sign(m.minSpeed - r.minSpeed, 0)}</td><td>${d(m.thrPoint, r.thrPoint)}</td>
        <td>${ln(L.turnIn, R2.turnIn)}</td><td>${ln(L.apex, R2.apex)}</td><td>${ln(L.exit, R2.exit)}</td></tr>`;
    }).join('');
    const lineHead = '<th>턴인 라인 m</th><th>꼭짓점 라인 m</th><th>탈출 라인 m</th>';
    $('#co-corners').innerHTML = !pedals
      ? `<thead><tr><th>코너</th><th>시간</th><th>감속 시작 m</th><th>최저 속도</th><th>탈출 속도</th>${lineHead}</tr></thead><tbody>${rows}</tbody>`
      : `<thead><tr><th>코너</th><th>시간</th><th>제동 시점 m</th><th>최대 제동 %</th><th>해제 거리 m</th><th>코스팅 m</th><th>최저 속도</th><th>가속 시점 m</th>${lineHead}</tr></thead><tbody>${rows}</tbody>`;
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

  // 코너 확대 지도: 기준 라인과 비교 랩 라인 (가로 차이 4배)
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
    const rf = ref();
    const R = A.ref;
    // 턴인 25 m 전부터 탈출 40 m 뒤까지만 (직선은 길게 그리지 않는다)
    const a = Math.max(0, c.turnIn - 25), b = Math.min(R.n - 1, c.exit + 40);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = a; i <= b; i++) { minX = Math.min(minX, R.x[i]); maxX = Math.max(maxX, R.x[i]); minZ = Math.min(minZ, R.z[i]); maxZ = Math.max(maxZ, R.z[i]); }
    const pad = 30;
    const sc = Math.min((w - 2 * pad) / (maxX - minX + 20 || 1), (h - 2 * pad) / (maxZ - minZ + 20 || 1));
    const ox = (w - (maxX - minX) * sc) / 2, oy = (h - (maxZ - minZ) * sc) / 2;
    const V = zoomView || { k: 1, dx: 0, dy: 0 };
    const P = (x, z) => [(ox + (x - minX) * sc) * V.k + V.dx, (oy + (z - minZ) * sc) * V.k + V.dy];
    const scv = sc * V.k;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = css('--line');
    ctx.lineWidth = Math.max(4, 2 * 6 * scv);
    ctx.beginPath();
    for (let i = a; i <= b; i++) { const [px, py] = P(R.x[i], R.z[i]); i === a ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
    ctx.stroke();
    // 라인 차이는 보통 1~3 m라 실제 축척에선 겹쳐 보인다. 기준 축에서의 가로 거리만 EX배로 키워 그린다.
    const EX = 4;
    const posAt = (off, i) => {
      const i0 = Math.max(0, i - 2), i1 = Math.min(R.n - 1, i + 2);
      const tx = R.x[i1] - R.x[i0], tz = R.z[i1] - R.z[i0];
      const tl = Math.hypot(tx, tz) || 1;
      const o = off ? off[i] * EX : 0;
      return P(R.x[i] - (tz / tl) * o, R.z[i] + (tx / tl) * o);
    };
    const path = (off, color, width) => {
      ctx.strokeStyle = css(color); ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = a; i <= b; i++) { const [px, py] = posAt(off, i); i === a ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
      ctx.stroke();
    };
    // 제동 구간 (기준 랩)
    if (rf.pedals) {
      ctx.strokeStyle = css('--drag'); ctx.globalAlpha = 0.35; ctx.lineWidth = Math.max(4, 2 * 6 * scv);
      ctx.beginPath();
      let on = false;
      for (let i = a; i <= b; i++) {
        const [px, py] = P(R.x[i], R.z[i]);
        if (rf.lap.R.brk[i] > 0.15) { on ? ctx.lineTo(px, py) : ctx.moveTo(px, py); on = true; } else on = false;
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    path(rf.lap.offset || null, '--front', 2);
    if (lap && lap !== rf.lap) path(lap.offset, '--accent', 2.5);
    if (lap) for (const e of lap.incidents) {
      if (e.refIdx < a || e.refIdx > b) continue;
      const [px, py] = posAt(lap.offset, e.refIdx);
      ctx.strokeStyle = css('--drag'); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(px - 7, py - 7); ctx.lineTo(px + 7, py + 7); ctx.moveTo(px + 7, py - 7); ctx.lineTo(px - 7, py + 7); ctx.stroke();
      ctx.fillStyle = css('--drag'); ctx.textAlign = 'left'; ctx.font = `600 11px ${css('--font-data')}`;
      ctx.fillText(e.name, px + 10, py + 4);
    }
    ctx.font = `600 11px ${css('--font-data')}`;
    ctx.fillStyle = css('--ink');
    ctx.textAlign = 'center';
    for (const [i, label] of [[c.turnIn, '턴인'], [c.apex, '꼭짓점'], [Math.min(R.n - 1, c.exit), '탈출']]) {
      const [px, py] = P(R.x[i], R.z[i]);
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillText(label, px, py - 9);
    }
    ctx.strokeStyle = css('--ink-2'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(12, h - 14); ctx.lineTo(12 + 10 * scv, h - 14); ctx.stroke();
    ctx.fillStyle = css('--ink-2'); ctx.textAlign = 'left';
    ctx.fillText(`10 m · 라인 사이 가로 거리는 ${EX}배 확대 · 휠: 확대 · 끌기: 이동 · 두 번 클릭: 원래대로`, 16 + 10 * scv, h - 10);
    const L = lap.line[zoomCorner], B = rf.lap.line[zoomCorner];
    $('#co-zoom-info').textContent = lap === rf.lap ? '기준 랩입니다.'
      : `기준 대비 (안쪽 +) 턴인 ${sign(L.turnIn - B.turnIn, 1)} m · 꼭짓점 ${sign(L.apex - B.apex, 1)} m · 탈출 ${sign(L.exit - B.exit, 1)} m`;
  }

  // ---------- 컨트롤 ----------
  $('#co-live-btn').addEventListener('click', () => connect());
  // 게임 자동 연결 (기본 켜짐): 브리지가 게임 데이터를 보내기 시작하면 이 탭으로 넘어와 바로 연결한다
  try {
    $('#co-auto').checked = localStorage.getItem('aerolab-autolive') !== '0';
    $('#co-port').value = (location.protocol.startsWith('http') && location.port) || localStorage.getItem('aerolab-port') || $('#co-port').value;
  } catch { /* 무시 */ }
  $('#co-auto').addEventListener('change', (e) => { autoBlocked = false; try { localStorage.setItem('aerolab-autolive', e.target.checked ? '1' : '0'); } catch { /* 무시 */ } });
  $('#co-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; });
  $('#co-reffile').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) loadRefFile(f); e.target.value = ''; });
  $('#co-mini-btn').addEventListener('click', openMini);
  $('#co-play').addEventListener('click', toggleReplay);
  $('#co-target').addEventListener('change', (e) => { refKey = e.target.value === defaultReference(A)?.key ? '' : e.target.value; if (A) A._layout = null; stopReplay(); render(); });
  $('#co-goal').addEventListener('change', (e) => {
    const t = parseTime(e.target.value);
    store.set(`aerolab.goal.${trackName()}|${A?.myCls || ''}`, t);
    render();
  });
  $('#co-zoom-corner').addEventListener('change', (e) => { zoomCorner = +e.target.value; zoomView = null; drawZoom(); });
  $('#co-inc-t').addEventListener('input', (e) => setIncT(+e.target.value));
  $('#co-inc-play').addEventListener('click', toggleIncPlay);
  // 코너 라인 확대: 휠로 확대·축소, 끌어서 이동, 두 번 눌러 원래대로
  zoom.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = zoom.getBoundingClientRect();
    const k = e.deltaY < 0 ? 1.25 : 0.8;
    zoomView = zoomView || { k: 1, dx: 0, dy: 0 };
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    zoomView.dx = mx - (mx - zoomView.dx) * k; zoomView.dy = my - (my - zoomView.dy) * k;
    zoomView.k = Math.max(1, Math.min(12, zoomView.k * k));
    if (zoomView.k === 1) zoomView = null;
    drawZoom();
  }, { passive: false });
  let drag = null;
  zoom.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; zoom.setPointerCapture(e.pointerId); });
  zoom.addEventListener('pointermove', (e) => {
    if (!drag) return;
    zoomView = zoomView || { k: 1, dx: 0, dy: 0 };
    zoomView.dx += e.clientX - drag.x; zoomView.dy += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    drawZoom();
  });
  zoom.addEventListener('pointerup', () => { drag = null; });
  zoom.addEventListener('dblclick', () => { zoomView = null; drawZoom(); });
  new ResizeObserver(() => { if (A) drawZoom(); }).observe(zoom.parentElement);
  new ResizeObserver(() => { setupMap(); drawMap(); }).observe(map.parentElement);

  return {
    setVisible(v) { visible = v; if (v) { setupMap(); drawMap(); } },
    themeChanged() { if (visible) render(); },
    connect,
    isLive: () => !!es,
    autoBlocked: () => autoBlocked,
    _debug: () => ({ A, samples }),
  };
}
