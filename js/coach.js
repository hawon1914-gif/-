import { calibrate, findIncidents, motion } from './incidents.js';
// 주행 코칭 분석: 텔레메트리 샘플 → 랩 분리 → 1 m 간격 재샘플 → 코너 검출 → 코너별 지표 → 코칭 문장.
// 입력 샘플 형식 (브리지·기록 파일·데모 공통):
//   { t: 초, lap: 랩 번호, x, z: 평면 위치(m), v: 속도(m/s), thr, brk: 0~1, steer: -1~1, gear, rpm, off?: 트랙 이탈 여부,
//     lat?, edge?: 트랙 중심선 기준 가로 위치·가장자리까지 거리(m, 게임이 줄 때),
//     cars?: [{ id, n: 이름, c: 클래스, x, z, v, lap, pit }] 다른 차들 (온라인·AI 세션, 몇 샘플마다) }

const KMH = 3.6;

// ---------- 랩 분리 ----------
export function splitLaps(samples) {
  const laps = [];
  let cur = null;
  let prev = null;
  for (const s of samples) {
    // 기록이 끊긴 곳: 시간이 거꾸로 가거나(세션 재시작) 0.5초 넘게 비거나, 차가 순간이동(차고 복귀·리셋)한 경우
    const dt = prev ? s.t - prev.t : 0;
    const jump = prev ? Math.hypot(s.x - prev.x, s.z - prev.z) : 0;
    const broken = prev && (dt <= 0 || dt > 0.5 || jump > 20 + Math.max(s.v, prev.v) * dt * 2);
    if (!cur || s.lap !== cur.lap || broken) {
      if (cur) laps.push(cur);
      cur = { lap: s.lap, samples: [], afterBreak: !!broken };
      if (broken && laps.length) laps[laps.length - 1].brokenEnd = true;
    }
    cur.samples.push(s);
    prev = s;
  }
  if (cur) laps.push(cur);
  // 첫 랩(피트·중간 진입)과 끝나지 않은 마지막 랩은 뺀다.
  // 끊김 직전·직후 조각도 랩 전체가 아니므로 뺀다 (끊긴 랩은 랩 번호가 바뀌기 전에 끝나거나, 중간부터 시작한다).
  const done = laps.slice(1, -1).filter((l) => l.samples.length > 50 && !l.afterBreak && !l.brokenEnd);
  const out = done.map(finishLap);
  // 랩 길이 확인: 게임이 알려준 트랙 길이(없으면 랩들의 중앙값)와 8% 넘게 다르면 랩 전체를 돈 게 아니다
  const trackLen = samples.find((s) => s.trackLen > 100)?.trackLen;
  const refLen = trackLen || median(out.map((l) => l.dist));
  for (const l of out) {
    if (refLen && (l.dist < refLen * 0.92 || l.dist > refLen * 1.08)) l.why.push(`랩 거리 ${l.dist.toFixed(0)} m (트랙 ${refLen.toFixed(0)} m)`);
  }
  // 게임의 랩 인정 여부(mCountLapFlag: 2 = 기록 인정)가 오면 그대로 따른다. 한 랩도 2가 아니면 이 값은 믿지 않는다.
  const flagged = out.filter((l) => Number.isFinite(l.cnt));
  if (flagged.some((l) => l.cnt === 2)) for (const l of flagged) if (l.cnt !== 2) l.why.push('게임이 기록을 인정하지 않음');
  // 많이 느린 랩은 버리지 않는다. 기준 랩(베스트) 후보에서만 빼고, 사고 분석으로 이유를 찾는다.
  const medT = median(out.filter((l) => !l.why.length).map((l) => l.time));
  for (const l of out) l.slow = !!medT && l.time > medT * 1.12;
  for (const l of out) l.valid = !l.why.length;
  return out;
}

const median = (a) => {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[b.length >> 1];
};

function finishLap(raw) {
  const S = raw.samples;
  const time = S[S.length - 1].t - S[0].t;
  let dist = 0;
  for (let i = 1; i < S.length; i++) dist += Math.hypot(S[i].x - S[i - 1].x, S[i].z - S[i - 1].z);
  const why = [];
  const hasOff = S.some((s) => s.off);
  const pit = S.some((s) => s.pit);
  if (pit) why.push('피트');
  if (S.some((s) => s.ctrl !== undefined && s.ctrl !== 0 && s.ctrl !== 3)) why.push('AI가 운전한 구간 있음');
  // 랩 끝 무렵의 게임 랩 인정 값
  const last = [...S].reverse().find((s) => Number.isFinite(s.cnt));
  return { lap: raw.lap, time, dist, why, valid: true, pit, hasOff, cnt: last?.cnt, samples: S };
}

