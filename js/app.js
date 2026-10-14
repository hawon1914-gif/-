import * as P from './physics.js';
import { CARS, PARAM_GROUPS, cloneCar, getParam, setParam } from './cars.js';
import { LineChart } from './chart.js';
import { drawCarView } from './carview.js';

const $ = (id) => document.getElementById(id);
const kgf = (n) => n / P.G;

const state = {
  carId: 'f1_2022',
  car: cloneCar('f1_2022'),
  env: { tempC: 20, pressureHpa: 1013.25, rho: P.airDensity(20, 1013.25) },
  platform: true,
  tab: 'sweep',
  braking: null,
  replayIdx: 0,
  playing: false,
};

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 저장 불가 환경 무시 */ }
}

// ---------- 사이드바: 차량 파라미터 ----------

function buildCarSelect() {
  const sel = $('car-select');
  sel.innerHTML = Object.entries(CARS).map(([id, c]) => `<option value="${id}">${c.name}</option>`).join('');
  sel.value = state.carId;
  sel.addEventListener('change', () => {
    state.carId = sel.value;
    state.car = cloneCar(sel.value);
    buildParams();
    update();
  });
  $('reset-car').addEventListener('click', () => {
    state.car = cloneCar(state.carId);
    buildParams();
    update();
  });
}

function round(v, step) {
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(v.toFixed(Math.min(6, d + 1)));
}

function buildParams() {
  const root = $('params');
  const open = new Set([...root.querySelectorAll('details[open]')].map((d) => d.dataset.group));
  if (!root.children.length) open.add('에어로');
  root.innerHTML = '';
  for (const g of PARAM_GROUPS) {
    const det = document.createElement('details');
    det.dataset.group = g.title;
    det.open = open.has(g.title);
    det.innerHTML = `<summary>${g.title}</summary>`;
    const grid = document.createElement('div');
    grid.className = 'param-grid';
    for (const p of g.params) {
      const scale = p.scale ?? 1;
      const id = 'p-' + p.key.replace('.', '-');
      const val = round(getParam(state.car, p.key) * scale, p.step);
      const preset = round(getParam(CARS[state.carId], p.key) * scale, p.step);
      const row = document.createElement('label');
      row.className = 'param' + (val !== preset ? ' changed' : '');
      row.htmlFor = id;
      row.innerHTML = `<span class="pl">${p.label}</span><span class="pv"><input id="${id}" type="number" step="${p.step}" value="${val}"><span class="unit">${p.unit}</span></span>`;
      row.querySelector('input').addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isFinite(v)) return;
        setParam(state.car, p.key, v / scale);
        row.classList.toggle('changed', round(v, p.step) !== preset);
        scheduleUpdate();
      });
      grid.appendChild(row);
    }
    det.appendChild(grid);
    root.appendChild(det);
  }
}

function bindEnv() {
  const upd = () => {
    state.env.tempC = parseFloat($('env-temp').value) || 0;
    state.env.pressureHpa = parseFloat($('env-press').value) || 1013.25;
    state.env.rho = P.airDensity(state.env.tempC, state.env.pressureHpa);
    $('env-rho').textContent = state.env.rho.toFixed(3);
    scheduleUpdate();
  };
  $('env-temp').addEventListener('input', upd);
  $('env-press').addEventListener('input', upd);
  $('platform').addEventListener('change', (e) => {
    state.platform = e.target.checked;
    update();
  });
  upd();
}

// ---------- 탭 ----------

function bindTabs() {
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const select = (name) => {
    state.tab = name;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', on);
      $('tab-' + t.dataset.tab).hidden = !on;
    }
    storageSet('aerolab-tab', name);
    update();
  };
  for (const t of tabs) t.addEventListener('click', () => select(t.dataset.tab));
  const fromHash = location.hash.slice(1);
  const saved = storageGet('aerolab-tab');
  select(tabs.some((t) => t.dataset.tab === fromHash) ? fromHash : tabs.some((t) => t.dataset.tab === saved) ? saved : 'sweep');
}

// ---------- 공통 출력 ----------

function kpis(el, items) {
  el.innerHTML = items
    .map(([label, value, note = '', tone = '']) => `<div class="kpi ${tone}"><span class="kl">${label}</span><span class="kv">${value}</span><span class="kn">${note}</span></div>`)
    .join('');
}

