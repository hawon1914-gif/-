// 시간 영역 주행 시뮬레이션. 조향은 트랙 라인을 자동으로 따라가고, 가속·브레이크·변속은 운전자가 한다.
// - 종방향: 엔진·기어·터보 → 구동력, 브레이크, 공기저항·구름저항
// - 접지 한계: 마찰원(코너링에 쓴 그립만큼 가속·제동 그립이 줄어든다), 휠스핀, 브레이크 잠김
// - 코너 속도가 횡그립 한계를 넘으면 트랙 이탈(감속 + 랩 무효)
import * as P from './physics.js';
import { engineTorque, torqueScale, boostTarget, stepBoost, rpmAt, engineRpm, totalRatio, bestDrive } from './drivetrain.js';

const DT = 1 / 240;
const TABLE_STEP = 1; // m/s

export function createDriveSim(car, env, eng, track) {
  const scale = torqueScale(eng, car.power);
  const vTop = P.topSpeed(car, env);
  const vMaxTable = vTop + 30;

  // 속도별 한계값 표: 순수 횡가속, 순수 제동력(타이어가 내는 힘), 구동축 접지력
  const nT = Math.ceil(vMaxTable / TABLE_STEP) + 2;
  const latT = new Float32Array(nT);
  const brkT = new Float32Array(nT);
  for (let i = 0; i < nT; i++) {
    const v = Math.max(0.5, i * TABLE_STEP);
    latT[i] = P.maxLateral(car, env, v).ay;
    const b = P.maxBraking(car, env, v, { ideal: false });
    brkT[i] = Math.max(0, car.mass * b.a - b.state.drag - b.state.rolling);
  }
  const lookup = (T, v) => {
    const f = Math.min(nT - 1.001, Math.max(0, v / TABLE_STEP));
    const i = Math.floor(f);
    return T[i] + (T[i + 1] - T[i]) * (f - i);
  };
  const latAt = (v) => lookup(latT, v);
  const brkAt = (v) => lookup(brkT, v);

  // 구동축 접지력: 가속에 따른 하중 이동을 반영
  function tractionGrip(v, ax) {
    const s = P.aeroState(car, env, { v, ax });
    if (eng.driven === 'all') return P.axleGrip(car, s.fzF) + P.axleGrip(car, s.fzR);
    return P.axleGrip(car, s.fzR);
  }

  // 마찰원: 횡가속으로 쓴 비율만큼 종방향 여유가 줄어든다
  const ellipse = (v, k) => {
    const use = (v * v * Math.abs(k)) / latAt(v);
    return Math.sqrt(Math.max(0, 1 - use * use));
  };

  // 각 지점의 코너 한계 속도: v²κ = 횡가속 한계(v)
  const N = track.length;
  const vLim = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const k = Math.abs(track.kappa[i]);
    if (k < 1e-6) { vLim[i] = vMaxTable; continue; }
    let v = 30;
    for (let it = 0; it < 20; it++) v = Math.min(vMaxTable, Math.sqrt(latAt(v) / k));
    vLim[i] = v;
  }

  // 이상적인 속도 프로파일 (전진: 최대 가속, 후진: 최대 제동, 둘 중 작은 값). 2바퀴 돌려 주기 조건을 맞춘다.
  function idealProfile() {
    const vf = new Float32Array(N);
    let v = 20;
    for (let lap = 0; lap < 2; lap++) {
      for (let i = 0; i < N; i++) {
        v = Math.min(v, vLim[i]);
        vf[i] = v;
        const k = track.kappa[i];
        const e = ellipse(v, k);
        const s = P.aeroState(car, env, { v });
        const drive = Math.min(bestDrive(eng, scale, v, car.driveEff).force, tractionGrip(v, 3) * e);
        const a = (drive - s.drag - s.rolling) / car.mass;
        v = Math.sqrt(Math.max(0, v * v + 2 * a));
      }
    }
    const vb = new Float32Array(N);
    v = vf[0];
    for (let lap = 0; lap < 2; lap++) {
      for (let i = N - 1; i >= 0; i--) {
        v = Math.min(v, vf[i]);
        vb[i] = v;
        const k = track.kappa[i];
        const e = ellipse(v, k);
        const s = P.aeroState(car, env, { v });
        const a = (brkAt(v) * e + s.drag + s.rolling) / car.mass;
        v = Math.sqrt(v * v + 2 * a);
      }
    }
    let time = 0;
    for (let i = 0; i < N; i++) time += 1 / Math.max(0.5, (vb[i] + vb[(i + 1) % N]) / 2);
    return { v: vb, time };
  }
  const ideal = idealProfile();

  const state = {};
  function reset() {
    Object.assign(state, {
      s: 0, v: 0, gear: 1, rpm: eng.idle, boost: 0, throttle: 0, brake: 0, ax: 0, ay: 0,
      shiftT: 0, nextGear: 0, t: 0, lapStart: 0, lapValid: true, laps: [],
      bestLap: null, bestTrace: null, trace: new Float32Array(N), started: false,
      flags: { wheelspin: 0, lock: 0, limiter: 0, offtrack: 0, shiftBlocked: 0 },
      force: { drive: 0, brake: 0, drag: 0 },
    });
  }
  reset();

  function shift(dir) {
    if (state.shiftT > 0) return;
    const g = state.gear + dir;
    if (g < 1 || g > eng.gears.length) return;
    // 저단 변속 시 회전수가 레드존을 넘으면 거부 (엔진 보호)
    if (dir < 0 && rpmAt(eng, g, state.v) > eng.redline * 1.02) {
      state.flags.shiftBlocked = 0.8;
      return;
    }
    state.nextGear = g;
    state.shiftT = eng.shiftTime;
  }

  // 자동 변속: 레드라인 직전에 올리고, 다음 저단으로 내려도 안전하면 회전수가 떨어졌을 때 내린다
  function autoShift() {
    if (state.shiftT > 0) return;
    if (state.rpm > eng.redline * 0.97 && state.gear < eng.gears.length && state.throttle > 0.2) shift(1);
    else if (state.gear > 1 && rpmAt(eng, state.gear - 1, state.v) < eng.redline * 0.9 && state.rpm < eng.redline * 0.6) shift(-1);
  }

  // AI: 이상 프로파일을 앞질러 보며 따라간다
  function aiInput() {
    const i = Math.floor(state.s) % N;
    const look = Math.floor(state.s + Math.max(5, state.v * 0.25)) % N;
    const target = Math.min(ideal.v[i], ideal.v[look] + 0.5) * 0.995;
    const err = target - state.v;
    return { throttle: err > 0 ? Math.min(1, err * 0.8 + 0.2) : 0, brake: err < -0.2 ? Math.min(1, -err * 1.5) : 0 };
  }

  function step(input) {
    const S = state;
    const ai = input.ai ? aiInput() : null;
    S.throttle = ai ? ai.throttle : input.throttle;
    S.brake = ai ? ai.brake : input.brake;
    if (input.shiftUp) shift(1);
    if (input.shiftDown) shift(-1);
    if (input.autoGear || input.ai) autoShift();
    if (!S.started && (S.throttle > 0.05 || S.v > 0.1)) { S.started = true; S.lapStart = S.t; }

    const i = Math.floor(S.s) % N;
    const k = track.kappa[i];
    const v = S.v;
    S.ay = v * v * k;
    const e = ellipse(v, k);
    const st = P.aeroState(car, env, { v, ax: S.ax });

    // 변속 중에는 동력이 끊긴다
    if (S.shiftT > 0) {
      S.shiftT -= DT;
      if (S.shiftT <= 0) { S.gear = S.nextGear; S.shiftT = 0; }
    }
    S.rpm = engineRpm(eng, S.gear, v, S.throttle);
    S.boost = stepBoost(eng, S.boost, boostTarget(eng, S.rpm, S.throttle), DT);
    let torque = engineTorque(eng, scale, S.rpm, S.throttle, S.boost);
    S.flags.limiter = 0;
    if (S.rpm >= eng.redline) { torque = Math.min(torque, 0); S.flags.limiter = 0.15; }
    if (S.shiftT > 0) torque = 0;
    // 정지 상태에서 엔진 브레이크로 뒤로 가지 않게
    if (v < 1 && torque < 0) torque = 0;
    let drive = (torque * totalRatio(eng, S.gear) * car.driveEff) / eng.tireRadius;

    const grip = tractionGrip(v, S.ax) * e;
    if (drive > grip) { drive = grip * 0.9; S.flags.wheelspin = 0.25; }

    const brkMax = brkAt(v);
    let brake = S.brake * brkMax;
    if (brake > brkMax * e + 1) { brake = brkMax * e * 0.8; S.flags.lock = 0.25; }

    const resist = v > 0.05 ? st.drag + st.rolling : 0;
    let ax = (drive - brake - resist) / car.mass;
    if (v <= 0 && ax < 0) ax = 0;
    S.ax = ax;
    S.force = { drive, brake, drag: st.drag };
    S.v = Math.max(0, v + ax * DT);

    // 횡그립 한계 초과 → 트랙 이탈
    if (S.v > vLim[i] * 1.03) {
      S.v = vLim[i] * 0.85;
      S.lapValid = false;
      S.flags.offtrack = 1.2;
    }

    S.s += S.v * DT;
    S.t += DT;
    const idx = Math.floor(S.s) % N;
    if (S.started) S.trace[idx] = S.v;
    for (const f in S.flags) S.flags[f] = Math.max(0, S.flags[f] - DT);

    // 랩 완료
    if (S.s >= N) {
      S.s -= N;
      const time = S.t - S.lapStart;
      S.laps.push({ time, valid: S.lapValid });
      if (S.lapValid && (!S.bestLap || time < S.bestLap)) {
        S.bestLap = time;
        S.bestTrace = S.trace.slice();
      }
      S.lapStart = S.t;
      S.lapValid = true;
      S.trace = new Float32Array(N);
    }
  }

  // 실시간 진행: 경과 시간만큼 고정 간격 스텝. 변속 입력은 다음 스텝까지 보관해서 놓치지 않는다.
  let acc = 0;
  let pendingUp = false;
  let pendingDown = false;
  function advance(dtReal, input) {
    acc += Math.min(0.1, dtReal);
    pendingUp ||= !!input.shiftUp;
    pendingDown ||= !!input.shiftDown;
    while (acc >= DT) {
      step({ ...input, shiftUp: pendingUp, shiftDown: pendingDown });
      pendingUp = pendingDown = false;
      acc -= DT;
    }
  }

  return { state, ideal, vLim, eng, track, reset, advance, step, DT, scale };
}