// 위치를 따라 누적 거리를 구하고 1 m 간격으로 다시 샘플링한다
export function resampleLap(lap, N = null) {
  const S = lap.samples;
  const d = new Float64Array(S.length);
  for (let i = 1; i < S.length; i++) d[i] = d[i - 1] + Math.hypot(S[i].x - S[i - 1].x, S[i].z - S[i - 1].z);
  const len = d[S.length - 1];
  const n = N ?? Math.floor(len);
  const out = { n, length: len, t: new Float32Array(n), v: new Float32Array(n), thr: new Float32Array(n), brk: new Float32Array(n), steer: new Float32Array(n), gear: new Int8Array(n), x: new Float32Array(n), z: new Float32Array(n), lat: new Float32Array(n).fill(NaN), edge: new Float32Array(n).fill(NaN), traffic: new Uint8Array(n) };
  const hasLat = S.some((s) => Number.isFinite(s.lat));
  let j = 0;
  for (let k = 0; k < n; k++) {
    // 다른 랩과 같은 길이로 맞출 때는 비율로 위치를 정한다
    const target = (k / n) * len;
    while (j < S.length - 2 && d[j + 1] < target) j++;
    const span = d[j + 1] - d[j] || 1;
    const f = Math.min(1, Math.max(0, (target - d[j]) / span));
    const a = S[j], b = S[j + 1];
    const lerp = (p) => a[p] + (b[p] - a[p]) * f;
    out.t[k] = lerp('t') - S[0].t;
    out.v[k] = lerp('v');
    out.thr[k] = a.thr === undefined ? NaN : lerp('thr');
    out.brk[k] = a.brk === undefined ? NaN : lerp('brk');
    out.steer[k] = a.steer === undefined ? NaN : lerp('steer');
    out.gear[k] = f < 0.5 ? a.gear : b.gear;
    out.x[k] = lerp('x');
    out.z[k] = lerp('z');
    if (hasLat && Number.isFinite(a.lat) && Number.isFinite(b.lat)) { out.lat[k] = lerp('lat'); out.edge[k] = lerp('edge'); }
    out.traffic[k] = a.traffic || b.traffic ? 1 : 0;
  }
  return out;
}

// ---------- 코너 검출 (기준 랩에서) ----------
// 속도의 국소 최저점 중 앞뒤로 충분히 떨어진(12 km/h 이상) 곳을 코너 꼭짓점으로 본다
export function findCorners(R) {
  const n = R.n;
  const vk = Array.from(R.v, (v) => v * KMH);
  const sm = smooth(vk, 15);
  const corners = [];
  const W = 60;
  for (let i = 0; i < n; i++) {
    let isMin = true;
    for (let k = -W; k <= W && isMin; k++) if (sm[(i + k + n) % n] < sm[i] - 1e-6) isMin = false;
    if (!isMin) continue;
    // 좌우 300 m 안의 최고 속도와 비교한 깊이
    let preMax = 0, postMax = 0;
    for (let k = 1; k < 300; k++) { preMax = Math.max(preMax, sm[(i - k + n) % n]); postMax = Math.max(postMax, sm[(i + k) % n]); }
    if (Math.min(preMax, postMax) - sm[i] < 12) continue;
    if (corners.length && i - corners[corners.length - 1].apex < 80) continue;
    corners.push({ apex: i });
  }
  // 진입(브레이크·감속 시작)과 탈출(풀 스로틀 또는 다음 코너 전) 구간
  corners.forEach((c, ci) => {
    // 꼭짓점에서 거꾸로 가며 속도가 계속 높아지는(= 앞에서 감속해 온) 동안 따라가면 감속 시작점이 나온다.
    // 꼭짓점 근처는 속도 변화가 거의 없으므로 약간의 평탄 구간은 허용한다.
    let e = c.apex;
    const lim = ci > 0 ? corners[ci - 1].apex + 20 : Math.max(0, c.apex - 400);
    while (e > lim && (sm[e - 1] >= sm[e] - 0.05 || R.brk[e - 1] > 0.05)) e--;
    c.entry = e;
    let x = c.apex;
    const next = ci < corners.length - 1 ? corners[ci + 1].apex - 20 : Math.min(n - 1, c.apex + 500);
    while (x < next && R.thr[x] < 0.95) x++;
    c.exit = Math.min(next, x + 30);
    c.id = ci + 1;
    c.minSpeed = vk[c.apex];
  });
  // 겹치지 않는 코너 구간: 앞 꼭짓점과 이 꼭짓점 사이에서 속도가 가장 높은 곳(= 브레이크 시작 직전)에서 나눈다.
  // 각 구간은 브레이크·꼭짓점·탈출·다음 직선까지 포함하므로, 탈출이 느려 직선에서 잃은 시간도 그 코너 몫이 된다.
  const cuts = corners.map((c, ci) => {
    const prev = ci > 0 ? corners[ci - 1].apex : 0;
    let best = prev, bv = -1;
    for (let i = prev; i < c.apex; i++) if (sm[i] > bv) { bv = sm[i]; best = i; }
    // 최고 속도 지점보다 60 m 앞에서 나눈다: 브레이크를 일찍 밟아 직선 끝에서 잃은 시간도 이 코너 몫이 되게
    return ci === 0 ? 0 : Math.max(prev + 30, best - 60);
  });
  corners.forEach((c, ci) => {
    c.from = cuts[ci];
    c.to = ci < corners.length - 1 ? cuts[ci + 1] - 1 : n - 1;
  });
  return corners;
}

