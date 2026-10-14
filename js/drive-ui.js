// 주행 탭: 트랙 지도, 계기판, 텔레메트리, 입력(키보드·화면 버튼·게임패드)
import * as P from './physics.js';
import { engineFor } from './drivetrain.js';
import { buildTrack, TRACKS } from './track.js';
import { createDriveSim } from './drive.js';
import { LineChart } from './chart.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
const fmtTime = (t) => {
  if (t === null || t === undefined || !Number.isFinite(t)) return '–:––.–––';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};

export function createDrive({ root, getCar, getCarId, getEnv }) {
  const $ = (sel) => root.querySelector(sel);
  const map = $('#dv-map');
  const chart = new LineChart($('#dv-chart'), { xLabel: 'm', yLabel: 'km/h', height: 220 });
  let sim = null;
  let track = null;
  let trackId = 'technical';
  let visible = false;
  let last = performance.now();
  let chartTimer = 0;
  // 랩 내 위치별 경과 시간 (실시간 델타용)
  let lapTimes = null;
  let bestTimes = null;

  const opts = { autoGear: false, ai: false, guide: true };

  // ---------- 입력 ----------
  const keys = new Set();
  const pedal = { throttle: 0, brake: 0 };
  const touch = { throttle: false, brake: false };
  let shiftUp = false;
  let shiftDown = false;
  let padPrev = { up: false, down: false };

  const isTyping = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  window.addEventListener('keydown', (e) => {
    if (!visible || isTyping()) return;
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', ' ', 'w', 's', 'e', 'q', 'r', 'a', 'd'].includes(k)) e.preventDefault();
    if (e.repeat) return;
    keys.add(k);
    if (k === 'e' || k === 'd') shiftUp = true;
    if (k === 'q' || k === 'a') shiftDown = true;
    if (k === 'r') restart();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  const hold = (btn, key) => {
    const on = (e) => { e.preventDefault(); touch[key] = true; btn.classList.add('on'); };
    const off = () => { touch[key] = false; btn.classList.remove('on'); };
    btn.addEventListener('pointerdown', on);
    btn.addEventListener('pointerup', off);
    btn.addEventListener('pointerleave', off);
    btn.addEventListener('pointercancel', off);
  };
  hold($('#dv-gas'), 'throttle');
  hold($('#dv-brk'), 'brake');
  $('#dv-up').addEventListener('click', () => { shiftUp = true; });
  $('#dv-down').addEventListener('click', () => { shiftDown = true; });

  // 게임패드 표준 배치: RT 가속, LT 브레이크, RB 업, LB 다운
  function readPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || gp.mapping !== 'standard') continue;
      const up = gp.buttons[5]?.pressed;
      const down = gp.buttons[4]?.pressed;
      if (up && !padPrev.up) shiftUp = true;
      if (down && !padPrev.down) shiftDown = true;
      padPrev = { up, down };
      return { throttle: gp.buttons[7]?.value ?? 0, brake: gp.buttons[6]?.value ?? 0, name: gp.id };
    }
    return null;
  }

  // 키보드는 켜고 끄기뿐이라 페달처럼 서서히 밟히고 떼어지게 한다
  function readInput(dt) {
    const pad = readPad();
    const wantT = keys.has('arrowup') || keys.has('w') || touch.throttle ? 1 : 0;
    const wantB = keys.has('arrowdown') || keys.has('s') || keys.has(' ') || touch.brake ? 1 : 0;
    pedal.throttle += Math.max(-dt * 10, Math.min(dt * 6, wantT - pedal.throttle));
    pedal.brake += Math.max(-dt * 12, Math.min(dt * 9, wantB - pedal.brake));
    const input = {
      throttle: Math.max(pedal.throttle, pad?.throttle ?? 0),
      brake: Math.max(pedal.brake, pad?.brake ?? 0),
      shiftUp, shiftDown, autoGear: opts.autoGear, ai: opts.ai,
    };
    shiftUp = shiftDown = false;
    $('#dv-pad').textContent = pad ? `게임패드 연결됨: ${pad.name.slice(0, 40)}` : '';
    return input;
  }

  // ---------- 시뮬레이션 준비 ----------
  function rebuild() {
    track = buildTrack(trackId);
    const car = getCar();
    const eng = engineFor(getCarId());
    sim = createDriveSim(car, getEnv(), eng, track);
    lapTimes = new Float32Array(track.length).fill(NaN);
    bestTimes = null;
    $('#dv-engine').textContent = `${eng.label} · ${eng.gears.length}단 · 레드존 ${eng.redline.toLocaleString()} rpm${eng.turbo ? ' · 터보' : ''}`;
    $('#dv-ideal').textContent = fmtTime(sim.ideal.time);
    $('#dv-boost-row').hidden = !eng.turbo;
    $('#dv-laps').innerHTML = '';
    drawMapBase();
    updateChart();
  }

  function restart() {
    if (!sim) return;
    sim.reset();
    lapTimes.fill(NaN);
    bestTimes = null;
    $('#dv-laps').innerHTML = '';
    updateChart();
  }

  // ---------- 지도 ----------
  const base = document.createElement('canvas');
  let mapXf = null;
  function drawMapBase() {
    // 캔버스의 실제 표시 폭 (figure 안쪽 여백 제외)
    const w = map.clientWidth || map.parentElement.clientWidth - 20;
    const h = Math.round(Math.min(360, Math.max(240, w * 0.62)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [map, base]) { c.width = w * dpr; c.height = h * dpr; }
    map.style.height = h + 'px';
    const { x, y, length: N } = track;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i <= N; i++) { minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]); minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]); }
    const pad = 24;
    const sc = Math.min((w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxY - minY));
    const ox = (w - (maxX - minX) * sc) / 2;
    const oy = (h - (maxY - minY) * sc) / 2;
    mapXf = (i) => [ox + (x[i] - minX) * sc, h - (oy + (y[i] - minY) * sc)];
    const ctx = base.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = css('--line');
    ctx.lineWidth = 9;
    ctx.beginPath();
    for (let i = 0; i <= N; i += 2) { const [px, py] = mapXf(i); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath();
    ctx.stroke();
    // 브레이크 가이드: 이상 프로파일에서 감속하는 구간
    if (opts.guide) {
      ctx.strokeStyle = css('--drag');
      ctx.lineWidth = 4;
      const v = sim.ideal.v;
      for (let i = 0; i < N; i++) {
        if (v[(i + 1) % N] < v[i] - 0.05) {
          const [ax, ay] = mapXf(i);
          const [bx, by] = mapXf(i + 1);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        }
      }
    }
    // 출발선
    const [sx, sy] = mapXf(0);
    ctx.fillStyle = css('--ink');
    ctx.fillRect(sx - 2, sy - 9, 4, 18);
  }

  function drawMap() {
    if (!mapXf) return;
    const ctx = map.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, map.width, map.height);
    ctx.drawImage(base, 0, 0);
    const dpr = map.width / map.clientWidth;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [px, py] = mapXf(Math.floor(sim.state.s) % track.length);
    ctx.fillStyle = css('--accent');
    ctx.strokeStyle = css('--panel');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  // ---------- 계기판 ----------
  const leds = $('#dv-leds');
  leds.innerHTML = Array.from({ length: 12 }, () => '<i></i>').join('');
  const ledEls = [...leds.children];
  function updateDash() {
    const S = sim.state;
    const eng = sim.eng;
    $('#dv-speed').textContent = P.toKmh(S.v).toFixed(0);
    $('#dv-gear').textContent = S.shiftT > 0 ? '–' : S.v < 0.5 && S.throttle < 0.05 ? 'N' : String(S.gear);
    $('#dv-rpm').textContent = Math.round(S.rpm).toLocaleString();
    const frac = (S.rpm - eng.idle) / (eng.redline - eng.idle);
    $('#dv-rpm-bar').style.width = `${Math.min(100, Math.max(0, frac * 100))}%`;
    // 시프트 라이트: 레드존 82%부터 켜지기 시작해 97%에서 전부 깜박
    const lit = Math.round(Math.min(1, Math.max(0, (S.rpm / eng.redline - 0.82) / 0.15)) * ledEls.length);
    const blink = S.rpm > eng.redline * 0.97 && Math.floor(performance.now() / 80) % 2 === 0;
    ledEls.forEach((el, i) => { el.className = blink ? '' : i < lit ? (i < 4 ? 'g' : i < 8 ? 'y' : 'r') : ''; });
    $('#dv-boost-bar').style.width = `${(S.boost * 100).toFixed(0)}%`;
    $('#dv-thr').style.height = `${(S.throttle * 100).toFixed(0)}%`;
    $('#dv-brk-bar').style.height = `${(S.brake * 100).toFixed(0)}%`;
    const lapT = S.started ? S.t - S.lapStart : 0;
    $('#dv-lap').textContent = fmtTime(lapT);
    $('#dv-best').textContent = fmtTime(S.bestLap);
    const lastLap = S.laps[S.laps.length - 1];
    $('#dv-last').textContent = lastLap ? `${fmtTime(lastLap.time)}${lastLap.valid ? '' : ' (무효)'}` : fmtTime(null);
    // 실시간 델타: 같은 지점에서 베스트 랩보다 몇 초 빠르거나 느린가
    const idx = Math.floor(S.s) % track.length;
    if (S.started) lapTimes[idx] = lapT;
    const dEl = $('#dv-delta');
    if (bestTimes && Number.isFinite(bestTimes[idx]) && S.started) {
      const d = lapT - bestTimes[idx];
      dEl.textContent = `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}`;
      dEl.className = d >= 0 ? 'slow' : 'fast';
    } else {
      dEl.textContent = '±0.00';
      dEl.className = '';
    }
    $('#dv-valid').hidden = S.lapValid;
    const F = S.flags;
    const flags = [
      [F.offtrack > 0, '트랙 이탈: 코너 한계 초과', 'bad'],
      [F.lock > 0, '브레이크 잠김', 'bad'],
      [F.wheelspin > 0, '휠스핀', 'warn'],
      [F.limiter > 0, '리미터', 'warn'],
      [F.shiftBlocked > 0, '저단 변속 거부 (회전수 초과)', 'warn'],
    ].filter((f) => f[0]);
    $('#dv-flags').innerHTML = flags.map(([, t, c]) => `<span class="flag ${c}">${t}</span>`).join('');
  }

  function onLap() {
    const S = sim.state;
    const lap = S.laps[S.laps.length - 1];
    if (lap.valid && S.bestLap === lap.time) bestTimes = lapTimes.slice();
    lapTimes = new Float32Array(track.length).fill(NaN);
    const rows = S.laps.map((l, i) => `<li><span>랩 ${i + 1}</span><b class="${l.valid ? '' : 'invalid'}">${fmtTime(l.time)}</b><span>${l.valid ? (l.time === S.bestLap ? '베스트' : `+${(l.time - S.bestLap).toFixed(3)}`) : '무효'}</span></li>`).reverse();
    $('#dv-laps').innerHTML = rows.slice(0, 8).join('');
    updateChart();
  }

  function updateChart() {
    if (!sim) return;
    const N = track.length;
    const step = 4;
    const xs = [];
    for (let i = 0; i < N; i += step) xs.push(i);
    const toK = (arr) => xs.map((i) => (arr[i] > 0 ? P.toKmh(arr[i]) : NaN));
    const series = [{ name: '이상 랩', color: '--ink-2', x: xs, y: toK(sim.ideal.v), dash: [5, 4], width: 1.5 }];
    if (sim.state.bestTrace) series.push({ name: '베스트', color: '--front', x: xs, y: toK(sim.state.bestTrace) });
    series.push({ name: '현재 랩', color: '--accent', x: xs, y: toK(sim.state.trace) });
    chart.markers = [{ x: sim.state.s, label: '', color: '--accent' }];
    chart.set(series, { markers: chart.markers, yMin: 0 });
  }

  // ---------- 루프 ----------
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!visible || !sim) return;
    const lapsBefore = sim.state.laps.length;
    sim.advance(dt, readInput(dt));
    if (sim.state.laps.length > lapsBefore) onLap();
    updateDash();
    drawMap();
    chartTimer += dt;
    if (chartTimer > 0.4) { chartTimer = 0; updateChart(); }
  }

  // ---------- 컨트롤 ----------
  const sel = $('#dv-track');
  sel.innerHTML = Object.entries(TRACKS).map(([id, t]) => `<option value="${id}">${t.name}</option>`).join('');
  sel.value = trackId;
  sel.addEventListener('change', () => { trackId = sel.value; rebuild(); });
  for (const r of root.querySelectorAll('input[name=dv-gearbox]')) r.addEventListener('change', (e) => { opts.autoGear = e.target.value === 'auto'; });
  for (const r of root.querySelectorAll('input[name=dv-driver]')) r.addEventListener('change', (e) => { opts.ai = e.target.value === 'ai'; });
  $('#dv-guide').addEventListener('change', (e) => { opts.guide = e.target.checked; drawMapBase(); });
  $('#dv-restart').addEventListener('click', restart);
  new ResizeObserver(() => { if (sim) drawMapBase(); }).observe(map.parentElement);

  rebuild();
  requestAnimationFrame(frame);

  return {
    setVisible(v) {
      visible = v;
      if (v) { last = performance.now(); drawMapBase(); }
      else keys.clear();
    },
    carChanged() { rebuild(); },
    themeChanged() { drawMapBase(); updateChart(); },
  };
}
