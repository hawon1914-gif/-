// 데모 세션: 주행 시뮬레이션이 이상 라인을 따라 달리되, 코너마다 일부러 실수를 섞는다.
// 게임 없이 코칭 분석을 시험하고, 분석이 심어 둔 실수를 찾아내는지 검증하는 데 쓴다.
import { createDriveSim } from './drive.js';
import { findCorners } from './coach.js';
import { CARS } from './cars.js';
import { engineFor } from './drivetrain.js';

export const MISTAKES = {
  early: '브레이크 일찍',
  late: '브레이크 늦게',
  weak: '초기 제동 약함',
  abrupt: '브레이크 한 번에 놓기',
  coast: '코스팅',
  lateThrottle: '가속 늦게',
  lift: '가속 중 스로틀 뗌',
  wideApex: '꼭짓점 놓침',
  earlyTurnIn: '일찍 꺾음',
  narrowEntry: '진입 폭 안 씀',
};
const LINE_KINDS = ['wideApex', 'earlyTurnIn', 'narrowEntry'];

// 코너 안쪽(+) 방향 가로 오프셋 (m). 매끈하게 올라갔다 내려가는 혹 모양.
const bump = (i, c0, w) => Math.exp(-(((i - c0) / w) ** 2));
function lineOffset(m, i, c) {
  if (m === 'wideApex') return -2.2 * bump(i, c.apex + 10, 35);
  if (m === 'earlyTurnIn') return 1.4 * bump(i, c.entry, 20) + 0.6 * bump(i, c.apex, 15) - 2.6 * bump(i, c.apex + 55, 30);
  if (m === 'narrowEntry') return 2.0 * bump(i, c.entry - 10, 22);
  return 0;
}

// 트랙 위 s(m), 가로 오프셋(왼쪽 +)으로 평면 좌표를 만든다. z는 화면 좌표라 y를 뒤집는다.
function place(track, s, left) {
  const N = track.length;
  const i = Math.floor(s) % N, j = (i + 1) % N;
  const f = s - Math.floor(s);
  const x = track.x[i] + (track.x[j] - track.x[i]) * f, y = track.y[i] + (track.y[j] - track.y[i]) * f;
  const tx = track.x[j] - track.x[i], ty = track.y[j] - track.y[i];
  const tl = Math.hypot(tx, ty) || 1;
  return { x: x - (ty / tl) * left, z: -(y + (tx / tl) * left) };
}

// 이상 프로파일을 pace 비율로 따라가는 운전자 (상대 차·나의 기본 주행 공통)
function follow(sim, pace) {
  const S = sim.state, N = sim.track.length, iv = sim.ideal.v;
  const i = Math.floor(S.s) % N;
  const look = Math.floor(S.s + Math.max(5, S.v * 0.25)) % N;
  const target = Math.min(iv[i], iv[look] + 0.5) * 0.995 * pace;
  const err = target - S.v;
  const dead = Math.max(0.25, S.v * 0.01);
  return { thr: err > 0 ? Math.min(1, err * 0.8 + 0.2) : 0, brk: err < -dead ? Math.min(1, (-err - dead) * 1.5 + 0.3) : 0 };
}

// 상대 차 (멀티클래스 온라인 세션 흉내): 출발 시각과 페이스를 다르게 해 추월·따라잡기가 생기게 한다
const OPPONENTS = [
  { id: 11, n: 'K. Tanaka', carId: 'hypercar', c: 'Hypercar', delay: 9, pace: 0.985, line: 0.8 },
  { id: 12, n: 'M. Rossi', carId: 'gt3', c: 'GT3', delay: -5, pace: 0.955, line: -0.6 },
  { id: 13, n: 'L. Weber', carId: 'gt3', c: 'GT3', delay: -40, pace: 1.0, line: 0.3 },
];