function smooth(a, w) {
  const n = a.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -w; k <= w; k++) { const j = i + k; if (j >= 0 && j < n) { s += a[j]; c++; } }
    out[i] = s / c;
  }
  return out;
}

// ---------- 코너별 지표 ----------
export function cornerMetrics(L, c) {
  const from = c.from;
  const to = Math.min(L.n - 1, c.to);
  // 페달 지표는 코너 자체(탈출까지)에서만 본다. 시간은 구간 전체(다음 직선 포함)로 잰다.
  const exitEnd = Math.min(to, c.exit);
  // 브레이크 시점: 꼭짓점 앞 최대 제동 지점에서 거꾸로 따라가, 5 m 넘게 끊기기 전까지의 제동 시작점.
  // 구간 시작보다 앞에서 밟기 시작했어도(일찍 밟은 경우) 찾을 수 있게 150 m 더 앞까지 본다.
  let brakePoint = null;
  const look0 = Math.max(0, from - 150);
  let pk = -1, pv = 0.1;
  for (let i = look0; i <= c.apex; i++) if (L.brk[i] > pv) { pv = L.brk[i]; pk = i; }
  if (pk >= 0) {
    let i = pk, gap = 0;
    while (i > look0 && gap <= 5) { i--; gap = L.brk[i] > 0.05 ? 0 : gap + 1; }
    brakePoint = Math.min(pk, i + gap + 1);
    // 10 m도 안 되게 살짝 건드린 것은 제동으로 보지 않는다
    let held = 0;
    for (let k = brakePoint; k <= c.apex; k++) if (L.brk[k] > 0.1) held++;
    if (held < 10) brakePoint = null;
  }
  let peak = 0, peakAt = brakePoint ?? c.apex;
  if (brakePoint !== null) for (let i = brakePoint; i <= c.apex; i++) if (L.brk[i] > peak) { peak = L.brk[i]; peakAt = i; }
  // 브레이크를 놓은 지점과, 놓는 데 걸린 거리 (트레일 브레이킹)
  let release = brakePoint;
  if (brakePoint !== null) { release = peakAt; while (release < exitEnd && L.brk[release] > 0.05) release++; }
  let releaseStart = peakAt;
  if (brakePoint !== null) { releaseStart = peakAt; while (releaseStart < release && L.brk[releaseStart] > peak * 0.8) releaseStart++; }
  const releaseDist = brakePoint !== null ? release - releaseStart : 0;
  // 코너 안에서 조향을 감기 시작한 지점 (최대 조향의 30%)
  let maxSteer = 0;
  for (let i = from; i <= exitEnd; i++) maxSteer = Math.max(maxSteer, Math.abs(L.steer[i]));
  let turnIn = c.apex;
  for (let i = from; i <= c.apex; i++) if (Math.abs(L.steer[i]) > maxSteer * 0.3) { turnIn = i; break; }
  // 조향이 들어간 뒤에도 브레이크를 유지한 거리
  let trail = 0;
  for (let i = turnIn; i <= c.apex; i++) if (L.brk[i] > 0.05) trail++;
  // 코스팅: 브레이크를 놓은 뒤 가속 전까지 두 페달 다 안 밟은 거리 (꼭짓점 뒤 비율도 기록)
  let coast = 0, coastAfter = 0;
  for (let i = brakePoint ?? from; i <= exitEnd; i++) if (L.brk[i] < 0.05 && L.thr[i] < 0.05) { coast++; if (i > c.apex) coastAfter++; }
  let thrPoint = null, fullPoint = null;
  for (let i = c.apex - 30; i <= exitEnd; i++) { if (thrPoint === null && L.thr[i] > 0.2) thrPoint = i; if (fullPoint === null && L.thr[i] > 0.95 && i > c.apex) fullPoint = i; }
  // 가속 중 다시 떼는 망설임
  let lifts = 0, maxThr = 0;
  for (let i = thrPoint ?? exitEnd; i <= exitEnd; i++) { maxThr = Math.max(maxThr, L.thr[i]); if (maxThr - L.thr[i] > 0.3) { lifts++; maxThr = L.thr[i]; } }
  // 코너 중 조향 수정 횟수 (조향 속도 부호가 바뀌는 큰 움직임)
  let corrections = 0, dir = 0;
  for (let i = from + 5; i <= exitEnd; i += 5) {
    const d = L.steer[i] - L.steer[i - 5];
    if (Math.abs(d) > 0.04) { const nd = Math.sign(d); if (dir && nd !== dir) corrections++; dir = nd; }
  }
  let vmin = Infinity, apexAt = c.apex;
  for (let i = c.entry; i <= exitEnd; i++) if (L.v[i] < vmin) { vmin = L.v[i]; apexAt = i; }
  // 마지막 구간은 결승선까지
  const time = (to >= L.n - 1 ? L.t[L.n - 1] + (L.t[L.n - 1] - L.t[L.n - 2]) : L.t[to + 1]) - L.t[from];
  return { brakePoint, peak, releaseDist, trail, coast, coastAfter, thrPoint, fullPoint, lifts, corrections, minSpeed: vmin * KMH, apexAt, time, from, to };
}

