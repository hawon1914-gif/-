// 구동계: 엔진 토크 곡선, 터보, 기어. 값은 공개 자료 기반 추정치.
// 토크 곡선은 상대값으로 두고, 최대 출력이 차량의 power(크랭크 출력)와 같아지도록 스케일한다.
// 그래서 셋업 시트에서 출력을 바꾸면 토크 곡선 전체가 같이 커지고 작아진다.

export const ENGINES = {
  f1_2022: {
    label: '1.6 V6 터보 하이브리드', cylinders: 6, idle: 4000, redline: 12500,
    curve: [[4000, 0.55], [7000, 0.82], [9000, 0.95], [10500, 1], [11500, 0.97], [12500, 0.88]],
    // MGU-H가 터빈을 돌려 터보랙이 거의 없다
    turbo: { naFrac: 0.45, rpmStart: 4000, rpmFull: 7500, spoolUp: 0.12, spoolDown: 0.25 },
    gears: [4.2, 3.4, 2.8, 2.4, 2.1, 1.9, 1.75, 1.6], final: 3.0, tireRadius: 0.36, shiftTime: 0.03,
    engineBrake: 0.18, driven: 'rear',
  },
  hypercar: {
    label: '트윈터보 V6 + 하이브리드', cylinders: 6, idle: 2000, redline: 8500,
    curve: [[2000, 0.6], [4000, 0.92], [5500, 1], [7000, 0.95], [8500, 0.8]],
    turbo: { naFrac: 0.5, rpmStart: 2500, rpmFull: 4500, spoolUp: 0.45, spoolDown: 0.3 },
    gears: [3.0, 2.2, 1.75, 1.45, 1.24, 1.08, 0.96], final: 3.6, tireRadius: 0.36, shiftTime: 0.04,
    engineBrake: 0.2, driven: 'rear',
  },
  gt3: {
    label: '6.2 V8 자연흡기', cylinders: 8, idle: 1500, redline: 8500,
    curve: [[1500, 0.55], [3000, 0.75], [5000, 0.95], [6000, 1], [7500, 0.92], [8500, 0.8]],
    turbo: null,
    gears: [3.1, 2.25, 1.78, 1.45, 1.22, 1.05], final: 3.4, tireRadius: 0.35, shiftTime: 0.05,
    engineBrake: 0.22, driven: 'rear',
  },
  roadcar: {
    label: '3.8 수평대향 6 트윈터보', cylinders: 6, idle: 900, redline: 7200,
    curve: [[1000, 0.6], [2500, 1], [5000, 1], [6500, 0.88], [7200, 0.78]],
    turbo: { naFrac: 0.45, rpmStart: 1500, rpmFull: 3000, spoolUp: 0.6, spoolDown: 0.35 },
    gears: [5.0, 3.2, 2.1, 1.7, 1.35, 1.08, 0.85, 0.65], final: 3.6, tireRadius: 0.35, shiftTime: 0.12,
    engineBrake: 0.15, driven: 'rear',
  },
  valkyrie: {
    label: '6.5 V12 자연흡기', cylinders: 12, idle: 1000, redline: 11000,
    curve: [[1000, 0.5], [4000, 0.75], [7000, 0.92], [9000, 1], [10500, 0.95], [11000, 0.9]],
    turbo: null,
    gears: [3.3, 2.4, 1.85, 1.5, 1.25, 1.07, 0.93], final: 3.45, tireRadius: 0.35, shiftTime: 0.05,
    engineBrake: 0.2, driven: 'rear',
  },
  chiron: {
    label: '8.0 W16 쿼드터보', cylinders: 16, idle: 900, redline: 6800,
    curve: [[1000, 0.55], [2000, 1], [6000, 1], [6800, 0.85]],
    turbo: { naFrac: 0.35, rpmStart: 1500, rpmFull: 3000, spoolUp: 0.8, spoolDown: 0.4 },
    gears: [3.9, 2.4, 1.67, 1.3, 1.03, 0.83, 0.67], final: 3.2, tireRadius: 0.36, shiftTime: 0.1,
    engineBrake: 0.12, driven: 'all',
  },
};
ENGINES.f1_2021 = { ...ENGINES.f1_2022 };

