// 사고·실수 분석: 스핀, 트랙 이탈, 충돌, 큰 감속을 찾아내고, 직전 몇 초의 조작을 기준 랩의 같은 지점과 비교해 원인을 추정한다.
// 원인은 데이터로 보이는 것만 말한다. 근거가 없으면 모른다고 말한다.

const KMH = 3.6;
const pct = (x) => `${Math.round(x * 100)}%`;

// 세션 단위 보정값: 조향 부호, 직진 시 뒷바퀴/앞바퀴 회전비, 타이어 평소 온도
export function calibrate(A, samplesAll) {
  const R = A.ref;
  // 경로 곡률 (1/m, 왼쪽 +)과 조향 입력의 부호 관계
  const kap = curvature(R);
  let acc = 0;
  for (let i = 0; i < R.n; i++) if (Number.isFinite(R.steer[i])) acc += R.steer[i] * kap[i];
  const steerSign = acc >= 0 ? 1 : -1;
  const ratios = [];
  const temps = [];
  for (const s of samplesAll) {
    if (s.wr && s.v > 20 && Math.abs(s.steer ?? 0) < 0.05 && (s.brk ?? 0) < 0.03 && (s.thr ?? 1) < 0.5) {
      const f = (s.wr[0] + s.wr[1]) / 2, r = (s.wr[2] + s.wr[3]) / 2;
      if (f > 1) ratios.push(r / f);
    }
    if (s.tire && s.v > 20) temps.push(s.tire.reduce((a, b) => a + b, 0) / s.tire.length);
  }
  // 기준 랩 원본 샘플 → 기준 칸 (같은 지점의 시간축 조작을 비교하려고)
  const B = A.best.samples;
  const bd = [0];
  for (let i = 1; i < B.length; i++) bd.push(bd[i - 1] + Math.hypot(B[i].x - B[i - 1].x, B[i].z - B[i - 1].z));
  const bestIdx = bd.map((x) => Math.min(R.n - 1, Math.floor((x / (bd[B.length - 1] || 1)) * R.n)));
  return { kap, steerSign, wheel: median(ratios) || null, tire: median(temps) || null, bestIdx };
}

function curvature(R) {
  const n = R.n;
  const out = new Float32Array(n);
  const head = (i) => Math.atan2(R.z[Math.min(n - 1, i + 4)] - R.z[Math.max(0, i - 4)], R.x[Math.min(n - 1, i + 4)] - R.x[Math.max(0, i - 4)]);
  for (let i = 5; i < n - 5; i++) {
    let d = head(i + 1) - head(i - 1);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    out[i] = d / 2; // 기준 칸 1개 ≈ 1 m
  }
  return out;
}

function median(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[b.length >> 1];
}

// 한 랩의 사고 목록
export function detectIncidents(A, lap, cal) {
  const S = lap.samples;
  const R = A.ref;
  const n = S.length;
  if (n < 20 || !lap.R) return [];
  // 샘플 → 기준 랩 칸 (거리 비율)
  const d = new Float64Array(n);
  for (let i = 1; i < n; i++) d[i] = d[i - 1] + Math.hypot(S[i].x - S[i - 1].x, S[i].z - S[i - 1].z);
  const ri = (i) => Math.min(R.n - 1, Math.max(0, Math.floor((d[i] / (d[n - 1] || 1)) * R.n)));
  const hasSlip = S.some((s) => Number.isFinite(s.slip) && s.slip !== 0);
  const timeIdx = (t0) => { let i = 0; while (i < n - 1 && S[i].t < t0) i++; return i; };

  const raw = [];
  // 1) 스핀·큰 미끄러짐
  for (let i = 0; i < n; i++) {
    const s = S[i];
    if (hasSlip && Math.abs(s.slip) > 25 && s.v > 4) { raw.push({ kind: 'spin', i }); i = timeIdx(s.t + 3); continue; }
    // 슬립 각도가 없는 예전 기록: 기준 랩보다 훨씬 느려지면서 반대로 조향(카운터스티어)했으면 스핀으로 추정
    if (!hasSlip) {
      const k = ri(i);
      if (R.v[k] > 15 && s.v < R.v[k] * 0.5 && counterSteer(S, i, cal, R, ri)) { raw.push({ kind: 'spin', i, guessed: true }); i = timeIdx(s.t + 3); }
    }
  }
  // 2) 트랙 이탈 (두 바퀴 이상 잔디·흙·자갈)
  for (let i = 1; i < n; i++) if (S[i].off && !S[i - 1].off) raw.push({ kind: 'off', i });
  // 3) 충돌: 게임이 준 충격 중 속도가 10 km/h 넘게 줄어든 것
  for (let i = 0; i < n; i++) if (S[i].imp) {
    const j = timeIdx(S[i].t + 0.6);
    const drop = (S[Math.max(0, i - 3)].v - S[j].v) * KMH;
    if (drop > 10) raw.push({ kind: 'impact', i, mag: S[i].imp, drop });
  }
  // 4) 큰 감속: 기준 랩 같은 지점보다 40% 넘게 느린 상태가 1초 넘게 (위에서 못 잡은 사고·정지)
  let slowFrom = -1;
  for (let i = 0; i < n; i++) {
    const k = ri(i);
    const slow = R.v[k] > 12 && S[i].v < R.v[k] * 0.6 && !S[i].pit;
    if (slow && slowFrom < 0) slowFrom = i;
    if (!slow && slowFrom >= 0) {
      if (S[i].t - S[slowFrom].t > 1) raw.push({ kind: 'slow', i: slowFrom });
      slowFrom = -1;
    }
  }
  raw.sort((a, b) => a.i - b.i);
  // 3초 안에 겹치는 것은 하나의 사고로 묶는다 (스핀 → 이탈 → 감속은 한 사건). 대표 종류는 스핀 > 충돌 > 이탈 > 감속.
  const rank = { spin: 4, impact: 3, off: 2, slow: 1 };
  const groups = [];
  for (const e of raw) {
    const g = groups[groups.length - 1];
    if (g && S[e.i].t - S[g.last].t < 3) { g.items.push(e); g.last = e.i; if (rank[e.kind] > rank[g.kind]) g.kind = e.kind; }
    else groups.push({ kind: e.kind, first: e.i, last: e.i, items: [e] });
  }
  return groups.map((g) => explain(A, lap, cal, S, g, ri, hasSlip, timeIdx));
}

