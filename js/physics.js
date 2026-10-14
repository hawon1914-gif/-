// 준정적(quasi-static) 차량 공기역학 + 하중 이동 모델.
// 단위: SI (m, kg, N, s, W). 라이드하이트·휠레이트만 mm, N/mm.
// CFD가 아니라 심레이싱 물리엔진과 같은 계수/에어로맵 방식이다.

export const G = 9.80665;
export const MIN_GAP = 1; // m, 앞차와의 최소 간격(범퍼 간)

export const toMs = (kmh) => kmh / 3.6;
export const toKmh = (ms) => ms * 3.6;

export function airDensity(tempC = 20, pressureHpa = 1013.25) {
  return (pressureHpa * 100) / (287.05 * (tempC + 273.15));
}

// 지면효과 계수: 라이드하이트가 낮을수록 다운포스가 늘다가,
// 실속 높이 아래로 내려가면 바닥/스플리터 흐름이 박리되며 급감한다.
export function groundEffectFactor(h, h0, sens, stall, stallRate) {
  if (h >= stall) return Math.max(0.25, 1 + sens * (h0 - h));
  const peak = 1 + sens * (h0 - stall);
  return Math.max(0.25, peak * (1 - stallRate * (stall - h)));
}

// 앞차 후류: 간격(m)에 따른 항력 감소율과 다운포스 손실률 (지수 감쇠 근사)
export function wakeEffect(car, gap) {
  if (!Number.isFinite(gap)) return { dragRed: 0, dfLoss: 0, dfLossFront: 0, dfLossRear: 0 };
  const g = Math.max(gap, MIN_GAP);
  const w = car.wake;
  const dragRed = w.dragMax * Math.exp(-g / w.dragLen);
  const dfLoss = w.dfMax * Math.exp(-g / w.dfLen);
  // 프론트 윙이 더 크게 잃는다 → 밸런스가 뒤로 이동(언더스티어).
  // 기준 밸런스에서 총 손실률이 dfLoss가 되도록 앞/뒤를 배분.
  const bal = car.aeroBalance;
  const dfLossFront = Math.min(0.95, dfLoss * w.frontBias);
  const dfLossRear = Math.max(0, Math.min(0.95, (dfLoss - bal * dfLossFront) / (1 - bal)));
  return { dragRed, dfLoss, dfLossFront, dfLossRear };
}

// 주어진 속도·종가속도에서 에어로 하중, 서스펜션 압축, 축하중을 고정점 반복으로 푼다.
// ax < 0 이면 감속(브레이킹). platform=false 이면 라이드하이트 민감도를 끈다(강체 에어로).
export function aeroState(car, env, { v, ax = 0, gap = Infinity, drs = false, platform = true }) {
  const q = 0.5 * env.rho * v * v;
  const wake = wakeEffect(car, gap);
  const W = car.mass * G;
  const staticF = W * car.weightFront;
  const staticR = W - staticF;
  const transfer = (-car.mass * ax * car.cgHeight) / car.wheelbase; // 감속 시 + (앞으로)
  const drsDrag = drs ? car.drs.drag : 0;
  const drsDf = drs ? car.drs.rearDf : 0;

  let hF = car.rideFront;
  let hR = car.rideRear;
  let gF = 1;
  let gR = 1;
  let dfF = 0;
  let dfR = 0;
  let residual = 0;
  for (let i = 0; i < 60; i++) {
    gF = platform ? groundEffectFactor(hF, car.rideFront, car.sensFront, car.stallFront, car.stallRate) : 1;
    gR = platform ? groundEffectFactor(hR, car.rideRear, car.sensRear, car.stallRear, car.stallRate) : 1;
    dfF = q * car.ClA * car.aeroBalance * gF * (1 - wake.dfLossFront);
    dfR = q * car.ClA * (1 - car.aeroBalance) * gR * (1 - wake.dfLossRear) * (1 - drsDf);
    // 안티다이브/안티리프트: 하중 이동분 중 일부는 링크가 받아 피치(노즈 다이브)로 가지 않는다
    const nhF = Math.max(0, car.rideFront - (dfF + transfer * (1 - car.antiDive)) / car.rateFront);
    const nhR = Math.max(0, car.rideRear - (dfR - transfer * (1 - car.antiLift)) / car.rateRear);
    residual = Math.abs(nhF - hF) + Math.abs(nhR - hR);
    // 감쇠 반복: 실속 경계에서 해가 튀는 것을 막는다
    hF = 0.5 * hF + 0.5 * nhF;
    hR = 0.5 * hR + 0.5 * nhR;
  }

  const df = dfF + dfR;
  // 항력의 일부(유도항력)는 다운포스에 비례 → 실속으로 DF를 잃으면 항력도 줄어든다.
  // 후류·DRS에 의한 변화는 dragRed·drsDrag에 이미 들어 있으므로 여기선 플랫폼 효과만 반영.
  const dfRatio = car.ClA > 0 ? car.aeroBalance * gF + (1 - car.aeroBalance) * gR : 1;
  const cdaEff = car.CdA * (1 - car.inducedShare + car.inducedShare * dfRatio);
  const drag = q * cdaEff * (1 - wake.dragRed) * (1 - drsDrag);
  const rolling = car.crr * (W + df);
  const fzF = Math.max(0, staticF + dfF + transfer);
  const fzR = Math.max(0, staticR + dfR - transfer);

  return {
    v, q, drag, rolling, dfF, dfR, df,
    balance: df > 0 ? dfF / df : car.aeroBalance,
    hF, hR, gF, gR, fzF, fzR, transfer, wake,
    stalledFront: platform && hF < car.stallFront,
    stalledRear: platform && hR < car.stallRear,
    bottomed: hF <= 0.01 || hR <= 0.01,
    // 반복이 수렴하지 않으면 정적 평형이 없다 → 실제로는 바운싱(포포이징) 가능성
    unstable: residual > 0.5,
  };
}