// ---------- 라인 ----------
// 기준 랩 라인에 대한 가로 위치(m). 가까운 기준점을 앞뒤 30칸 안에서 찾아 그 접선의 법선 방향 거리를 잰다.
// 부호는 cross(접선, 위치차)로, 코너 회전 방향(turn)과 같은 식이라 turn × offset > 0 이면 코너 안쪽이다.
export function lineOffsets(L, R) {
  const n = R.n;
  const out = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity, bj = j;
    for (let k = Math.max(0, i - 30); k <= Math.min(n - 1, i + 30); k++) {
      const d = (L.x[i] - R.x[k]) ** 2 + (L.z[i] - R.z[k]) ** 2;
      if (d < best) { best = d; bj = k; }
    }
    j = bj;
    const a = Math.max(0, j - 2), b = Math.min(n - 1, j + 2);
    const tx = R.x[b] - R.x[a], tz = R.z[b] - R.z[a];
    const tl = Math.hypot(tx, tz) || 1;
    out[i] = (tx * (L.z[i] - R.z[j]) - tz * (L.x[i] - R.x[j])) / tl;
  }
  return out;
}

// 코너 회전 방향: 진입 접선에서 탈출 접선으로 도는 방향 (+1 / −1)
function turnSign(R, c) {
  const a = Math.max(2, c.entry), b = Math.min(R.n - 3, c.exit);
  const t1x = R.x[a + 2] - R.x[a - 2], t1z = R.z[a + 2] - R.z[a - 2];
  const t2x = R.x[b + 2] - R.x[b - 2], t2z = R.z[b + 2] - R.z[b - 2];
  return Math.sign(t1x * t2z - t1z * t2x) || 1;
}

// 기준 랩의 턴인 지점: 꼭짓점 앞에서 진행 방향이 바뀌기 시작하는 곳 (조향 입력이 없는 상대 차에도 쓸 수 있게 위치로 판단)
function headingTurnIn(R, c) {
  const head = (i) => Math.atan2(R.z[Math.min(R.n - 1, i + 3)] - R.z[Math.max(0, i - 3)], R.x[Math.min(R.n - 1, i + 3)] - R.x[Math.max(0, i - 3)]);
  const start = Math.max(c.from, c.entry - 40);
  const h0 = head(Math.max(3, start));
  const total = Math.abs(wrap(head(c.apex) - h0));
  for (let i = start; i <= c.apex; i++) if (Math.abs(wrap(head(i) - h0)) > Math.max(0.05, total * 0.15)) return i;
  return Math.max(start, c.entry);
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// 한 코너의 라인 지표 (m, 기준 라인보다 안쪽 +).
// 한 점 대신 구간의 극값을 본다: 턴인 = 턴인 직전 30 m에서 가장 바깥, 꼭짓점 = ±15 m에서 가장 안쪽, 탈출 = 꼭짓점 뒤에서 가장 바깥.
function lineMetrics(off, c, sign, absIn) {
  const n = off.length;
  const ext = (a, b, most) => {
    let bi = Math.max(0, Math.min(n - 1, a)), bv = sign * off[bi];
    for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) {
      const v = sign * off[i];
      if (most(v, bv)) { bv = v; bi = i; }
    }
    return [bv, bi];
  };
  const [turnIn, ti] = ext(c.turnIn - 30, c.turnIn, (v, b) => v < b);
  const [apex, ai] = ext(c.apex - 15, c.apex + 15, (v, b) => v > b);
  const [exit, xi] = ext(c.apex + 10, Math.min(c.to, c.exit + 40), (v, b) => v < b);
  const e = (i) => (absIn && Number.isFinite(absIn[i]) ? absIn[i] : null);
  // 게임이 트랙 가장자리 정보를 주면 안쪽 가장자리까지 실제 거리(m)
  return { turnIn, apex, exit, turnInEdge: e(ti), apexEdge: e(ai), exitEdge: e(xi) };
}

// 속도만으로 보는 지표 (페달 입력이 없는 상대 차와 비교할 때)
export function speedMetrics(L, c) {
  const from = c.from;
  const to = Math.min(L.n - 1, c.to);
  let vmin = Infinity, apexAt = c.apex;
  for (let i = c.entry; i <= Math.min(to, c.exit); i++) if (L.v[i] < vmin) { vmin = L.v[i]; apexAt = i; }
  // 감속 시작: 꼭짓점에서 거꾸로 가며 속도가 계속 높아지는 동안 (1 km/h 정도의 흔들림은 허용)
  let d = apexAt;
  const lim = Math.max(0, from - 150);
  let peak = L.v[d];
  while (d > lim && L.v[d - 1] >= peak - 0.3) { d--; peak = Math.max(peak, L.v[d]); }
  const time = (to >= L.n - 1 ? L.t[L.n - 1] + (L.t[L.n - 1] - L.t[L.n - 2]) : L.t[to + 1]) - L.t[from];
  return { decelStart: d, minSpeed: vmin * KMH, apexAt, exitSpeed: L.v[Math.min(to, c.exit)] * KMH, entrySpeed: peak * KMH, time };
}