function counterSteer(S, i, cal, R, ri) {
  // 카운터스티어: 조향이 차가 도는 길의 방향과 반대
  for (let j = Math.max(0, i - 90); j <= i; j++) {
    const k = ri(j);
    const kp = cal.kap[k];
    if (Math.abs(kp) > 1 / 250 && Number.isFinite(S[j].steer) && S[j].steer * cal.steerSign * Math.sign(kp) < -0.08) return true;
  }
  return false;
}

// 사고 하나: 시작 시점·위치·손해 시간·원인
function explain(A, lap, cal, S, g, ri, hasSlip, timeIdx) {
  const R = A.ref;
  // 시작 시점: 대표 지점에서 거슬러 올라가며 처음 흐트러진 곳 (슬립 8° 초과, 이탈 시작, 3초 이내)
  let on = g.first;
  const tLim = S[g.first].t - 3;
  if (hasSlip) while (on > 0 && S[on - 1].t > tLim && Math.abs(S[on - 1].slip) > 8) on--;
  const s0 = S[on];
  const k0 = ri(on);
  const corner = A.corners.find((c) => k0 >= c.from && k0 <= c.to) || A.corners.reduce((a, c) => (Math.abs(c.apex - k0) < Math.abs(a.apex - k0) ? c : a));
  const phase = k0 < corner.entry ? '제동 구간' : k0 < corner.apex - 5 ? '코너 진입' : k0 <= corner.apex + 15 ? '꼭짓점 부근' : '코너 탈출';
  // 손해: 사고 전 기준 대비 차이 → 기준 속도의 95%로 회복한 곳의 차이
  const startK = Math.max(0, Math.min(k0, corner.from) - 1);
  let endK = k0;
  while (endK < R.n - 1 && endK < k0 + 800 && !(lap.R.v[endK] >= R.v[endK] * 0.95 && endK > k0 + 20)) endK++;
  const loss = lap.delta[endK] - lap.delta[startK];

  const verb = { spin: '미끄러지기', off: '트랙을 벗어나기', impact: '충돌하기', slow: '속도가 크게 떨어지기' }[g.kind];
  const causes = [];
  const add = (w, text) => causes.push({ w, text });
  const win = (sec) => { const a = timeIdx(s0.t - sec); return S.slice(a, on + 1); };
  const W = win(2);
  const refAt = (arr) => arr[k0];
  // 기준 랩에서 같은 지점(가장 가까운 샘플)과 그 직전 시간 창
  const B = A.best.samples;
  let bj = 0;
  for (let j = 0; j < B.length; j++) if (Math.abs(cal.bestIdx[j] - k0) < Math.abs(cal.bestIdx[bj] - k0)) bj = j;
  const BW = (sec) => windowAt(B, bj, sec);
  const turning = Math.abs(cal.kap[k0]) > 1 / 300 || Math.abs(s0.steer ?? 0) > 0.1;
  // 진입 속도
  const dv = (s0.v - refAt(R.v)) * KMH;
  if (dv > 4 && phase !== '코너 탈출') add(dv / 4, `같은 지점에서 기준 랩보다 ${dv.toFixed(0)} km/h 빨랐습니다 (${(s0.v * KMH).toFixed(0)} vs ${(refAt(R.v) * KMH).toFixed(0)} km/h). 그 속도로는 이 코너의 그립을 넘습니다. 브레이크를 조금 더 일찍 또는 강하게.`);
  // 스로틀을 급하게·많이 연 경우
  const W07 = windowAt(S, on, 0.7);
  const thrMin = Math.min(...W07.map((x) => x.thr ?? 0));
  const rise = (s0.thr ?? 0) - thrMin;
  const refRise = thrRise(BW(0.7));
  const tr = B[bj].thr ?? refAt(R.thr);
  // 기준 랩도 같은 곳에서 똑같이 열었다면 원인이 아니다
  if ((s0.thr ?? 0) > 0.45 && rise > 0.35 && turning && (rise > refRise + 0.3 || s0.thr > tr + 0.25)) {
    add(1.5 + rise * 2, `${verb} 직전에 스로틀을 ${pct(thrMin)}→${pct(s0.thr)}로 빠르게 열었습니다${Number.isFinite(tr) ? ` (기준 랩은 같은 지점에서 ${pct(tr)})` : ''}. 아직 조향이 남아 있을 때는 천천히, 핸들을 푸는 만큼만 여세요.`);
  }
  // 휠스핀·잠김 (바퀴 회전비를 직진 때 값과 비교)
  if (cal.wheel && s0.wr) {
    const ratio = (w) => ((w[2] + w[3]) / 2) / Math.max(1, (w[0] + w[1]) / 2) / cal.wheel;
    const rs = W.slice(-30).filter((x) => x.wr).map((x) => ratio(x.wr));
    const hi = Math.max(...rs), lo = Math.min(...rs);
    if (hi > 1.08 && (s0.thr ?? 0) > 0.3) add(2 + (hi - 1) * 10, `뒷바퀴가 앞바퀴보다 ${((hi - 1) * 100).toFixed(0)}% 빨리 돌았습니다 (휠스핀). 뒤 타이어가 횡 그립을 잃어 리어가 빠졌습니다.`);
    if (lo < 0.9 && W.slice(-30).some((x) => (x.brk ?? 0) > 0.2)) add(2 + (1 - lo) * 10, `제동 중 뒷바퀴가 앞바퀴보다 ${((1 - lo) * 100).toFixed(0)}% 느리게 돌았습니다 (뒷바퀴 잠김). 브레이크 밸런스가 뒤로 가 있거나 다운시프트가 너무 빨랐을 수 있습니다.`);
    if (hi > 1.12 && W.slice(-30).some((x) => (x.brk ?? 0) > 0.2)) add(2, `제동 중 앞바퀴가 거의 멈췄습니다 (앞바퀴 잠김). 초기 제동은 강하게, 회전하면서는 브레이크를 풀어 주세요.`);
  }
  // 리프트오프 오버스티어
  const thrPrev = Math.max(...win(1).slice(0, -12).map((x) => x.thr ?? 0), 0);
  const refLift = Math.max(...BW(1).slice(0, -12).map((x) => x.thr ?? 0), 0) - (B[bj].thr ?? 0);
  if (thrPrev > 0.7 && (s0.thr ?? 0) < 0.2 && turning && (s0.brk ?? 0) < 0.2 && refLift < 0.4) add(2.5, `코너 안에서 스로틀을 ${pct(thrPrev)}에서 갑자기 뗐습니다. 하중이 앞으로 쏠려 리어가 가벼워지는 리프트오프 오버스티어입니다. 떼야 하면 천천히.`);
  // 회전 중 제동
  const tb = B[bj].brk ?? refAt(R.brk);
  if ((s0.brk ?? 0) > 0.3 && turning && Number.isFinite(tb) && s0.brk > tb + 0.2) add(1.5 + (s0.brk - tb) * 3, `조향한 상태에서 브레이크가 ${pct(s0.brk)}였습니다 (기준 랩 ${pct(tb)}). 회전 중 강한 제동은 리어 하중을 빼서 차를 돌게 만듭니다. 직선에서 더 세게 밟고 턴인하면서 푸세요.`);
  // 다운시프트
  for (let j = Math.max(1, timeIdx(s0.t - 0.8)); j <= on; j++) {
    if (S[j].gear < S[j - 1].gear && S[j].gear > 0) {
      const over = S[j].maxRpm && S[j].rpm > S[j].maxRpm * 0.95;
      add(over ? 3 : 1.2, `${verb} ${(s0.t - S[j].t).toFixed(1)}초 전에 ${S[j - 1].gear}→${S[j].gear}단으로 내렸습니다${over ? ` (회전수 ${S[j].rpm}, 한계 근처)` : ''}. 엔진 브레이크가 뒷바퀴를 붙잡았을 수 있습니다. 속도가 더 떨어진 뒤 내리세요.`);
      break;
    }
  }
  // 급조향
  const rate = steerRate(windowAt(S, on, 1));
  const refRate = steerRate(BW(1));
  if (rate > 1.5 && rate > refRate * 1.6) add(1 + rate / Math.max(0.5, refRate), `조향을 급하게 꺾었습니다 (초당 ${pct(rate)}, 기준 랩은 ${pct(refRate)}). 패드는 스틱을 끝까지 빨리 밀기 쉬우니, 턴인을 조금 일찍 시작해 천천히 감으세요.`);
  // 직전에 트랙 밖·연석
  if (g.kind !== 'off' && W.some((x) => x.off)) add(2, `${verb} 직전에 트랙 밖(잔디·흙·자갈)을 밟았습니다. 거기서 그립을 잃었습니다.`);
  // 라인: 바깥으로 밀려 남은 폭이 없었다
  const off = lap.offset?.[k0];
  if (Number.isFinite(off) && corner.turn * off < -1.5) add(1.2, `기준 라인보다 ${(-corner.turn * off).toFixed(1)} m 바깥에 있었습니다. 남은 트랙 폭이 없어서 작은 실수도 이탈로 이어졌습니다.`);
  // 차가운 타이어
  if (cal.tire && s0.tire) {
    const tt = s0.tire.reduce((a, b) => a + b, 0) / s0.tire.length;
    if (tt < cal.tire - 12) add(1.5, `타이어 온도가 평소보다 ${(cal.tire - tt).toFixed(0)}°C 낮았습니다 (${tt.toFixed(0)}°C). 차가운 타이어는 그립이 낮습니다.`);
  }
  // 다른 차·충돌
  const imp = g.items.find((e) => e.kind === 'impact');
  if (imp) add(3, `충격이 감지됐고 직후 속도가 ${imp.drop.toFixed(0)} km/h 줄었습니다 (게임이 준 충격 세기 ${imp.mag}).`);
  const near = nearestCar(S, on);
  if (near && near.d < 8) add(2, `다른 차(${near.n || '?'})가 ${near.d.toFixed(1)} m 거리에 있었습니다. 접촉이나 더티 에어 영향일 수 있습니다.`);
  // 오버스티어 기록이 있으면 슬립 수치
  if (hasSlip) {
    const peak = Math.max(...S.slice(on, timeIdx(s0.t + 2)).map((x) => Math.abs(x.slip || 0)));
    g.peakSlip = peak;
  }
  causes.sort((a, b) => b.w - a.w);
  const name = { spin: g.items.some((e) => e.guessed) ? '스핀 (추정)' : '스핀', off: '트랙 이탈', impact: '충돌', slow: '큰 감속' }[g.kind];
  return {
    kind: g.kind, name, lap: lap.lap, t: s0.t - lap.samples[0].t, refIdx: k0, corner: corner.id, cornerIdx: A.corners.indexOf(corner),
    phase, loss, endIdx: endK, speed: s0.v * KMH, peakSlip: g.peakSlip ?? null,
    causes: causes.length ? causes.slice(0, 3).map((c) => c.text)
      : ['기록된 데이터(페달·조향·속도·라인)에서는 기준 랩과 뚜렷한 차이를 찾지 못했습니다. 노면·연석·바람처럼 기록되지 않는 요인일 수 있고, 저도 원인을 모르겠습니다.'],
    evidence: !hasSlip ? '이 기록에는 차체 미끄러짐 각도가 없어 페달·조향·속도로만 추정했습니다.' : '',
  };
}

