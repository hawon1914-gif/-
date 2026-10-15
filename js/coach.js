// 주행 코칭 분석: 텔레메트리 샘플 → 랩 분리 → 1 m 간격 재샘플 → 코너 검출 → 코너별 지표 → 코칭 문장.
// 입력 샘플 형식 (브리지·기록 파일·데모 공통):
//   { t: 초, lap: 랩 번호, x, z: 평면 위치(m), v: 속도(m/s), thr, brk: 0~1, steer: -1~1, gear, rpm, off?: 트랙 이탈 여부 }

const KMH = 3.6;

// ---------- 랩 분리 ----------
export function splitLaps(samples) {
  const laps = [];
  let cur = null;
  for (const s of samples) {
    if (!cur || s.lap !== cur.lap) {
      if (cur) laps.push(cur);
      cur = { lap: s.lap, samples: [] };
    }
    cur.samples.push(s);
  }
  if (cur) laps.push(cur);
  // 첫 랩(피트·중간 진입)과 끝나지 않은 마지막 랩은 비교에서 뺀다
  const done = laps.slice(1, -1).filter((l) => l.samples.length > 50);
  return done.map((l, i) => finishLap(l, i === 0 && laps.length > 1 ? false : true));
}

function finishLap(raw) {
  const S = raw.samples;
  const time = S[S.length - 1].t - S[0].t;
  const off = S.some((s) => s.off);
  return { lap: raw.lap, time, valid: !off, samples: S };
}

// 위치를 따라 누적 거리를 구하고 1 m 간격으로 다시 샘플링한다
export function resampleLap(lap, N = null) {
  const S = lap.samples;
  const d = new Float64Array(S.length);
  for (let i = 1; i < S.length; i++) d[i] = d[i - 1] + Math.hypot(S[i].x - S[i - 1].x, S[i].z - S[i - 1].z);
  const len = d[S.length - 1];
  const n = N ?? Math.floor(len);
  const out = { n, length: len, t: new Float32Array(n), v: new Float32Array(n), thr: new Float32Array(n), brk: new Float32Array(n), steer: new Float32Array(n), gear: new Int8Array(n), x: new Float32Array(n), z: new Float32Array(n) };
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
    out.thr[k] = lerp('thr');
    out.brk[k] = lerp('brk');
    out.steer[k] = lerp('steer');
    out.gear[k] = f < 0.5 ? a.gear : b.gear;
    out.x[k] = lerp('x');
    out.z[k] = lerp('z');
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

// ---------- 세션 분석 ----------
export function analyzeSession(samples) {
  const laps = splitLaps(samples);
  const valid = laps.filter((l) => l.valid);
  if (!valid.length) return { laps, error: laps.length ? '완주한 유효 랩이 없습니다 (모두 트랙 이탈)' : '완주한 랩이 없습니다. 최소 3바퀴(아웃랩, 측정 랩, 다음 랩 시작)가 필요합니다.' };
  const best = valid.reduce((a, b) => (b.time < a.time ? b : a));
  const ref = resampleLap(best);
  // 모든 랩을 기준 랩과 같은 칸 수로 맞춘다 → 같은 인덱스 = 같은 트랙 위치
  for (const l of laps) l.R = l === best ? ref : resampleLap(l, ref.n);
  const corners = findCorners(ref);
  for (const l of laps) {
    l.corners = corners.map((c) => cornerMetrics(l.R, c));
    l.delta = Float32Array.from(l.R.t, (t, i) => t - ref.t[i]);
  }
  // 이론상 베스트: 코너 구간마다 가장 빠른 랩의 시간을 더한다
  const segTimes = corners.map((c, k) => Math.min(...valid.map((l) => l.corners[k].time)));
  const refSeg = corners.map((c, k) => best.corners[k].time);
  const theoretical = best.time - refSeg.reduce((a, b) => a + b, 0) + segTimes.reduce((a, b) => a + b, 0);
  // 코너별 일관성: 유효 랩들의 코너 시간 표준편차
  const spread = corners.map((c, k) => std(valid.map((l) => l.corners[k].time)));
  return { laps, best, ref, corners, theoretical, spread, segTimes };
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
  if (!reasons.length) reasons.push({ w: 0, short: '', text: '페달 조작에서 뚜렷한 차이는 없습니다. 라인(지도)을 비교해 보세요.' });
  return reasons.sort((a, b) => b.w - a.w);
}

// 비교 랩의 코너마다, 그 코너를 가장 빨리 지난 랩과 비교해 손해가 큰 순서로 정리
// (베스트 랩이 모든 코너에서 가장 빠르지는 않으므로 코너별 최고 기록을 기준으로 삼는다)
export function coachLap(A, lap) {
  const tips = [];
  const valid = A.laps.filter((l) => l.valid);
  A.corners.forEach((c, k) => {
    const ref = valid.reduce((a, b) => (b.corners[k].time < a.corners[k].time ? b : a));
    if (ref === lap) return;
    const m = lap.corners[k];
    const r = ref.corners[k];
    const loss = m.time - r.time;
    if (loss < 0.04) return;
    tips.push({ corner: c.id, loss, reasons: cornerReasons(m, r).slice(0, 2).map((x) => x.text), refLap: ref.lap });
  });
  return tips.sort((a, b) => b.loss - a.loss);
}

// 세션 전체 요약: 코너별 평균 손해와 반복되는 실수
export function sessionSummary(A) {
  const valid = A.laps.filter((l) => l.valid);
  return A.corners.map((c, k) => {
    const fastest = A.segTimes[k];
    const avgLoss = valid.reduce((s, l) => s + (l.corners[k].time - fastest), 0) / valid.length;
    return { corner: c.id, avgLoss, spread: A.spread[k], minSpeed: c.minSpeed };
  }).sort((a, b) => b.avgLoss - a.avgLoss);
}