// ---------- 트래픽 ----------
// 내 앞 30 m 안에 다른 차가 있거나 옆 12 m 안에 붙어 있으면 그 샘플은 트래픽 영향
function markTraffic(samples) {
  let cars = null, carsT = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.cars) { cars = s.cars; carsT = s.t; }
    if (!cars || s.t - carsT > 0.5) continue;
    const p = samples[Math.max(0, i - 3)];
    const hx = s.x - p.x, hz = s.z - p.z;
    const hl = Math.hypot(hx, hz) || 1;
    for (const o of cars) {
      if (o.pit) continue;
      const dx = o.x - s.x, dz = o.z - s.z;
      const dist = Math.hypot(dx, dz);
      const ahead = (dx * hx + dz * hz) / hl;
      if (dist < 12 || (ahead > 0 && dist < 30)) { s.traffic = true; break; }
    }
  }
}

// ---------- 상대 차 ----------
function opponentLaps(samples) {
  const byId = new Map();
  for (const s of samples) {
    if (!s.cars) continue;
    for (const o of s.cars) {
      if (!byId.has(o.id)) byId.set(o.id, { id: o.id, name: o.n || `차량 ${o.id}`, cls: o.c || '', samples: [] });
      byId.get(o.id).samples.push({ t: s.t, lap: o.lap, x: o.x, z: o.z, v: o.v, pit: o.pit, off: o.off });
    }
  }
  return [...byId.values()].map((o) => ({ ...o, laps: splitLaps(o.samples) })).filter((o) => o.laps.length);
}