const axleName = (a) => (a === 'front' ? '프론트' : '리어');
const charts = {};
function chart(id, opts) {
  if (!charts[id]) charts[id] = new LineChart($(id), opts);
  return charts[id];
}

// ---------- 속도 스윕 ----------

function runSweep() {
  const { car, env, platform } = state;
  const vmax = P.topSpeed(car, env, { platform });
  const speeds = [];
  for (let k = 60; k <= Math.min(380, P.toKmh(vmax) + 10); k += 5) speeds.push(k);
  const rows = speeds.map((k) => {
    const v = P.toMs(k);
    const s = P.aeroState(car, env, { v, platform });
    return {
      k, s,
      brake: P.maxBraking(car, env, v, { platform, ideal: false }).a / P.G,
      lat: P.maxLateral(car, env, v, { platform }).ay / P.G,
      power: ((s.drag + s.rolling) * v) / car.driveEff / 1000,
    };
  });
  const s250 = P.aeroState(car, env, { v: P.toMs(250), platform });
  const lat250 = P.maxLateral(car, env, P.toMs(250), { platform });
  const anyStall = rows.find((r) => r.s.stalledFront || r.s.stalledRear || r.s.unstable);
  kpis($('sweep-kpis'), [
    ['최고속도', `${P.toKmh(vmax).toFixed(0)}<small>km/h</small>`, `출력 ${(car.power / 1000).toFixed(0)}kW 기준`],
    ['다운포스 @250', `${kgf(s250.df).toFixed(0)}<small>kgf</small>`, `차중의 ${(s250.df / (car.mass * P.G) * 100).toFixed(0)}%`],
    ['항력 @250', `${kgf(s250.drag).toFixed(0)}<small>kgf</small>`, `L/D ${(s250.df / s250.drag).toFixed(2)}`],
    ['에어로 밸런스 @250', `${(s250.balance * 100).toFixed(1)}<small>% F</small>`, `정적 하중 ${(car.weightFront * 100).toFixed(1)}% F`],
    ['횡G @250', `${(lat250.ay / P.G).toFixed(2)}<small>G</small>`, `${axleName(lat250.limiting)} 먼저 한계 → ${lat250.limiting === 'front' ? '언더' : '오버'}스티어 성향`],
    anyStall
      ? ['플랫폼 경고', `${anyStall.k}<small>km/h</small>`, anyStall.s.unstable ? '평형 없음: 포포이징 위험' : '이 속도부터 바닥/스플리터 실속', 'warn']
      : ['플랫폼', '정상', '정속 주행 중 실속 없음', 'ok'],
  ]);

  const x = rows.map((r) => r.k);
  chart('c-sweep-force', { xLabel: 'km/h', yLabel: 'kgf' }).set([
    { name: '다운포스 합계', color: '--ink', x, y: rows.map((r) => kgf(r.s.df)) },
    { name: '프론트', color: '--front', x, y: rows.map((r) => kgf(r.s.dfF)) },
    { name: '리어', color: '--rear', x, y: rows.map((r) => kgf(r.s.dfR)) },
    { name: '항력', color: '--drag', x, y: rows.map((r) => kgf(r.s.drag)), dash: [6, 4] },
  ]);
  chart('c-sweep-g', { xLabel: 'km/h', yLabel: 'G' }).set([
    { name: '최대 감속', color: '--front', x, y: rows.map((r) => r.brake) },
    { name: '최대 횡G', color: '--rear', x, y: rows.map((r) => r.lat) },
  ]);
  chart('c-sweep-ride', { xLabel: 'km/h', yLabel: 'mm' }).set([
    { name: '라이드하이트 F', color: '--front', x, y: rows.map((r) => r.s.hF) },
    { name: '라이드하이트 R', color: '--rear', x, y: rows.map((r) => r.s.hR) },
    { name: '실속 F', color: '--front', x, y: rows.map(() => car.stallFront), dash: [2, 4], width: 1 },
    { name: '실속 R', color: '--rear', x, y: rows.map(() => car.stallRear), dash: [2, 4], width: 1 },
  ]);
  chart('c-sweep-power', { xLabel: 'km/h', yLabel: 'kW' }).set([
    { name: '필요 출력', color: '--drag', x, y: rows.map((r) => r.power) },
    { name: '엔진 출력', color: '--ink-2', x, y: rows.map(() => car.power / 1000), dash: [6, 4] },
  ]);
}

