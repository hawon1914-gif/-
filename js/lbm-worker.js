// 2D 격자 볼츠만(LBM D2Q9) 풍동. 차량 기준 좌표계: 공기와 노면이 +x로 u0 속도로 흐른다.
// - BGK 충돌 + 스마고린스키 난류 모델(높은 레이놀즈수에서 안정화)
// - 고체: 이동벽 bounce-back (노면은 u0로 움직이고, 바퀴는 회전한다)
// - 힘: 운동량 교환법으로 물체(id)별 항력·양력·모멘트를 적분

const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
const GROUND = 255;
const MAX_ID = 8;

let NX = 0, NY = 0, N = 0;
let u0 = 0.1, tau0 = 0.515, cs2smag = 0.15 * 0.15;
let f, f2, solid, wux, wuy, ux, uy, rho;
let force = new Float64Array(MAX_ID * 3); // id별 [fx, fy, Σx·fy] 지수 이동 평균
let stepCount = 0;
let running = false;



function equilibrium(i, r, vx, vy) {
  const cu = 3 * (CX[i] * vx + CY[i] * vy);
  return W[i] * r * (1 + cu + 0.5 * cu * cu - 1.5 * (vx * vx + vy * vy));
}

function init(msg) {
  NX = msg.NX; NY = msg.NY; N = NX * NY;
  u0 = msg.u0; tau0 = 0.5 + 3 * msg.nu; cs2smag = msg.cs * msg.cs;
  f = new Float32Array(9 * N);
  f2 = new Float32Array(9 * N);
  solid = new Uint8Array(N);
  wux = new Float32Array(N);
  wuy = new Float32Array(N);
  ux = new Float32Array(N);
  uy = new Float32Array(N);
  rho = new Float32Array(N);
  for (let c = 0; c < N; c++) for (let i = 0; i < 9; i++) f[i * N + c] = equilibrium(i, 1, u0, 0);
  setGround();
  force.fill(0);
  stepCount = 0;
}

function setGround() {
  for (let x = 0; x < NX; x++) {
    solid[x] = GROUND;
    wux[x] = u0; // 차량 기준 좌표계에서 노면은 공기와 같은 속도로 움직인다
    wuy[x] = 0;
  }
}

function setMask(msg) {
  const prev = solid;
  solid = new Uint8Array(msg.solid);
  wux = new Float32Array(msg.wux);
  wuy = new Float32Array(msg.wuy);
  setGround();
  // 새로 유체가 된 칸은 자유류 평형으로 채운다
  for (let c = NX; c < N; c++) {
    if (prev[c] && !solid[c]) for (let i = 0; i < 9; i++) f[i * N + c] = equilibrium(i, 1, u0, 0);
  }
  force.fill(0);
}