// ---------- 세션 분석 ----------
export function analyzeSession(all) {
  // 한 파일에 트랙·차가 다른 세션이 섞여 있으면 샘플이 가장 많은 조합만 분석한다
  const key = (x) => `${x.track ?? ''}|${x.car ?? ''}`;
  const count = new Map();
  for (const x of all) count.set(key(x), (count.get(key(x)) || 0) + 1);
  const main = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  // 게임이 차를 옮기는 순간(차고 복귀 등)에 비어 있는 데이터가 한두 개 섞인다: 타이어 온도가 절대영도(-273°C)인 샘플
  const samples = (count.size > 1 ? all.filter((x) => key(x) === main) : all).filter((x) => !(x.tire && x.tire.every((v) => v < -200)));
  markTraffic(samples);
  motion(samples);
  const cal = calibrate(samples);
  const laps = splitLaps(samples);
  const valid = laps.filter((l) => l.valid);
  if (!valid.length) {
    // 비교할 랩이 없어도 사고·실수는 분석한다 (절대 기준)
    const incidents = findIncidents(samples, cal, null);
    const why = [...new Set(laps.flatMap((l) => l.why))].join(', ');
    const driven = samples.filter((x) => x.v > 1 && !x.pit).length;
    return {
      laps, incidents, samples, cal, noRef: true,
      error: (laps.length ? `기준으로 쓸 수 있는 완주 랩이 없습니다 (${why}).` : `완주한 랩이 없습니다 (주행 ${(driven / 60).toFixed(0)}초 분량). 랩 비교는 한 바퀴 이상 끊김 없이 달려야 하고, 차고로 돌아가거나 리셋하면 그 랩은 끊깁니다.`)
        + (incidents.length ? ` 대신 사고·실수 ${incidents.length}건은 분석했습니다.` : ''),
    };
  }
  // 기준(베스트) 랩: 트랙 이탈 없고 평소보다 크게 느리지 않은 랩 중 가장 빠른 것
  const cand = valid.filter((l) => !l.hasOff && !l.slow);
  const best = (cand.length ? cand : valid).reduce((a, b) => (b.time < a.time ? b : a));
  const ref = resampleLap(best);
  // 모든 랩을 기준 랩과 같은 칸 수로 맞춘다 → 같은 인덱스 = 같은 트랙 위치
  for (const l of laps) l.R = l === best ? ref : resampleLap(l, ref.n);
  const corners = findCorners(ref);
  for (const c of corners) { c.turnIn = headingTurnIn(ref, c); c.turn = turnSign(ref, c); }
  // 게임의 가로 위치(lat) 부호는 문서에 없어서, 위치로 잰 오프셋과 같은 방향이 되도록 데이터로 맞춘다
  let latSign = 0;
  const hasLat = Number.isFinite(ref.lat[0]);
  const offsets = new Map();
  for (const l of laps) offsets.set(l, l === best ? new Float32Array(ref.n) : lineOffsets(l.R, ref));
  if (hasLat) {
    let acc = 0;
    for (const l of laps) {
      if (l === best) continue;
      const off = offsets.get(l);
      for (let i = 0; i < ref.n; i += 5) if (Number.isFinite(l.R.lat[i])) acc += off[i] * (l.R.lat[i] - ref.lat[i]);
    }
    latSign = acc >= 0 ? 1 : -1;
  }
  // 안쪽 가장자리까지 거리 = 가장자리 거리 − 안쪽 방향으로의 가로 위치
  const insideEdge = (R) => (hasLat ? corners.reduce((arr, c) => {
    for (let i = c.from; i <= Math.min(R.n - 1, c.to); i++) arr[i] = Math.abs(R.edge[i]) - c.turn * latSign * R.lat[i]; // 게임의 가장자리 값은 차가 있는 쪽 부호를 따른다
    return arr;
  }, new Float32Array(R.n).fill(NaN)) : null);
  for (const l of laps) {
    l.corners = corners.map((c) => cornerMetrics(l.R, c));
    l.speed = corners.map((c) => speedMetrics(l.R, c));
    l.offset = offsets.get(l);
    const absIn = insideEdge(l.R);
    l.line = corners.map((c) => lineMetrics(l.offset, c, c.turn, absIn));
    // 코너 구간 안에 트래픽이 있었는가
    l.traffic = corners.map((c) => { for (let i = c.from; i <= Math.min(l.R.n - 1, c.exit); i++) if (l.R.traffic[i]) return true; return false; });
    l.delta = Float32Array.from(l.R.t, (t, i) => t - ref.t[i]);
  }
  // 사고 분석: 스핀·이탈·충돌·큰 감속. 그 코너(와 회복까지 걸린 코너)는 평균·기준 계산에서만 뺀다.
  // 샘플 → 기준 랩 칸. 완주 랩은 그 랩 거리 비율로(재샘플과 같게), 랩 조각은 게임의 랩 거리로.
  const idxOf = new Map(samples.map((x, i) => [x, i]));
  const refIdxArr = new Int32Array(samples.length).fill(-1);
  const lapOf = new Array(samples.length);
  const fracIdx = (L) => {
    const S = L.samples;
    let d = 0;
    const out = [0];
    for (let i = 1; i < S.length; i++) { d += Math.hypot(S[i].x - S[i - 1].x, S[i].z - S[i - 1].z); out.push(d); }
    return out.map((x) => Math.min(ref.n - 1, Math.floor((x / (d || 1)) * ref.n)));
  };
  const trackLen = samples.find((x) => x.trackLen > 100)?.trackLen;
  if (trackLen) samples.forEach((x, i) => { if (Number.isFinite(x.lapDist) && !x.pit) refIdxArr[i] = Math.min(ref.n - 1, Math.max(0, Math.floor((x.lapDist / trackLen) * ref.n))); });
  for (const l of laps) {
    const f = fracIdx(l);
    l.samples.forEach((x, j) => { const i = idxOf.get(x); refIdxArr[i] = f[j]; lapOf[i] = l; });
  }
  const bestIdx = fracIdx(best);
  const A0 = { ref, corners, best };
  const incidents = findIncidents(samples, cal, {
    A: A0, bestIdx, refIdx: (i) => refIdxArr[i],
    offsetAt: (i) => (lapOf[i]?.offset ? lapOf[i].offset[refIdxArr[i]] : NaN),
  });
  for (const l of laps) { l.bad = corners.map(() => false); l.incidents = []; }
  for (const e of incidents) {
    const l = lapOf[e.sample];
    if (!l) continue;
    l.incidents.push(e);
    if (e.cornerIdx < 0) continue;
    for (let k = e.cornerIdx; k < corners.length; k++) {
      if (k > e.cornerIdx && corners[k].from > (e.endIdx ?? e.refIdx)) break;
      l.bad[k] = true;
    }
  }
  // 이론상 베스트: 코너 구간마다 트래픽·사고 없이 가장 빠른 랩의 시간을 더한다
  const clean = (k) => valid.filter((l) => !l.traffic[k] && !l.bad[k]);
  const segTimes = corners.map((c, k) => Math.min(...(clean(k).length ? clean(k) : valid).map((l) => l.corners[k].time)));
  const refSeg = corners.map((c, k) => best.corners[k].time);
  const theoretical = best.time - refSeg.reduce((a, b) => a + b, 0) + segTimes.reduce((a, b) => a + b, 0);
  // 코너별 일관성: 트래픽 없는 유효 랩들의 코너 시간 표준편차
  const spread = corners.map((c, k) => std((clean(k).length ? clean(k) : valid).map((l) => l.corners[k].time)));
  // 상대 차: 같은 기준 라인 위로 맞춰 코너별 속도·라인 지표
  const opponents = opponentLaps(samples).map((o) => {
    for (const l of o.laps) {
      l.R = resampleLap(l, ref.n);
      l.speed = corners.map((c) => speedMetrics(l.R, c));
      l.offset = lineOffsets(l.R, ref);
      l.line = corners.map((c) => lineMetrics(l.offset, c, c.turn, null));
    }
    const ok = o.laps.filter((l) => l.valid);
    o.best = ok.length ? ok.reduce((a, b) => (b.time < a.time ? b : a)) : null;
    return o;
  }).filter((o) => o.best).sort((a, b) => a.best.time - b.best.time);
  return { laps, best, ref, corners, theoretical, spread, segTimes, opponents, hasLat, incidents, cal, samples, mixed: count.size > 1 ? count.size : 0 };
}

