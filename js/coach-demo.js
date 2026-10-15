// 데모 세션: 주행 시뮬레이션이 이상 라인을 따라 달리되, 코너마다 일부러 실수를 섞는다.
// 게임 없이 코칭 분석을 시험하고, 분석이 심어 둔 실수를 찾아내는지 검증하는 데 쓴다.
import { createDriveSim } from './drive.js';
import { findCorners } from './coach.js';

export const MISTAKES = {
  early: '브레이크 일찍',
  late: '브레이크 늦게',
  weak: '초기 제동 약함',
  abrupt: '브레이크 한 번에 놓기',
  coast: '코스팅',
  lateThrottle: '가속 늦게',
  lift: '가속 중 스로틀 뗌',
};

// 결정적 난수 (같은 시드면 같은 세션)
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function makeDemoSession(car, env, eng, track, { laps = 6, seed = 7, mistakeRate = 0.35 } = {}) {
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
    const target = Math.min(iv[i], iv[look] + 0.5) * 0.995;
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
    // 60 Hz로 기록 (게임 텔레메트리와 비슷하게)
    if (k % 4 === 0) {
      const j = Math.floor(S.s) % N;
      const kap = track.kappa[j];
      const wobble = active.some((x) => x.m === 'late') ? Math.sin(S.t * 18) * 0.08 : 0;
      samples.push({
        t: S.t, lap: S.laps.length, x: track.x[j], z: -track.y[j], v: S.v,
        thr: S.throttle, brk: S.brake, steer: Math.max(-1, Math.min(1, -kap * 14 + wobble)),
        gear: S.gear, rpm: S.rpm, off: S.flags.offtrack > 0,
      });
    }
  }
  return { samples, plan, corners, name: `데모 · ${track.name}` };
}