// ---------- 브레이킹 ----------

function runBraking() {
  const { car, env, platform } = state;
  const v0k = parseFloat($('br-v0').value) || 300;
  const v1k = parseFloat($('br-v1').value) || 80;
  const biasIn = parseFloat($('br-bias').value);
  const bias = Number.isFinite(biasIn) ? biasIn / 100 : car.brakeBias;
  $('br-bias').placeholder = (car.brakeBias * 100).toFixed(1);
  const vmax = P.toKmh(P.topSpeed(car, env, { platform }));
  const v0 = P.toMs(Math.min(v0k, vmax));
  const v1 = P.toMs(Math.min(v1k, P.toKmh(v0) - 5));
  const sim = P.simulateBraking(car, env, { v0, v1, bias, platform });
  const rigid = $('br-compare').checked ? P.simulateBraking(car, env, { v0, v1, bias, platform: false }) : null;
  state.braking = sim;

  const cruise = P.aeroState(car, env, { v: v0, platform });
  const start = P.maxBraking(car, env, v0, { bias, platform });
  const end = P.maxBraking(car, env, v1, { bias, platform });
  const dfLoss = 1 - (sim.dfF[0] + sim.dfR[0]) / cruise.df;
  const peakTransfer = Math.max(...sim.transfer);
  const stalledAt = sim.stalled.indexOf(true);
  kpis($('br-kpis'), [
    ['제동거리', `${sim.distance.toFixed(1)}<small>m</small>`, rigid ? `강체 에어로 ${rigid.distance.toFixed(1)}m (${(sim.distance - rigid.distance >= 0 ? '+' : '')}${(sim.distance - rigid.distance).toFixed(1)})` : `${P.toKmh(v0).toFixed(0)}→${P.toKmh(v1).toFixed(0)} km/h`],
    ['제동 시간', `${sim.time.toFixed(2)}<small>s</small>`, `최대 ${(Math.max(...sim.a) / P.G).toFixed(2)}G`],
    ['피치로 변한 DF', `${dfLoss >= 0 ? '−' : '+'}${Math.abs(dfLoss * 100).toFixed(1)}<small>%</small>`, `정속 ${kgf(cruise.df).toFixed(0)} → 제동 ${kgf(sim.dfF[0] + sim.dfR[0]).toFixed(0)} kgf`, Math.abs(dfLoss) > 0.05 ? 'warn' : ''],
    ['밸런스 이동', `${(cruise.balance * 100).toFixed(1)}→${(sim.balance[0] * 100).toFixed(1)}<small>% F</small>`, sim.balance[0] < cruise.balance ? '제동 중 리어로 이동 (진입 언더)' : '제동 중 프론트로 이동 (리어 불안)'],
    ['최대 하중 이동', `${kgf(peakTransfer).toFixed(0)}<small>kgf</small>`, `m·a·h/L, 앞축으로`],
    ['한계 축 · 이상 바이어스', `${axleName(start.limiting)}`, `이상 바이어스 ${(start.idealBias * 100).toFixed(1)}% → 저속 ${(end.idealBias * 100).toFixed(1)}% (현재 ${(bias * 100).toFixed(1)}%)`, Math.abs(start.idealBias - bias) > 0.03 ? 'warn' : 'ok'],
  ]);
  $('br-note').textContent = stalledAt >= 0
    ? `${P.toKmh(sim.v[stalledAt]).toFixed(0)} km/h 지점에서 라이드하이트가 실속 높이 아래로 내려갑니다. 노즈 다이브가 바닥/스플리터 흐름을 끊는 상황입니다.`
    : '제동 구간 전체에서 실속 없음.';

  const x = sim.x;
  const rx = rigid?.x ?? [];
  const both = (name, color, a, b, f = (v) => v) => {
    const out = [{ name, color, x, y: a.map(f) }];
    if (rigid) out.push({ name: name + ' (강체)', color, x: rx, y: b.map(f), dash: [5, 4], width: 1.5 });
    return out;
  };
  chart('c-br-g', { xLabel: 'm', yLabel: 'G' }).set(both('감속', '--ink', sim.a, rigid?.a ?? [], (v) => v / P.G));
  chart('c-br-df', { xLabel: 'm', yLabel: 'kgf' }).set([
    ...both('DF 프론트', '--front', sim.dfF, rigid?.dfF ?? [], kgf),
    ...both('DF 리어', '--rear', sim.dfR, rigid?.dfR ?? [], kgf),
  ]);
  chart('c-br-load', { xLabel: 'm', yLabel: 'kgf' }).set([
    { name: '전축 하중', color: '--front', x, y: sim.fzF.map(kgf) },
    { name: '후축 하중', color: '--rear', x, y: sim.fzR.map(kgf) },
    { name: '하중 이동', color: '--ink-2', x, y: sim.transfer.map(kgf), dash: [5, 4] },
  ]);
  chart('c-br-ride', { xLabel: 'm', yLabel: 'mm' }).set([
    { name: 'F', color: '--front', x, y: sim.hF },
    { name: 'R', color: '--rear', x, y: sim.hR },
    { name: '실속 F', color: '--front', x, y: x.map(() => car.stallFront), dash: [2, 4], width: 1 },
    { name: '실속 R', color: '--rear', x, y: x.map(() => car.stallRear), dash: [2, 4], width: 1 },
  ]);

  const slider = $('br-replay');
  slider.max = sim.t.length - 1;
  state.replayIdx = Math.min(state.replayIdx, sim.t.length - 1);
  slider.value = state.replayIdx;
  drawReplay();
}