// 결정적 난수 (같은 시드면 같은 세션)
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function makeDemoSession(car, env, eng, track, { laps = 6, seed = 7, mistakeRate = 0.35, lineRate = 0.2, opponents = true } = {}) {
  const sim = createDriveSim(car, env, eng, track);
  const N = track.length;
  const iv = sim.ideal.v;
  // 이상 프로파일에서 코너 위치를 찾는다
  const R = { n: N, v: iv, brk: new Float32Array(N), thr: new Float32Array(N).fill(1) };
  for (let i = 0; i < N; i++) {
    const dv = iv[(i + 1) % N] - iv[i];
    if (dv < -0.02) { R.brk[i] = 1; R.thr[i] = 0; }
  }
  const corners = findCorners(R);
  const rand = rng(seed);
  const plan = []; // plan[lap][corner] = 실수 종류
  const kinds = Object.keys(MISTAKES);
  for (let l = 0; l <= laps + 1; l++) plan.push(corners.map(() => (l >= 2 && rand() < mistakeRate ? kinds[Math.floor(rand() * kinds.length)] : null)));
  // 라인 실수는 페달 실수와 따로 정한다
  const linePlan = [];
  for (let l = 0; l <= laps + 1; l++) linePlan.push(corners.map(() => (l >= 2 && rand() < lineRate ? LINE_KINDS[Math.floor(rand() * LINE_KINDS.length)] : null)));
  // 코너 회전 방향: 곡률 부호 (왼쪽 +). 안쪽 오프셋 = 부호 × 왼쪽 오프셋
  const turn = corners.map((c) => Math.sign(track.kappa[c.apex]) || 1);
  const EDGE = 6; // 트랙 반폭 (m)

  // 상대 차 시뮬레이션
  const opp = (opponents ? OPPONENTS : []).filter((o) => CARS[o.carId]).map((o) => {
    const sim = createDriveSim(CARS[o.carId], env, engineFor(o.carId), track);
    return { ...o, sim, started: false };
  });
  const stepOpp = (o) => {
    const { thr, brk } = follow(o.sim, o.pace);
    o.sim.step({ throttle: thr, brake: brk, autoGear: true });
  };
  // 먼저 출발한 차는 미리 달려 둔다 (내 출발 기준 음수 지연)
  for (const o of opp) if (o.delay < 0) { for (let t = 0; t < -o.delay; t += sim.DT) stepOpp(o); o.started = true; }

  // 앞 코너의 탈출 구간과 다음 코너의 진입 구간이 겹칠 수 있어, 해당하는 코너를 모두 고른다
  const cornersAt = (i) => corners.map((c, ci) => (i >= c.entry - 60 && i <= Math.max(c.exit + 20, c.apex + 80) ? ci : -1)).filter((ci) => ci >= 0);
  const samples = [];
  let abruptOff = false;
  const S = sim.state;
  const steps = Math.ceil((laps + 2) * sim.ideal.time * 1.3 / sim.DT);
  for (let k = 0; k < steps && S.laps.length < laps + 2; k++) {
    const i = Math.floor(S.s) % N;
    const active = cornersAt(i).map((ci) => ({ c: corners[ci], m: plan[S.laps.length]?.[ci] })).filter((x) => x.m);
    const inCorner = cornersAt(i).length > 0;
    // 기본: 이상 프로파일을 앞질러 보며 따라가기 (AI와 같은 방식)
    const look = Math.floor(S.s + Math.max(5, S.v * 0.25)) % N;
    // 라인 실수는 그만큼 코너 속도를 잃게 한다 (바깥으로 밀린 꼭짓점·좁은 진입은 반경이 작아지고, 일찍 꺾으면 탈출에서 기다려야 한다)
    let linePace = 1;
    corners.forEach((c, ci) => {
      const m = linePlan[S.laps.length]?.[ci];
      if (m === 'wideApex') linePace -= 0.05 * bump(i, c.apex, 40);
      if (m === 'narrowEntry') linePace -= 0.05 * bump(i, c.entry + 20, 40);
      if (m === 'earlyTurnIn') linePace -= 0.06 * bump(i, c.apex + 40, 40);
    });
    const target = Math.min(iv[i], iv[look] + 0.5) * 0.995 * linePace;
    const err = target - S.v;
    // 사람처럼: 조금 빠른 정도는 스로틀만 떼고, 확실히 빠를 때만 브레이크를 밟는다
    let thr = err > 0 ? Math.min(1, err * 0.8 + 0.2) : 0;
    const dead = Math.max(0.25, S.v * 0.01); // 속도의 1% (코너 한계 여유 3%보다 작게)
    let brk = err < -dead ? Math.min(1, (-err - dead) * 1.5 + 0.3) : 0;
    // 실수는 사람처럼 정해진 구간에서 페달을 강제로 바꾼다 (AI가 스스로 보정하지 못하게)
    for (const { c, m } of active) {
      const e = c.entry, a = c.apex;
      // 이미 충분히 느리면(헤어핀 안 등) 일찍 밟을 이유가 없으므로 적용하지 않는다
      // 일찍 밟는 사람은 보통 약하게 일찍 밟고 그대로 끌고 들어간다
      if (m === 'early' && i >= e - 35 && i < e && S.v > 15) { brk = Math.max(brk, 0.3); thr = 0; }
      if (m === 'late' && i >= e && i < e + 8) { brk = 0; thr = 0; }
      if (m === 'weak' && i >= e && i <= a) brk = Math.min(brk, 0.55);
      if (m === 'abrupt' && i >= e && i <= a) {
        if (brk < 0.5) abruptOff = true;
        brk = abruptOff ? 0 : Math.max(brk, 0.95);
      }
      if (m === 'coast' && i >= a - 30 && i <= a + 30) { brk = 0; thr = 0; }
      if (m === 'lateThrottle' && i >= a && i <= a + 45) thr = 0;
      if (m === 'lift' && i >= a + 40 && i <= a + 60) thr = Math.min(thr, 0.15);
    }
    if (!inCorner) abruptOff = false;
    sim.step({ throttle: thr, brake: brk, autoGear: true });
    for (const o of opp) {
      if (!o.started && S.t >= o.delay) o.started = true;
      if (o.started) stepOpp(o);
    }
    // 60 Hz로 기록 (게임 텔레메트리와 비슷하게)
    if (k % 4 === 0) {
      const j = Math.floor(S.s) % N;
      const kap = track.kappa[j];
      const wobble = active.some((x) => x.m === 'late') ? Math.sin(S.t * 18) * 0.08 : 0;
      // 라인: 코너마다 계획된 라인 실수만큼 안쪽/바깥쪽으로 비킨다
      let left = 0;
      corners.forEach((c, ci) => {
        const m = linePlan[S.laps.length]?.[ci];
        if (m && j >= c.entry - 80 && j <= c.exit + 80) left += turn[ci] * lineOffset(m, j, c);
      });
      const p = place(track, S.s, left);
      const smp = {
        t: S.t, lap: S.laps.length, x: p.x, z: p.z, v: S.v,
        thr: S.throttle, brk: S.brake, steer: Math.max(-1, Math.min(1, -kap * 14 + wobble)),
        gear: S.gear, rpm: S.rpm, off: S.flags.offtrack > 0,
        lat: left, edge: EDGE,
      };
      // 다른 차는 3샘플마다 (브리지와 같은 20 Hz)
      if (opp.length && samples.length % 3 === 0) {
        smp.cars = opp.filter((o) => o.started).map((o) => {
          const q = place(track, o.sim.state.s, o.line);
          return { id: o.id, n: o.n, c: o.c, x: q.x, z: q.z, v: o.sim.state.v, lap: o.sim.state.laps.length, pit: false };
        });
      }
      samples.push(smp);
    }
  }
  return { samples, plan, linePlan, corners, name: `데모 · ${track.name}` };
}