// 시간 창 [t-sec, t] 안의 샘플
function windowAt(S, i, sec) {
  let a = i;
  while (a > 0 && S[a - 1].t >= S[i].t - sec) a--;
  return S.slice(a, i + 1);
}
// 0.1초 단위로 본 가장 빠른 조향 변화 (초당, 1 = 끝에서 끝의 절반)
function steerRate(W) {
  let r = 0;
  for (let j = 0, a = 0; j < W.length; j++) {
    while (W[j].t - W[a].t > 0.1) a++;
    const dt = W[j].t - W[a].t;
    if (dt >= 0.05 && Number.isFinite(W[j].steer) && Number.isFinite(W[a].steer)) r = Math.max(r, Math.abs(W[j].steer - W[a].steer) / dt);
  }
  return r;
}
const thrRise = (W) => {
  const last = W[W.length - 1]?.thr ?? 0;
  return last - Math.min(...W.map((x) => x.thr ?? 0));
};

function nearestCar(S, i) {
  for (let j = i; j >= Math.max(0, i - 30); j--) {
    const cs = S[j].cars;
    if (!cs) continue;
    let best = null;
    for (const o of cs) {
      if (o.pit) continue;
      const d = Math.hypot(o.x - S[i].x, o.z - S[i].z);
      if (!best || d < best.d) best = { d, n: o.n };
    }
    return best;
  }
  return null;
}