function step() {
  const alpha = 0.0007; // 와류 방출로 힘이 출렁여서 약 1400스텝 시상수로 평균
  const acc = new Float64Array(MAX_ID * 3);
  // 전역 let 대신 지역 상수로 받아야 V8이 최적화한다
  const F = f, F2 = f2, S = solid, WX = wux, WY = wuy, UX = ux, UY = uy, R = rho;
  const n = N, nx = NX, t0 = tau0, smag = 18 * Math.SQRT2 * cs2smag;
  const off = new Int32Array(9);
  const fi = new Float64Array(9);
  const feq = new Float64Array(9);
  for (let i = 0; i < 9; i++) off[i] = CX[i] + CY[i] * nx;
  for (let y = 1; y < NY - 1; y++) {
    for (let x = 1; x < nx - 1; x++) {
      const c = y * nx + x;
      if (S[c]) continue;
      for (let i = 0; i < 9; i++) {
        const src = c - off[i];
        const sid = S[src];
        if (sid) {
          // 이동벽 bounce-back: 벽 쪽으로 나간 분포가 벽 속도만큼 보정되어 되돌아온다
          const o = OPP[i];
          const out = F[o * n + c];
          const v = out + 6 * W[i] * (CX[i] * WX[src] + CY[i] * WY[src]);
          fi[i] = v;
          if (sid !== GROUND) {
            const k = (sid & 7) * 3;
            // 벽이 받는 운동량 = (나간 것 + 돌아온 것) × 나간 방향
            const py = (out + v) * CY[o];
            acc[k] += (out + v) * CX[o];
            acc[k + 1] += py;
            acc[k + 2] += x * py;
          }
        } else {
          fi[i] = F[i * n + src];
        }
      }
      const f0 = fi[0], f1 = fi[1], f2v = fi[2], f3 = fi[3], f4 = fi[4], f5 = fi[5], f6 = fi[6], f7 = fi[7], f8 = fi[8];
      const r = f0 + f1 + f2v + f3 + f4 + f5 + f6 + f7 + f8;
      const ir = 1 / r;
      const vx = (f1 - f3 + f5 - f6 - f7 + f8) * ir;
      const vy = (f2v - f4 + f5 + f6 - f7 - f8) * ir;
      const usq = 1.5 * (vx * vx + vy * vy);
      const a = 3 * vx, b = 3 * vy, p = a + b, m = b - a;
      const w0 = r * (4 / 9), w1 = r / 9, w5 = r / 36;
      feq[0] = w0 * (1 - usq);
      feq[1] = w1 * (1 + a + 0.5 * a * a - usq);
      feq[2] = w1 * (1 + b + 0.5 * b * b - usq);
      feq[3] = w1 * (1 - a + 0.5 * a * a - usq);
      feq[4] = w1 * (1 - b + 0.5 * b * b - usq);
      feq[5] = w5 * (1 + p + 0.5 * p * p - usq);
      feq[6] = w5 * (1 + m + 0.5 * m * m - usq);
      feq[7] = w5 * (1 - p + 0.5 * p * p - usq);
      feq[8] = w5 * (1 - m + 0.5 * m * m - usq);
      // 스마고린스키: 비평형 응력 크기로 국소 난류 점성을 더한다
      const d1 = f1 - feq[1], d2 = f2v - feq[2], d3 = f3 - feq[3], d4 = f4 - feq[4];
      const d5 = f5 - feq[5], d6 = f6 - feq[6], d7 = f7 - feq[7], d8 = f8 - feq[8];
      const pxx = d1 + d3 + d5 + d6 + d7 + d8;
      const pyy = d2 + d4 + d5 + d6 + d7 + d8;
      const pxy = d5 - d6 + d7 - d8;
      const q = Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy);
      const om = 2 / (t0 + Math.sqrt(t0 * t0 + smag * q * ir));
      for (let i = 0; i < 9; i++) F2[i * n + c] = fi[i] + om * (feq[i] - fi[i]);
      UX[c] = vx; UY[c] = vy; R[c] = r;
    }
  }
  // 입구(왼쪽)와 상단: 자유류 평형. 출구(오른쪽): 0 기울기
  for (let y = 1; y < NY; y++) {
    const c0 = y * nx;
    for (let i = 0; i < 9; i++) F2[i * n + c0] = equilibrium(i, 1, u0, 0);
    const cl = c0 + nx - 1;
    for (let i = 0; i < 9; i++) F2[i * n + cl] = F2[i * n + cl - 1];
    UX[c0] = u0; UY[c0] = 0; R[c0] = 1;
    UX[cl] = UX[cl - 1]; UY[cl] = UY[cl - 1]; R[cl] = R[cl - 1];
  }
  const top = (NY - 1) * nx;
  for (let x = 0; x < nx; x++) {
    for (let i = 0; i < 9; i++) F2[i * n + top + x] = equilibrium(i, 1, u0, 0);
    UX[top + x] = u0; UY[top + x] = 0; R[top + x] = 1;
  }
  f = F2; f2 = F;
  for (let k = 0; k < force.length; k++) force[k] += alpha * (acc[k] - force[k]);
  stepCount++;
}

// 계산이 발산(NaN)하면 자유류로 다시 시작한다. 화면이 멈추지 않게 하는 안전장치.
let resets = 0;
function checkDiverged() {
  for (let c = NX; c < N; c += 97) {
    if (!solid[c] && !Number.isFinite(rho[c])) {
      for (let k = 0; k < N; k++) {
        for (let i = 0; i < 9; i++) f[i * N + k] = equilibrium(i, 1, u0, 0);
        ux[k] = u0; uy[k] = 0; rho[k] = 1;
      }
      force.fill(0);
      stepCount = 0;
      resets++;
      return;
    }
  }
}

function loop() {
  if (!running) return;
  const t0 = performance.now();
  while (performance.now() - t0 < 30) step();
  checkDiverged();
  setTimeout(loop, 0);
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') init(msg);
  else if (msg.type === 'mask') setMask(msg);
  else if (msg.type === 'run') { if (!running) { running = true; loop(); } }
  else if (msg.type === 'pause') running = false;
  else if (msg.type === 'frame') {
    self.postMessage({
      type: 'frame',
      ux: ux.slice(), uy: uy.slice(), rho: rho.slice(), solid: solid.slice(),
      force: Array.from(force), steps: stepCount, resets,
    });
  }
};