export function engineFor(carId) {
  return structuredClone(ENGINES[carId] ?? ENGINES.gt3);
}

// 상대 토크 곡선 (선형 보간, 범위 밖은 끝값)
function relTorque(eng, rpm) {
  const c = eng.curve;
  if (rpm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpm <= c[i][0]) {
      const [r0, t0] = c[i - 1];
      const [r1, t1] = c[i];
      return t0 + ((rpm - r0) / (r1 - r0)) * (t1 - t0);
    }
  }
  return c[c.length - 1][1];
}

// 최대 출력이 car.power가 되는 토크 배율 [N·m]
export function torqueScale(eng, power) {
  let best = 0;
  for (let rpm = eng.idle; rpm <= eng.redline; rpm += 50) {
    best = Math.max(best, relTorque(eng, rpm) * ((rpm * 2 * Math.PI) / 60));
  }
  return power / best;
}

// 이 RPM에서 풀 부스트일 때 터보가 낼 수 있는 부스트 비율 (0~1)
export function boostTarget(eng, rpm, throttle) {
  if (!eng.turbo) return 0;
  const { rpmStart, rpmFull } = eng.turbo;
  const k = Math.min(1, Math.max(0, (rpm - rpmStart) / (rpmFull - rpmStart)));
  return throttle * k;
}

// 부스트는 목표값을 따라 지연되어 움직인다 (터보랙). 올라갈 때와 내려갈 때 시상수가 다르다.
export function stepBoost(eng, boost, target, dt) {
  if (!eng.turbo) return 0;
  const tau = target > boost ? eng.turbo.spoolUp : eng.turbo.spoolDown;
  return boost + (target - boost) * Math.min(1, dt / tau);
}

// 엔진 토크 [N·m]. 스로틀 0이면 엔진 브레이크(음수).
export function engineTorque(eng, scale, rpm, throttle, boost) {
  const full = relTorque(eng, rpm) * scale;
  const boostFactor = eng.turbo ? eng.turbo.naFrac + (1 - eng.turbo.naFrac) * boost : 1;
  const drive = full * boostFactor * throttle;
  const brake = -eng.engineBrake * scale * (1 - throttle) * Math.min(1, rpm / eng.redline);
  return drive + brake;
}

export const totalRatio = (eng, gear) => eng.gears[gear - 1] * eng.final;

// 출발할 때 클러치를 미끄러뜨려 엔진을 유지하는 회전수 (토크가 충분히 나오는 구간)
export const launchRpm = (eng) => eng.launchRpm ?? eng.idle + 0.55 * (eng.redline - eng.idle);

// 실제 엔진 회전수: 바퀴 쪽 회전수가 낮으면 클러치가 미끄러지며 스로틀만큼 회전수를 붙잡는다
export function engineRpm(eng, gear, v, throttle) {
  const wheelRpm = rpmAt(eng, gear, v);
  const slipRpm = eng.idle + throttle * (launchRpm(eng) - eng.idle);
  return Math.max(wheelRpm, slipRpm, eng.idle);
}

// 차속 → 엔진 회전수 (클러치 완전 연결 가정)
export function rpmAt(eng, gear, v) {
  return (v / eng.tireRadius) * totalRatio(eng, gear) * (60 / (2 * Math.PI));
}

// 이 속도에서 가장 큰 구동력을 내는 기어와 그 힘 [N] (풀 스로틀·풀 부스트)
export function bestDrive(eng, scale, v, driveEff) {
  let best = { gear: 1, force: 0 };
  for (let g = 1; g <= eng.gears.length; g++) {
    const rpm = rpmAt(eng, g, v);
    if (rpm > eng.redline) continue;
    const r = Math.max(rpm, launchRpm(eng));
    const f = (engineTorque(eng, scale, r, 1, 1) * totalRatio(eng, g) * driveEff) / eng.tireRadius;
    if (f > best.force) best = { gear: g, force: f };
  }
  return best;
}