function drawReplay() {
  const sim = state.braking;
  if (!sim || !sim.t.length) return;
  const i = state.replayIdx;
  drawCarView($('car-view'), state.car, { hF: sim.hF[i], hR: sim.hR[i], dfF: sim.dfF[i], dfR: sim.dfR[i], fzF: sim.fzF[i], fzR: sim.fzR[i], drag: sim.drag[i] });
  $('replay-readout').textContent = `t ${sim.t[i].toFixed(2)}s · ${P.toKmh(sim.v[i]).toFixed(0)} km/h · ${(sim.a[i] / P.G).toFixed(2)}G · ${sim.x[i].toFixed(1)} m · 밸런스 ${(sim.balance[i] * 100).toFixed(1)}% F`;
  const m = [{ x: sim.x[i], label: '', color: '--accent' }];
  for (const id of ['c-br-g', 'c-br-df', 'c-br-load', 'c-br-ride']) {
    charts[id].markers = m;
    charts[id].draw();
  }
}

function bindBraking() {
  for (const id of ['br-v0', 'br-v1', 'br-bias']) $(id).addEventListener('input', scheduleUpdate);
  $('br-compare').addEventListener('change', update);
  $('br-replay').addEventListener('input', (e) => {
    state.replayIdx = +e.target.value;
    drawReplay();
  });
  const btn = $('br-play');
  btn.addEventListener('click', () => {
    state.playing = !state.playing;
    btn.textContent = state.playing ? '정지' : '재생';
    if (!state.playing) return;
    if (state.replayIdx >= state.braking.t.length - 1) state.replayIdx = 0;
    const t0 = performance.now() - state.braking.t[state.replayIdx] * 1000;
    const tick = (now) => {
      if (!state.playing || !state.braking) return;
      const t = (now - t0) / 1000;
      const sim = state.braking;
      let i = state.replayIdx;
      while (i < sim.t.length - 1 && sim.t[i] < t) i++;
      state.replayIdx = i;
      $('br-replay').value = i;
      drawReplay();
      if (i >= sim.t.length - 1) {
        state.playing = false;
        btn.textContent = '재생';
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ---------- 슬립스트림 ----------

function runSlip() {
  const { car, env, platform } = state;
  const vk = parseFloat($('sl-speed').value) || 200;
  const v = P.toMs(vk);
  const drs = $('sl-drs').checked;
  const gaps = [];
  for (let g = 2; g <= 60; g += 1) gaps.push(g);
  const clean = P.aeroState(car, env, { v, platform });
  const cleanLat = P.maxLateral(car, env, v, { platform });
  const rows = gaps.map((g) => {
    const s = P.aeroState(car, env, { v, gap: g, platform });
    const lat = P.maxLateral(car, env, v, { gap: g, platform });
    return { g, s, lat };
  });
  chart('c-sl-wake', { xLabel: '간격 m', yLabel: '%' }).set([
    { name: '항력 감소', color: '--drag', x: gaps, y: rows.map((r) => (1 - r.s.drag / clean.drag) * 100) },
    { name: 'DF 손실 프론트', color: '--front', x: gaps, y: rows.map((r) => (1 - r.s.dfF / clean.dfF) * 100) },
    { name: 'DF 손실 리어', color: '--rear', x: gaps, y: rows.map((r) => (1 - r.s.dfR / clean.dfR) * 100) },
  ]);
  chart('c-sl-lat', { xLabel: '간격 m', yLabel: 'G' }).set([
    { name: '최대 횡G', color: '--ink', x: gaps, y: rows.map((r) => r.lat.ay / P.G) },
    { name: '단독 주행', color: '--ink-2', x: gaps, y: gaps.map(() => cleanLat.ay / P.G), dash: [5, 4] },
  ]);
  const at = (g) => rows.find((r) => r.g === g);
  $('sl-table').innerHTML = `<thead><tr><th>간격</th><th>항력</th><th>DF</th><th>밸런스</th><th>횡G</th><th>한계</th></tr></thead><tbody>${[
    ['단독', { s: clean, lat: cleanLat }],
    ...[5, 10, 20, 30, 50].map((g) => [`${g} m`, at(g)]),
  ].map(([label, r]) => `<tr><td>${label}</td><td>${kgf(r.s.drag).toFixed(0)} kgf</td><td>${kgf(r.s.df).toFixed(0)} kgf</td><td>${(r.s.balance * 100).toFixed(1)}%</td><td>${(r.lat.ay / P.G).toFixed(2)}</td><td>${axleName(r.lat.limiting)}</td></tr>`).join('')}</tbody>`;

  const length = parseFloat($('sl-len').value) || 1000;
  const v0 = P.toMs(parseFloat($('sl-v0').value) || 120);
  const gap0 = Math.max(P.MIN_GAP, parseFloat($('sl-gap0').value) || 15);
  const st = P.simulateStraight(car, env, { length, v0, gap0, drs });
  const st0 = P.simulateStraight({ ...car, wake: { ...car.wake, dragMax: 0, dfMax: 0 } }, env, { length, v0, gap0 });
  const gained = gap0 - st.finalGap;
  const vTow = P.topSpeed(car, env, { gap: 10, drs, platform });
  const vClean = P.topSpeed(car, env, { platform });
  kpis($('sl-kpis'), [
    ['직선 끝 간격', `${st.finalGap.toFixed(1)}<small>m</small>`, `출발 ${gap0.toFixed(0)}m → ${gained >= 0 ? gained.toFixed(1) + 'm 단축' : (-gained).toFixed(1) + 'm 벌어짐'}`, st.finalGap < 0 ? 'ok' : ''],
    ['라인 빼는 지점', st.pullOutAt === null ? '도달 못함' : `${st.pullOutAt.toFixed(0)}<small>m</small>`, `간격 2m에서 후류를 벗어난다고 가정`],
    ['직선 끝 속도차', `${(P.toKmh(st.vF.at(-1)) - P.toKmh(st.vL.at(-1))).toFixed(1)}<small>km/h</small>`, `뒤차 ${P.toKmh(st.vF.at(-1)).toFixed(0)} / 앞차 ${P.toKmh(st.vL.at(-1)).toFixed(0)}`],
    ['10m 토우 최고속', `${P.toKmh(vTow).toFixed(0)}<small>km/h</small>`, `단독 ${P.toKmh(vClean).toFixed(0)} km/h (+${(P.toKmh(vTow) - P.toKmh(vClean)).toFixed(1)})${drs ? ', DRS 포함' : ''}`],
  ]);
  chart('c-sl-gap', { xLabel: 'm', yLabel: '간격 m' }).set([
    { name: '슬립스트림', color: '--accent', x: st.xF, y: st.gap },
    { name: '후류 없음', color: '--ink-2', x: st0.xF, y: st0.gap, dash: [5, 4] },
  ], { yMin: Math.min(0, ...st.gap) });
  chart('c-sl-speed', { xLabel: 'm', yLabel: 'km/h' }).set([
    { name: '앞차', color: '--ink-2', x: st.xF, y: st.vL.map(P.toKmh) },
    { name: '뒤차', color: '--accent', x: st.xF, y: st.vF.map(P.toKmh) },
  ], { yMin: Math.floor(P.toKmh(v0) / 50) * 50 });
}

function bindSlip() {
  for (const id of ['sl-speed', 'sl-len', 'sl-v0', 'sl-gap0']) $(id).addEventListener('input', scheduleUpdate);
  $('sl-drs').addEventListener('change', update);
}

// ---------- 차량 비교 ----------

function runCompare() {
  const { env, platform } = state;
  const cars = Object.entries(CARS).map(([id, preset]) => ({ id, car: id === state.carId ? state.car : preset }));
  const colors = ['--c1', '--c2', '--c3', '--c4', '--c5'];
  const dfSeries = [];
  const dragSeries = [];
  const rows = cars.map(({ id, car }, i) => {
    const vmax = P.topSpeed(car, env, { platform });
    const x = [];
    for (let k = 60; k <= P.toKmh(vmax); k += 5) x.push(k);
    const st = x.map((k) => P.aeroState(car, env, { v: P.toMs(k), platform }));
    dfSeries.push({ name: car.name, color: colors[i], x, y: st.map((s) => kgf(s.df)) });
    dragSeries.push({ name: car.name, color: colors[i], x, y: st.map((s) => kgf(s.drag)) });
    const vb = Math.min(250, P.toKmh(vmax) - 5);
    const br = P.simulateBraking(car, env, { v0: P.toMs(vb), v1: P.toMs(100), platform });
    const s250 = P.aeroState(car, env, { v: P.toMs(250), platform });
    return {
      name: car.name + (id === state.carId ? ' *' : ''),
      color: colors[i],
      vmax: P.toKmh(vmax),
      df: kgf(s250.df),
      ld: s250.df / s250.drag,
      brake: `${br.distance.toFixed(0)} m${vb < 250 ? ` (${vb.toFixed(0)}→100)` : ''}`,
      lat100: P.maxLateral(car, env, P.toMs(100), { platform }).ay / P.G,
      lat200: P.maxLateral(car, env, P.toMs(200), { platform }).ay / P.G,
    };
  });
  chart('c-cmp-df', { xLabel: 'km/h', yLabel: '다운포스 kgf' }).set(dfSeries);
  chart('c-cmp-drag', { xLabel: 'km/h', yLabel: '항력 kgf' }).set(dragSeries);
  $('cmp-table').innerHTML = `<thead><tr><th>차량</th><th>최고속</th><th>DF @250</th><th>L/D</th><th>제동 250→100</th><th>횡G 100</th><th>횡G 200</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td><span class="swatch" style="background:var(${r.color})"></span>${r.name}</td><td>${r.vmax.toFixed(0)} km/h</td><td>${r.df.toFixed(0)} kgf</td><td>${r.ld.toFixed(2)}</td><td>${r.brake}</td><td>${r.lat100.toFixed(2)}</td><td>${r.lat200.toFixed(2)}</td></tr>`)
    .join('')}</tbody>`;
}

// ---------- 갱신 ----------

let timer = null;
function scheduleUpdate() {
  clearTimeout(timer);
  timer = setTimeout(update, 120);
}

function update() {
  $('car-name').textContent = state.car.name;
  if (state.tab === 'sweep') runSweep();
  else if (state.tab === 'braking') runBraking();
  else if (state.tab === 'slip') runSlip();
  else if (state.tab === 'compare') runCompare();
}

buildCarSelect();
buildParams();
bindEnv();
bindBraking();
bindSlip();
bindTabs();
const redraw = () => {
  Object.values(charts).forEach((c) => c.draw());
  drawReplay();
};
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
window.addEventListener('resize', () => drawReplay());
