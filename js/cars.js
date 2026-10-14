// 차량 프리셋. 실제 팀 데이터는 비공개라 모든 값은 공개 자료·일반적 범위에 기반한 추정치다.
// 값이 정답이 아니라 "실험 출발점"이며, UI에서 직접 바꿔가며 민감도를 보는 용도.

const base = {
  crr: 0.015,
  inducedShare: 0.3,
  stallRate: 0.05,
  antiDive: 0.2,
  antiLift: 0.1,
  drs: { drag: 0, rearDf: 0 },
};

export const CARS = {
  f1_2022: {
    ...base,
    name: 'F1 (2022~ 그라운드 이펙트)',
    type: 'open', shape: 'open', paint: '#c8102e', width: 2.0, height: 0.95, frontOverhang: 1.0,
    mass: 850, wheelbase: 3.6, cgHeight: 0.28, weightFront: 0.45, track: 1.6, length: 5.6,
    power: 750000, driveEff: 0.92,
    CdA: 1.25, ClA: 4.5, aeroBalance: 0.43, inducedShare: 0.35,
    rideFront: 35, rideRear: 60, rateFront: 380, rateRear: 400,
    sensFront: 0.006, sensRear: 0.008, stallFront: 8, stallRear: 15, stallRate: 0.06,
    mu0: 1.8, fzRef: 2000, loadSens: 0.1, brakeBias: 0.56,
    // FIA 발표치 근사: 10m 뒤 약 18%, 20m 뒤 약 4% 다운포스 손실
    wake: { dragMax: 0.22, dragLen: 15, dfMax: 0.82, dfLen: 6.6, frontBias: 1.4 },
    drs: { drag: 0.085, rearDf: 0.25 },
  },
  f1_2021: {
    ...base,
    name: 'F1 (2021 하이레이크)',
    type: 'open', shape: 'open', paint: '#1e41ff', width: 2.0, height: 0.95, frontOverhang: 1.0,
    mass: 840, wheelbase: 3.6, cgHeight: 0.29, weightFront: 0.45, track: 1.6, length: 5.6,
    power: 750000, driveEff: 0.92,
    CdA: 1.3, ClA: 4.6, aeroBalance: 0.44, inducedShare: 0.35,
    rideFront: 30, rideRear: 90, rateFront: 450, rateRear: 300,
    sensFront: 0.005, sensRear: 0.003, stallFront: 6, stallRear: 30, stallRate: 0.04,
    mu0: 1.8, fzRef: 2000, loadSens: 0.1, brakeBias: 0.57,
    // FIA 발표치 근사: 10m 뒤 약 47%, 20m 뒤 약 35% 다운포스 손실
    wake: { dragMax: 0.25, dragLen: 18, dfMax: 0.63, dfLen: 33.9, frontBias: 1.4 },
    drs: { drag: 0.085, rearDf: 0.25 },
  },
  hypercar: {
    ...base,
    name: 'LMH/LMDh 하이퍼카 (르망)',
    type: 'closed', shape: 'proto', paint: '#e8e8e8', width: 2.0, height: 1.06, frontOverhang: 1.0,
    mass: 1100, wheelbase: 3.1, cgHeight: 0.33, weightFront: 0.47, track: 1.6, length: 5.1,
    power: 500000, driveEff: 0.9,
    CdA: 0.95, ClA: 4.0, aeroBalance: 0.42,
    rideFront: 40, rideRear: 60, rateFront: 400, rateRear: 400,
    sensFront: 0.005, sensRear: 0.006, stallFront: 12, stallRear: 25,
    mu0: 1.65, fzRef: 3000, loadSens: 0.11, brakeBias: 0.55,
    wake: { dragMax: 0.25, dragLen: 12, dfMax: 0.5, dfLen: 10, frontBias: 1.3 },
  },
  gt3: {
    ...base,
    name: 'GT3',
    type: 'closed', shape: 'gt', paint: '#f2a900', width: 2.0, height: 1.25, frontOverhang: 1.0,
    mass: 1350, wheelbase: 2.7, cgHeight: 0.42, weightFront: 0.45, track: 1.65, length: 4.6,
    power: 405000, driveEff: 0.88,
    CdA: 1.1, ClA: 2.3, aeroBalance: 0.4, inducedShare: 0.25,
    rideFront: 55, rideRear: 75, rateFront: 360, rateRear: 400,
    sensFront: 0.004, sensRear: 0.003, stallFront: 20, stallRear: 35,
    mu0: 1.55, fzRef: 3500, loadSens: 0.12, brakeBias: 0.62,
    wake: { dragMax: 0.25, dragLen: 12, dfMax: 0.35, dfLen: 12, frontBias: 1.3 },
  },
  roadcar: {
    ...base,
    name: '고성능 로드카',
    type: 'closed', shape: 'road', paint: '#3a7d44', width: 1.9, height: 1.3, frontOverhang: 1.0,
    mass: 1500, wheelbase: 2.45, cgHeight: 0.48, weightFront: 0.4, track: 1.6, length: 4.5,
    power: 375000, driveEff: 0.85,
    CdA: 0.75, ClA: 0.25, aeroBalance: 0.45, inducedShare: 0.1,
    rideFront: 110, rideRear: 115, rateFront: 70, rateRear: 90,
    sensFront: 0.001, sensRear: 0.001, stallFront: 20, stallRear: 20, antiDive: 0.3, antiLift: 0.2,
    mu0: 1.15, fzRef: 4000, loadSens: 0.1, brakeBias: 0.65,
    wake: { dragMax: 0.25, dragLen: 12, dfMax: 0.2, dfLen: 10, frontBias: 1.2 },
  },
  valkyrie: {
    ...base,
    name: 'Valkyrie급 로드 하이퍼카',
    type: 'closed', shape: 'proto', paint: '#0f5c4d', width: 1.92, height: 1.07, frontOverhang: 0.95,
    mass: 1180, wheelbase: 2.73, cgHeight: 0.36, weightFront: 0.43, track: 1.65, length: 4.77,
    power: 850000, driveEff: 0.88,
    CdA: 1.15, ClA: 3.6, aeroBalance: 0.4, inducedShare: 0.35,
    rideFront: 60, rideRear: 75, rateFront: 260, rateRear: 290,
    sensFront: 0.004, sensRear: 0.005, stallFront: 20, stallRear: 30,
    mu0: 1.45, fzRef: 3500, loadSens: 0.11, brakeBias: 0.6,
    wake: { dragMax: 0.25, dragLen: 12, dfMax: 0.45, dfLen: 10, frontBias: 1.3 },
    // 액티브 리어 윙의 DRS 모드
    drs: { drag: 0.1, rearDf: 0.3 },
  },
  chiron: {
    ...base,
    name: 'Chiron급 로드 하이퍼카',
    type: 'closed', shape: 'road', paint: '#14213d', width: 2.04, height: 1.21, frontOverhang: 0.95,
    mass: 2070, wheelbase: 2.71, cgHeight: 0.48, weightFront: 0.43, track: 1.7, length: 4.54,
    power: 1100000, driveEff: 0.85,
    CdA: 0.78, ClA: 0.45, aeroBalance: 0.4, inducedShare: 0.1,
    rideFront: 115, rideRear: 120, rateFront: 120, rateRear: 140,
    sensFront: 0.001, sensRear: 0.001, stallFront: 20, stallRear: 20, antiDive: 0.3, antiLift: 0.2,
    mu0: 1.15, fzRef: 5000, loadSens: 0.1, brakeBias: 0.65,
    wake: { dragMax: 0.25, dragLen: 12, dfMax: 0.2, dfLen: 10, frontBias: 1.2 },
  },
};