function std(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
}

// ---------- 코칭 문장 ----------
// 한 코너에서 비교 랩(m)과 기준(r)의 지표를 비교해 원인 후보를 무게 순으로 돌려준다.
// short는 주행 중 음성 안내용 짧은 문구.
export function cornerReasons(m, r) {
  const reasons = [];
  if (m.brakePoint !== null && r.brakePoint !== null) {
    const db = m.brakePoint - r.brakePoint;
    if (db < -8) reasons.push({ w: -db / 10, short: '브레이크 일찍', text: `브레이크를 ${-db} m 일찍 밟았습니다. 기준 랩은 ${-db} m 더 들어가서 밟았습니다.` });
    if (db > 8 && m.minSpeed < r.minSpeed - 2) reasons.push({ w: db / 10, short: '브레이크 늦음', text: `브레이크를 ${db} m 늦게 밟아 진입이 과했고, 최저 속도가 ${(r.minSpeed - m.minSpeed).toFixed(0)} km/h 낮아졌습니다.` });
  }
  if (m.peak < r.peak - 0.15 && m.brakePoint !== null) reasons.push({ w: (r.peak - m.peak) * 5, short: '초기 제동 약함', text: `초기 제동이 약합니다 (최대 ${(m.peak * 100).toFixed(0)}%, 기준 ${(r.peak * 100).toFixed(0)}%). 처음에 더 세게 밟고 점점 푸세요.` });
  if (r.releaseDist > 15 && m.releaseDist < r.releaseDist * 0.4) reasons.push({ w: 2, short: '브레이크 급하게 놓음', text: `브레이크를 한 번에 놓았습니다 (${m.releaseDist} m 동안 해제, 기준 ${r.releaseDist} m). 조향을 감으면서 서서히 푸는 트레일 브레이킹이 부족합니다.` });
  if (m.coast > r.coast + 10) {
    const late = m.coastAfter > m.coast * 0.6;
    reasons.push({ w: (m.coast - r.coast) / 10, short: late ? '가속 늦음' : '코스팅', text: late
      ? `꼭짓점을 지나고도 ${m.coastAfter} m 동안 가속하지 않았습니다. 차가 회전을 마치면 바로 스로틀을 여세요.`
      : `페달을 둘 다 떼고 ${m.coast} m를 흘러갔습니다 (기준 ${r.coast} m). 브레이크에서 바로 가속으로 넘어가세요.` });
  }
  if (m.thrPoint !== null && r.thrPoint !== null && m.thrPoint - r.thrPoint > 10) reasons.push({ w: (m.thrPoint - r.thrPoint) / 10, short: '가속 늦음', text: `가속을 ${m.thrPoint - r.thrPoint} m 늦게 시작했습니다.` });
  if (m.lifts > r.lifts) reasons.push({ w: 1.5, short: '스로틀 망설임', text: `가속 중에 스로틀을 다시 뗐습니다 (${m.lifts}회). 차가 불안정하면 처음부터 조금 덜 열고 점점 여세요.` });
  if (m.corrections > r.corrections + 2) reasons.push({ w: 1, short: '조향 수정 많음', text: `코너 안에서 조향을 ${m.corrections}번 고쳐 잡았습니다. 진입 속도나 라인이 불안정하다는 신호입니다.` });
  if (m.minSpeed < r.minSpeed - 3 && !reasons.length) reasons.push({ w: (r.minSpeed - m.minSpeed) / 3, short: '코너 속도 낮음', text: `코너 최저 속도가 ${(r.minSpeed - m.minSpeed).toFixed(0)} km/h 낮습니다. 더 빠르게 굴려도 됩니다.` });
  if (!reasons.length) reasons.push({ w: 0, short: '', text: '페달 조작에서 뚜렷한 차이는 없습니다.' });
  return reasons.sort((a, b) => b.w - a.w);
}

// 라인 비교: 턴인·꼭짓점·탈출의 가로 위치 차이 (m, 안쪽 +). 0.8 m 이상만 말한다.
export function lineReasons(m, r) {
  const out = [];
  const dA = m.apex - r.apex, dT = m.turnIn - r.turnIn, dX = m.exit - r.exit;
  const edge = (v) => (v === null || !Number.isFinite(v) ? '' : ` (안쪽 가장자리까지 ${v.toFixed(1)} m)`);
  if (dA < -0.8) out.push({ w: -dA / 0.8, short: '에이펙스 놓침', text: `꼭짓점에서 기준보다 ${(-dA).toFixed(1)} m 바깥으로 지나갔습니다${edge(m.apexEdge)}. 안쪽에 더 붙이세요.` });
  if (dT > 0.8) out.push({ w: dT / 0.8, short: '진입 폭 안 씀', text: `턴인할 때 기준보다 ${dT.toFixed(1)} m 안쪽에 있었습니다${edge(m.turnInEdge)}. 진입 전에 바깥쪽을 더 쓰면 코너를 더 크게 돌 수 있습니다.` });
  if (dX > 0.8) out.push({ w: dX / 0.8, short: '탈출 폭 안 씀', text: `탈출에서 기준보다 ${dX.toFixed(1)} m 안쪽에 머물렀습니다. 바깥쪽 끝까지 흘려 보내며 일찍 가속하세요.` });
  if (dX < -1.5 && dA > 0.5) out.push({ w: -dX / 1.2, short: '일찍 꺾음', text: `꼭짓점은 안쪽(${dA.toFixed(1)} m)인데 탈출이 ${(-dX).toFixed(1)} m 바깥으로 밀렸습니다. 너무 일찍 꺾어서 탈출에서 가속을 늦춰야 하는 전형적인 형태입니다.` });
  return out;
}