// 타이어 하중 민감도: 하중이 늘수록 마찰계수는 감소 (μ·Fz는 증가하지만 비례보다 덜)
export function tireMu(car, fzWheel) {
  if (fzWheel <= 0) return 0;
  return car.mu0 * Math.pow(fzWheel / car.fzRef, -car.loadSens);
}

export function wheelGrip(car, fzWheel) {
  return tireMu(car, fzWheel) * Math.max(0, fzWheel);
}

export function axleGrip(car, fzAxle) {
  return 2 * wheelGrip(car, fzAxle / 2);
}

function bisect(lo, hi, ok, iters = 50) {
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (lo + hi);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// 해당 속도에서의 최대 감속 [m/s²]. 브레이크 바이어스로 앞/뒤 제동력이 고정 비율로 나뉜다.
export function maxBraking(car, env, v, { bias = car.brakeBias, gap = Infinity, drs = false, platform = true, ideal = true } = {}) {
  const check = (a, b) => {
    const s = aeroState(car, env, { v, ax: -a, gap, drs, platform });
    const fb = car.mass * a - s.drag - s.rolling; // 타이어가 내야 하는 제동력
    const gripF = axleGrip(car, s.fzF);
    const gripR = axleGrip(car, s.fzR);
    const needF = b === null ? 0 : b * fb;
    const needR = b === null ? 0 : (1 - b) * fb;
    const ok = b === null ? fb <= gripF + gripR : needF <= gripF && needR <= gripR;
    return { ok, s, gripF, gripR, needF, needR, fb };
  };
  const a = bisect(0, 10 * G, (x) => check(x, bias).ok);
  const r = check(a, bias);
  const useF = r.gripF > 0 ? r.needF / r.gripF : 1;
  const useR = r.gripR > 0 ? r.needR / r.gripR : 1;
  // 이상적 바이어스: 앞뒤가 동시에 한계에 닿는 비율
  const result = { a, state: r.s, limiting: useF >= useR ? 'front' : 'rear', idealBias: null, aIdeal: null };
  if (ideal) {
    result.aIdeal = bisect(0, 10 * G, (x) => check(x, null).ok);
    const ri = check(result.aIdeal, null);
    result.idealBias = ri.gripF / (ri.gripF + ri.gripR);
  }
  return result;
}

// 정상 선회 최대 횡가속도 [m/s²]. 횡하중 이동은 축별로 정적 하중 비율만큼 분담한다고 가정.
export function maxLateral(car, env, v, { gap = Infinity, drs = false, platform = true } = {}) {
  const s = aeroState(car, env, { v, ax: 0, gap, drs, platform });
  const axle = (fz, ay, share) => {
    const llt = (car.mass * ay * car.cgHeight * share) / car.track;
    const inner = Math.max(0, fz / 2 - llt);
    const outer = fz / 2 + llt;
    return wheelGrip(car, inner) + wheelGrip(car, outer);
  };
  const ok = (ay) =>
    axle(s.fzF, ay, car.weightFront) >= car.mass * ay * car.weightFront &&
    axle(s.fzR, ay, 1 - car.weightFront) >= car.mass * ay * (1 - car.weightFront);
  const ay = bisect(0, 10 * G, ok);
  const marginF = axle(s.fzF, ay, car.weightFront) / (car.mass * ay * car.weightFront);
  const marginR = axle(s.fzR, ay, 1 - car.weightFront) / (car.mass * ay * (1 - car.weightFront));
  // 앞축이 먼저 한계 → 언더스티어 성향, 뒤축이 먼저 → 오버스티어 성향
  return { ay, state: s, limiting: marginF <= marginR ? 'front' : 'rear' };
}

// 구동력: 출력 한계와 구동축 접지 한계 중 작은 값 (후륜구동 가정)
export function driveForce(car, v, fzRear) {
  const powerLimited = (car.power * car.driveEff) / Math.max(v, 3);
  return Math.min(powerLimited, axleGrip(car, fzRear));
}

export function topSpeed(car, env, { gap = Infinity, drs = false, platform = true } = {}) {
  const surplus = (v) => {
    const s = aeroState(car, env, { v, gap, drs, platform });
    return car.power * car.driveEff - (s.drag + s.rolling) * v;
  };
  return bisect(1, 200, (v) => surplus(v) > 0);
}

// 시간 적분 브레이킹: v0 → v1, 매 순간 접지 한계까지 제동(effort=1)
export function simulateBraking(car, env, { v0, v1, bias = car.brakeBias, platform = true, gap = Infinity, effort = 1, dt = 0.002 }) {
  const rec = { t: [], x: [], v: [], a: [], dfF: [], dfR: [], fzF: [], fzR: [], hF: [], hR: [], balance: [], drag: [], limiting: [], transfer: [], stalled: [] };
  let t = 0;
  let x = 0;
  let v = v0;
  let step = 0;
  while (v > v1 && t < 30) {
    const b = maxBraking(car, env, v, { bias, gap, platform, ideal: false });
    const a = b.a * effort;
    if (step % 10 === 0) {
      const s = aeroState(car, env, { v, ax: -a, gap, platform });
      rec.t.push(t); rec.x.push(x); rec.v.push(v); rec.a.push(a);
      rec.dfF.push(s.dfF); rec.dfR.push(s.dfR); rec.fzF.push(s.fzF); rec.fzR.push(s.fzR);
      rec.hF.push(s.hF); rec.hR.push(s.hR); rec.balance.push(s.balance); rec.drag.push(s.drag);
      rec.transfer.push(s.transfer); rec.limiting.push(b.limiting);
      rec.stalled.push(s.stalledFront || s.stalledRear);
    }
    v -= a * dt;
    x += v * dt;
    t += dt;
    step++;
  }
  return { ...rec, distance: x, time: t };
}

// 직선 가속 + 슬립스트림: 같은 차 두 대, 뒤차는 gap0 m 뒤에서 같은 속도로 출발.
// 간격이 passGap 이하가 되면 뒤차가 라인을 빼서 후류를 벗어난다고 본다.
export function simulateStraight(car, env, { length, v0, gap0, drs = false, passGap = 2, dt = 0.005 }) {
  const rec = { t: [], xL: [], xF: [], vL: [], vF: [], gap: [], dragRed: [] };
  let t = 0;
  let xL = gap0 + car.length; // 앞차 노즈 위치
  let xF = 0;
  let vL = v0;
  let vF = v0;
  let axL = 0;
  let axF = 0;
  let pulledOut = false;
  let pullOutAt = null;
  const accel = (v, ax, gap, useDrs) => {
    const s = aeroState(car, env, { v, ax, gap, drs: useDrs });
    return { a: (driveForce(car, v, s.fzR) - s.drag - s.rolling) / car.mass, s };
  };
  let step = 0;
  while (xF < length && t < 120) {
    const gap = xL - xF - car.length;
    if (!pulledOut && gap <= passGap) {
      pulledOut = true;
      pullOutAt = xF;
    }
    const L = accel(vL, axL, Infinity, false);
    const F = accel(vF, axF, pulledOut ? Infinity : gap, drs);
    if (step % 10 === 0) {
      rec.t.push(t); rec.xL.push(xL); rec.xF.push(xF); rec.vL.push(vL); rec.vF.push(vF);
      rec.gap.push(gap); rec.dragRed.push(F.s.wake.dragRed);
    }
    axL = L.a; axF = F.a;
    vL += axL * dt; vF += axF * dt;
    xL += vL * dt; xF += vF * dt;
    t += dt;
    step++;
  }
  return { ...rec, finalGap: xL - xF - car.length, pullOutAt, time: t };
}