export function cloneCar(id) {
  return structuredClone(CARS[id]);
}

// UI 입력 스키마: scale = 화면값 / 내부값
export const PARAM_GROUPS = [
  {
    title: '기본',
    params: [
      { key: 'mass', label: '질량 (운전자·연료 포함)', unit: 'kg', step: 5 },
      { key: 'power', label: '출력', unit: 'kW', scale: 0.001, step: 5 },
      { key: 'driveEff', label: '구동 효율', unit: '%', scale: 100, step: 1 },
      { key: 'wheelbase', label: '휠베이스', unit: 'm', step: 0.01 },
      { key: 'track', label: '트레드', unit: 'm', step: 0.01 },
      { key: 'cgHeight', label: '무게중심 높이', unit: 'm', step: 0.01 },
      { key: 'weightFront', label: '전륜 정적 하중', unit: '%', scale: 100, step: 0.5 },
    ],
  },
  {
    title: '에어로',
    params: [
      { key: 'CdA', label: 'CdA (항력계수×면적)', unit: 'm²', step: 0.01 },
      { key: 'ClA', label: 'ClA (다운포스계수×면적)', unit: 'm²', step: 0.05 },
      { key: 'aeroBalance', label: '에어로 밸런스 (프론트)', unit: '%', scale: 100, step: 0.5 },
      { key: 'inducedShare', label: '유도항력 비중', unit: '%', scale: 100, step: 1 },
    ],
  },
  {
    title: '플랫폼 (라이드하이트 민감도)',
    params: [
      { key: 'rideFront', label: '정지 라이드하이트 F', unit: 'mm', step: 1 },
      { key: 'rideRear', label: '정지 라이드하이트 R', unit: 'mm', step: 1 },
      { key: 'rateFront', label: '휠레이트 F (축 합)', unit: 'N/mm', step: 10 },
      { key: 'rateRear', label: '휠레이트 R (축 합)', unit: 'N/mm', step: 10 },
      { key: 'antiDive', label: '안티다이브 (F)', unit: '%', scale: 100, step: 1 },
      { key: 'antiLift', label: '안티리프트 (R)', unit: '%', scale: 100, step: 1 },
      { key: 'sensFront', label: '민감도 F', unit: '%/mm', scale: 100, step: 0.05 },
      { key: 'sensRear', label: '민감도 R', unit: '%/mm', scale: 100, step: 0.05 },
      { key: 'stallFront', label: '실속 높이 F', unit: 'mm', step: 1 },
      { key: 'stallRear', label: '실속 높이 R', unit: 'mm', step: 1 },
      { key: 'stallRate', label: '실속 강도', unit: '%/mm', scale: 100, step: 0.5 },
    ],
  },
  {
    title: '타이어 · 브레이크',
    params: [
      { key: 'mu0', label: '기준 마찰계수 μ0', unit: '', step: 0.01 },
      { key: 'fzRef', label: 'μ0 기준 하중 (휠당)', unit: 'N', step: 100 },
      { key: 'loadSens', label: '하중 민감도 지수', unit: '', step: 0.01 },
      { key: 'brakeBias', label: '브레이크 바이어스 (F)', unit: '%', scale: 100, step: 0.5 },
      { key: 'crr', label: '구름저항 계수', unit: '', step: 0.001 },
    ],
  },
  {
    title: '슬립스트림 (후류)',
    params: [
      { key: 'wake.dragMax', label: '항력 감소 최대', unit: '%', scale: 100, step: 1 },
      { key: 'wake.dragLen', label: '항력 감소 감쇠거리', unit: 'm', step: 1 },
      { key: 'wake.dfMax', label: 'DF 손실 최대', unit: '%', scale: 100, step: 1 },
      { key: 'wake.dfLen', label: 'DF 손실 감쇠거리', unit: 'm', step: 0.5 },
      { key: 'wake.frontBias', label: '프론트 손실 편중', unit: '×', step: 0.05 },
    ],
  },
  {
    title: 'DRS',
    params: [
      { key: 'drs.drag', label: '항력 감소', unit: '%', scale: 100, step: 0.5 },
      { key: 'drs.rearDf', label: '리어 DF 감소', unit: '%', scale: 100, step: 1 },
    ],
  },
];

export function getParam(car, key) {
  return key.split('.').reduce((o, k) => o[k], car);
}

export function setParam(car, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  parts.reduce((o, k) => o[k], car)[last] = value;
}