// 상대 차와 비교할 때는 페달 입력이 없으므로 속도 흐름으로 판단한다
export function speedReasons(m, r) {
  const out = [];
  const dd = m.decelStart - r.decelStart;
  if (dd < -10) out.push({ w: -dd / 10, short: '감속 일찍', text: `상대보다 ${-dd} m 일찍 감속을 시작했습니다.` });
  if (dd > 10 && m.minSpeed < r.minSpeed - 2) out.push({ w: dd / 10, short: '감속 늦음', text: `상대보다 ${dd} m 늦게 감속했지만 최저 속도가 ${(r.minSpeed - m.minSpeed).toFixed(0)} km/h 낮습니다. 너무 깊게 들어갔습니다.` });
  if (m.minSpeed < r.minSpeed - 3) out.push({ w: (r.minSpeed - m.minSpeed) / 3, short: '코너 속도 낮음', text: `최저 속도가 상대보다 ${(r.minSpeed - m.minSpeed).toFixed(0)} km/h 낮습니다.` });
  if (m.exitSpeed < r.exitSpeed - 4) out.push({ w: (r.exitSpeed - m.exitSpeed) / 4, short: '탈출 느림', text: `탈출 속도가 상대보다 ${(r.exitSpeed - m.exitSpeed).toFixed(0)} km/h 낮아 다음 직선에서 손해를 봅니다.` });
  return out;
}

// 비교 랩의 코너마다 기준과 비교해 손해가 큰 순서로 정리.
// target 없음: 코너마다 트래픽 없이 가장 빨리 지난 내 랩이 기준 (베스트 랩이 모든 코너에서 최고는 아니므로)
// target { lap }: 상대 차의 랩이 기준 (속도·라인만 비교)
export function coachLap(A, lap, target = null) {
  const tips = [];
  const skipped = [];
  const valid = A.laps.filter((l) => l.valid);
  A.corners.forEach((c, k) => {
    if (lap.traffic?.[k]) { skipped.push(c.id); return; }
    if (lap.bad?.[k]) return; // 사고 분석에서 따로 설명한다
    let ref, loss, reasons, refName;
    if (target) {
      ref = target.lap;
      loss = lap.speed[k].time - ref.speed[k].time;
      reasons = [...speedReasons(lap.speed[k], ref.speed[k]), ...lineReasons(lap.line[k], ref.line[k])];
      refName = target.name;
    } else {
      const pool = valid.filter((l) => !l.traffic[k] && !l.bad[k]);
      if (!pool.length) return;
      ref = pool.reduce((a, b) => (b.corners[k].time < a.corners[k].time ? b : a));
      if (ref === lap) return;
      loss = lap.corners[k].time - ref.corners[k].time;
      reasons = [...cornerReasons(lap.corners[k], ref.corners[k]).filter((x) => x.w > 0), ...lineReasons(lap.line[k], ref.line[k])];
      refName = `랩 ${ref.lap}`;
    }
    if (loss < 0.04) return;
    reasons.sort((a, b) => b.w - a.w);
    if (!reasons.length) reasons.push({ text: '페달·속도·라인에서 뚜렷한 차이는 없습니다. 조금씩 고르게 느립니다.', short: '' });
    tips.push({ corner: c.id, loss, reasons: reasons.slice(0, 2).map((x) => x.text), short: reasons[0].short, refLap: ref.lap, refName });
  });
  return { tips: tips.sort((a, b) => b.loss - a.loss), skipped };
}

// 세션 전체 요약: 코너별 평균 손해와 반복되는 실수
export function sessionSummary(A) {
  const valid = A.laps.filter((l) => l.valid);
  return A.corners.map((c, k) => {
    const fastest = A.segTimes[k];
    const pool = valid.filter((l) => !l.traffic[k] && !l.bad[k]);
    const use = pool.length ? pool : valid.filter((l) => !l.bad[k]);
    if (!use.length) return { corner: c.id, avgLoss: 0, spread: 0, minSpeed: c.minSpeed };
    const avgLoss = use.reduce((s, l) => s + (l.corners[k].time - fastest), 0) / use.length;
    return { corner: c.id, avgLoss, spread: A.spread[k], minSpeed: c.minSpeed };
  }).sort((a, b) => b.avgLoss - a.avgLoss);
}
