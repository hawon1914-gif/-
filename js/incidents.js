// 사고·실수 분석: 스핀, 트랙 이탈(잔디·자갈과 포장 런오프), 충돌, 트랙 위 정지를 찾아내고,
// 직전 몇 초의 조작으로 원인을 추정한다. 기준 랩이 있으면 같은 지점과 비교하고, 없으면(완주 랩이 없는 기록) 절대 기준만 쓴다.
// 원인은 데이터로 보이는 것만 말한다. 근거가 없으면 모른다고 말한다.

const KMH = 3.6;
const G = 9.81;
const pct = (x) => `${Math.round(x * 100)}%`;
const deg = (r) => (r * 180) / Math.PI;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function median(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[b.length >> 1];
}
function quantile(a, q) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(b.length * q))];
}

// 기록이 끊긴 곳 (시간 역행·0.5초 넘는 공백·순간이동) — 랩 분리와 같은 기준
export function isBreak(prev, s) {
  const dt = s.t - prev.t;
  const jump = Math.hypot(s.x - prev.x, s.z - prev.z);
  return dt <= 0 || dt > 0.5 || jump > 20 + Math.max(s.v, prev.v) * dt * 2;
}

// 위치로 구한 진행 방향·방향 변화율·곡률·횡G·종G. 샘플마다 _h(rad), _hr(rad/s), _k(1/m), _gy, _gx, _seg(끊김 없는 조각 번호)를 붙인다.
export function motion(S) {
  const n = S.length;
  const seg = new Int32Array(n);
  for (let i = 1; i < n; i++) seg[i] = seg[i - 1] + (isBreak(S[i - 1], S[i]) ? 1 : 0);
  for (let i = 0; i < n; i++) {
    let a = i, b = i;
    while (a > 0 && seg[a - 1] === seg[i] && S[i].t - S[a - 1].t <= 0.1) a--;
    while (b < n - 1 && seg[b + 1] === seg[i] && S[b + 1].t - S[i].t <= 0.1) b++;
    const dx = S[b].x - S[a].x, dz = S[b].z - S[a].z;
    S[i]._h = Math.hypot(dx, dz) > 0.3 ? Math.atan2(dz, dx) : NaN;
    S[i]._seg = seg[i];
  }
  for (let i = 0; i < n; i++) {
    let a = i, b = i;
    while (a > 0 && seg[a - 1] === seg[i] && S[i].t - S[a - 1].t <= 0.15) a--;
    while (b < n - 1 && seg[b + 1] === seg[i] && S[b + 1].t - S[i].t <= 0.15) b++;
    const dt = S[b].t - S[a].t;
    const ok = dt > 0.05 && Number.isFinite(S[a]._h) && Number.isFinite(S[b]._h);
    S[i]._hr = ok ? wrap(S[b]._h - S[a]._h) / dt : 0;
    S[i]._k = ok && S[i].v > 2 ? S[i]._hr / S[i].v : 0;
    S[i]._gy = (S[i].v * S[i]._hr) / G;
    S[i]._gx = dt > 0.05 ? (S[b].v - S[a].v) / dt / G : 0;
  }
}

// 세션 단위 보정: 조향 부호, 직진 시 뒷바퀴/앞바퀴 회전비, 평소 타이어 온도, 이 기록에서 낸 큰 횡G
export function calibrate(S) {
  let acc = 0;
  const ratios = [], temps = [], gys = [];
  for (const s of S) {
    if (s.v > 10 && s.gear > 0 && Number.isFinite(s.steer)) acc += s.steer * s._k;
    if (s.wr && s.v > 20 && Math.abs(s.steer ?? 0) < 0.05 && (s.brk ?? 0) < 0.03 && (s.thr ?? 1) < 0.5) {
      const f = (s.wr[0] + s.wr[1]) / 2, r = (s.wr[2] + s.wr[3]) / 2;
      if (f > 1) ratios.push(r / f);
    }
    if (s.tire && s.v > 20 && s.tire.every((x) => x > -200)) temps.push(s.tire.reduce((a, b) => a + b, 0) / s.tire.length);
    if (s.v > 15 && !s.off) gys.push(Math.abs(s._gy));
  }
  return { steerSign: acc >= 0 ? 1 : -1, wheel: median(ratios) || null, tire: median(temps) || null, gyMax: quantile(gys, 0.98) || null };
}

// ref (기준 랩이 있을 때): { A, refIdx(i), bestIdx[], offsetAt(i) }
export function findIncidents(S, cal, ref = null) {
  const n = S.length;
  const hasSlip = S.some((s) => Number.isFinite(s.slip) && s.slip !== 0);
  const moving = (s) => s.v > 2.5 && s.gear >= 0 && !s.pit;
  const wide = (x) => Number.isFinite(x.lat) && Number.isFinite(x.edge) && Math.abs(x.lat) > Math.abs(x.edge) + 0.5 && !x.off;
  const raw = [];
  for (let i = 1; i < n; i++) {
    const s = S[i], p = S[i - 1];
    if (s._seg !== p._seg || s.pit) continue;
    // 스핀: 슬립 각도가 있으면 25° 초과. 없으면 진행 방향이 초당 70° 넘게 돌면서 속도가 떨어지는 경우
    // (보통 코너는 초당 30~40°, 헤어핀도 50° 안팎이라 이보다 빠른 회전은 차가 돈 것이다)
    if (moving(s) && (hasSlip ? Math.abs(s.slip) > 25 : Math.abs(s._hr) > 1.22 && s._gx < -0.3)) raw.push({ kind: 'spin', i });
    // 트랙 이탈: 두 바퀴 이상 잔디·흙·자갈
    if (s.off && !p.off) raw.push({ kind: 'off', i });
    // 포장 런오프·연석 바깥: 게임의 가로 위치가 가장자리를 0.5 m 넘음 (가장자리 값의 부호는 차가 있는 쪽을 따른다)
    if (moving(s) && wide(s) && !wide(p)) raw.push({ kind: 'wide', i });
    // 충돌: 게임이 준 충격, 또는 브레이크 없이 1.2 g 넘는 급감속
    if (s.imp) raw.push({ kind: 'impact', i, mag: s.imp });
    else if (moving(p) && s._gx < -1.2 && (s.brk ?? 0) < 0.3) raw.push({ kind: 'impact', i, guessed: true });
    // 트랙 위 정지: 달리다가 2초 넘게 멈춤 (피트 제외)
    if (s.v < 0.3 && p.v >= 0.3) {
      let j = i;
      while (j < n - 1 && S[j + 1]._seg === s._seg && S[j + 1].v < 0.3) j++;
      const before = S.slice(Math.max(0, i - 600), i).some((x) => x.v > 10 && x._seg === s._seg);
      if (S[j].t - s.t > 2 && before) raw.push({ kind: 'stop', i });
    }
  }
  raw.sort((a, b) => a.i - b.i);
  // 3초 안에 이어지는 것은 한 사건으로 묶는다. 대표 종류: 스핀 > 충돌 > 이탈 > 런오프 > 정지
  const rank = { spin: 5, impact: 4, off: 3, wide: 2, stop: 1 };
  const groups = [];
  for (const e of raw) {
    const g = groups[groups.length - 1];
    if (g && S[e.i]._seg === S[g.last]._seg && S[e.i].t - S[g.last].t < 3) {
      g.items.push(e); g.last = e.i;
      if (rank[e.kind] > rank[g.kind]) g.kind = e.kind;
    } else groups.push({ kind: e.kind, first: e.i, last: e.i, items: [e] });
  }
  // 사고 뒤 트랙으로 돌아오는 동안(후진·제자리 회전·잔디 위 저속 주행)의 이탈은 새 실수가 아니므로 앞 사고에 묶는다.
  // 복귀 = 같은 조각에서 트랙 위·전진 기어·54 km/h 이상으로 1초 이상 달린 시점
  const out = [];
  let recoverAt = -Infinity, last = null;
  for (const g of groups) {
    // 복귀 중의 저속 이탈(후진 직후이거나 54 km/h 미만)은 앞 사고에 묶는다. 스핀·충돌·정지는 따로 분석한다.
    const reversing = windowAt(S, g.first, 5).some((x) => x.gear < 0);
    const minor = (g.kind === 'off' || g.kind === 'wide') && (reversing || S[g.first].v < 15);
    if (minor && S[g.first].t < recoverAt && last && S[g.first]._seg === last.seg) { last.g.items.push(...g.items); continue; }
    let j = g.last, okFrom = -1;
    while (j < n - 1 && S[j + 1]._seg === S[g.last]._seg) {
      j++;
      const x = S[j];
      const good = x.v > 15 && !x.off && !wide(x) && x.gear > 0;
      if (!good) okFrom = -1;
      else if (okFrom < 0) okFrom = j;
      else if (x.t - S[okFrom].t > 1) break;
    }
    const ended = j >= n - 1 || S[j + 1]?._seg !== S[g.last]._seg;
    g.recovered = okFrom >= 0 && !ended ? S[okFrom].t : null;
    g.endedAfter = ended && S[j].t - S[g.last].t < 5; // 직후 기록이 끊김 (차고 복귀·리셋)
    recoverAt = g.recovered ?? (S[g.first].v > 15 && g.kind !== 'stop' && g.kind !== 'spin' ? S[g.last].t + 3 : Infinity);
    last = { g, seg: S[g.first]._seg };
    out.push(g);
  }
  return out.map((g) => explain(S, g, cal, ref, hasSlip));
}

function windowAt(S, i, sec) {
  let a = i;
  while (a > 0 && S[a - 1]._seg === S[i]._seg && S[a - 1].t >= S[i].t - sec) a--;
  return S.slice(a, i + 1);
}
function steerRate(W) {
  let r = 0;
  for (let j = 0, a = 0; j < W.length; j++) {
    while (W[j].t - W[a].t > 0.1) a++;
    const dt = W[j].t - W[a].t;
    if (dt >= 0.05 && Number.isFinite(W[j].steer) && Number.isFinite(W[a].steer)) r = Math.max(r, Math.abs(W[j].steer - W[a].steer) / dt);
  }
  return r;
}

function explain(S, g, cal, ref, hasSlip) {
  // 랩 조각처럼 기준 랩 위치를 모르는 곳이면 절대 기준만
  if (ref && ref.refIdx(g.first) < 0) ref = null;
  // 시작 시점: 첫 신호에서 거슬러 올라가며 흐트러지기 시작한 곳 (최대 2초)
  let on = g.first;
  const lim = S[g.first].t - 2;
  const unsettled = (x) => (hasSlip ? Math.abs(x.slip) > 8 : Math.abs(x._hr) > 0.9 && x._gx < -0.2);
  while (on > 0 && S[on - 1]._seg === S[on]._seg && S[on - 1].t > lim && unsettled(S[on - 1])) on--;
  const s0 = S[on];
  const verb = { spin: '차가 돌기', off: '트랙을 벗어나기', wide: '트랙 밖으로 밀려나기', impact: '충격', stop: '멈추기' }[g.kind];
  const causes = [];
  const add = (w, text) => causes.push({ w, text });
  const W2 = windowAt(S, on, 2), W1 = windowAt(S, on, 1), W07 = windowAt(S, on, 0.7);
  const turning = Math.abs(s0.steer ?? 0) > 0.1 || Math.abs(s0._k) > 1 / 300;

  // 기준 랩 비교 (있을 때)
  let k0 = -1, B = null, bj = 0, loss = null, endIdx = null, corner = null, phase = '';
  const R = ref?.A.ref;
  if (ref) {
    k0 = ref.refIdx(on);
    const { A } = ref;
    corner = A.corners.find((c) => k0 >= c.from && k0 <= c.to) || A.corners.reduce((a, c) => (Math.abs(c.apex - k0) < Math.abs(a.apex - k0) ? c : a));
    phase = k0 < corner.entry ? '제동 구간' : k0 < corner.apex - 5 ? '코너 진입' : k0 <= corner.apex + 15 ? '꼭짓점 부근' : '코너 탈출';
    B = A.best.samples;
    for (let j = 0; j < B.length; j++) if (Math.abs(ref.bestIdx[j] - k0) < Math.abs(ref.bestIdx[bj] - k0)) bj = j;
    // 손해: 사고 시작부터 기준 속도의 95%로 회복할 때까지 걸린 시간 − 기준 랩이 같은 구간에 쓴 시간
    let j = on;
    while (j < S.length - 1 && S[j + 1]._seg === s0._seg && S[j + 1].lap === s0.lap) {
      const k = ref.refIdx(j);
      if (k > k0 + 20 && S[j].v >= R.v[k] * 0.95) break;
      if (S[j].t - s0.t > 180) break;
      j++;
    }
    endIdx = Math.max(k0, ref.refIdx(j));
    if (endIdx > k0) loss = (S[j].t - s0.t) - (R.t[endIdx] - R.t[k0]);
  }
  const BW = (sec) => (B ? windowAt(B, bj, sec) : null);

  // 진입 속도 (기준 랩 있을 때만)
  if (R && g.kind !== 'stop') {
    const dv = (s0.v - R.v[k0]) * KMH;
    if (dv > 4 && phase !== '코너 탈출') add(dv / 4, `같은 지점에서 기준 랩보다 ${dv.toFixed(0)} km/h 빨랐습니다 (${(s0.v * KMH).toFixed(0)} vs ${(R.v[k0] * KMH).toFixed(0)} km/h). 브레이크를 조금 더 일찍 또는 강하게.`);
  }
  // 그립 한계: 이 기록에서 낸 가장 큰 횡G 근처였다
  const gyNow = Math.max(...W07.map((x) => Math.abs(x._gy)));
  if (cal.gyMax && cal.gyMax > 0.5 && gyNow > cal.gyMax * 0.9 && g.kind !== 'stop' && s0.v > 8) add(1.5, `직전 횡G가 ${gyNow.toFixed(1)} g로 이 기록에서 낸 최대치(${cal.gyMax.toFixed(1)} g) 근처였습니다. 타이어가 한계였고, 속도가 조금만 높아도 버티지 못합니다.`);
  // 스로틀을 급하게·많이
  const thrMin = Math.min(...W07.map((x) => x.thr ?? 0));
  const rise = (s0.thr ?? 0) - thrMin;
  const bw07 = BW ? BW(0.7) : null;
  const refRise = bw07 ? (bw07[bw07.length - 1].thr ?? 0) - Math.min(...bw07.map((x) => x.thr ?? 0)) : 0;
  const tr = B ? B[bj].thr ?? 0 : null;
  if ((s0.thr ?? 0) > 0.45 && rise > 0.35 && turning && (!B || rise > refRise + 0.3 || s0.thr > tr + 0.25)) {
    add(1.5 + rise * 2, `${verb} 직전에 조향이 남은 상태(${pct(Math.abs(s0.steer ?? 0))})에서 스로틀을 ${pct(thrMin)}→${pct(s0.thr)}로 열었습니다${B ? ` (기준 랩은 같은 지점에서 ${pct(tr)})` : ''}. 핸들을 푸는 만큼만 천천히 여세요.`);
  }
  // 조향을 많이 감은 채 가속: 앞이 밀린다 (런오프·이탈일 때)
  if (g.kind === 'wide' || g.kind === 'off') {
    const x = windowAt(S, on, 2.5).find((y) => (y.thr ?? 0) > 0.4 && Math.abs(y.steer ?? 0) > 0.5);
    if (x) add(2, `조향을 ${pct(Math.abs(x.steer))}까지 감은 채 스로틀 ${pct(x.thr)}로 가속했습니다. 앞 타이어가 조향과 가속을 함께 감당하지 못해 바깥으로 밀렸습니다(언더스티어). 꼭짓점에서 차를 먼저 돌려 핸들을 푼 뒤 가속하세요.`);
  }
  // 휠스핀·잠김 (바퀴 회전비를 직진 때 값과 비교)
  if (cal.wheel && s0.wr) {
    const ratio = (w) => ((w[2] + w[3]) / 2) / Math.max(1, (w[0] + w[1]) / 2) / cal.wheel;
    const rs = W1.filter((x) => x.wr).map((x) => ratio(x.wr));
    const hi = Math.max(...rs), lo = Math.min(...rs);
    const braking = W1.some((x) => (x.brk ?? 0) > 0.2);
    if (hi > 1.08 && (s0.thr ?? 0) > 0.3) add(2 + (hi - 1) * 10, `뒷바퀴가 앞바퀴보다 ${((hi - 1) * 100).toFixed(0)}% 빨리 돌았습니다 (휠스핀). 뒤 타이어가 횡 그립을 잃었습니다.`);
    if (lo < 0.9 && braking) add(2 + (1 - lo) * 10, `제동 중 뒷바퀴가 앞바퀴보다 ${((1 - lo) * 100).toFixed(0)}% 느리게 돌았습니다 (뒷바퀴 잠김). 브레이크 밸런스가 뒤로 가 있거나 다운시프트가 너무 빨랐을 수 있습니다.`);
    if (hi > 1.12 && braking) add(2, '제동 중 앞바퀴가 거의 멈췄습니다 (앞바퀴 잠김). 초기 제동은 강하게, 회전하면서는 브레이크를 풀어 주세요.');
  }
  // 리프트오프
  const thrPrev = Math.max(...W1.slice(0, -12).map((x) => x.thr ?? 0), 0);
  const bw1 = BW ? BW(1) : null;
  const refLift = bw1 ? Math.max(...bw1.slice(0, -12).map((x) => x.thr ?? 0), 0) - (B[bj].thr ?? 0) : 0;
  if (thrPrev > 0.7 && (s0.thr ?? 0) < 0.2 && turning && (s0.brk ?? 0) < 0.2 && refLift < 0.4 && s0.v > 8) add(2.5, `코너 안에서 스로틀을 ${pct(thrPrev)}에서 갑자기 뗐습니다. 하중이 앞으로 쏠려 리어가 가벼워지는 리프트오프 오버스티어입니다. 떼야 하면 천천히.`);
  // 회전 중 제동
  const tb = B ? B[bj].brk ?? 0 : null;
  if ((s0.brk ?? 0) > 0.4 && Math.abs(s0.steer ?? 0) > 0.25 && (!B || s0.brk > tb + 0.2)) add(1.5 + s0.brk * 2, `조향 ${pct(Math.abs(s0.steer))} 상태에서 브레이크가 ${pct(s0.brk)}였습니다${B ? ` (기준 랩 ${pct(tb)})` : ''}. 회전 중 강한 제동은 리어 하중을 빼서 차를 돌게 만듭니다. 직선에서 더 세게 밟고 턴인하면서 푸세요.`);
  // 다운시프트
  for (let j = on; j > 0 && S[j].t > s0.t - 1 && S[j - 1]._seg === S[j]._seg; j--) {
    if (S[j].gear > 0 && S[j - 1].gear > S[j].gear) {
      const over = S[j].maxRpm && S[j].rpm > S[j].maxRpm * 0.92;
      add(over ? 3 : 1.2, `${verb} ${(s0.t - S[j].t).toFixed(1)}초 전에 ${S[j - 1].gear}→${S[j].gear}단으로 내렸습니다${over ? ` (회전수 ${S[j].rpm}/${S[j].maxRpm}, 한계 근처)` : ''}. 엔진 브레이크가 뒷바퀴를 붙잡았을 수 있습니다. 속도가 더 떨어진 뒤 내리세요.`);
      break;
    }
  }
  // 급조향
  const rate = steerRate(W1);
  const refRate = bw1 ? steerRate(bw1) : 0;
  if (rate > 1.5 && (!B ? rate > 3 : rate > refRate * 1.6)) add(1 + rate / Math.max(0.5, refRate || 1.5), `조향을 급하게 꺾었습니다 (초당 ${pct(rate)}${B ? `, 기준 랩은 ${pct(refRate)}` : ''}). 패드는 스틱을 빨리 끝까지 밀기 쉬우니, 턴인을 조금 일찍 시작해 천천히 감으세요.`);
  // 중립 기어로 굴러감
  const neutral = W2.filter((x) => x.gear === 0 && x.v > 3).length;
  if (W2.length > 10 && neutral / W2.length > 0.6) add(2.5, `${verb} 전 ${(W2[W2.length - 1].t - W2[0].t).toFixed(1)}초 동안 기어가 중립(N)이었습니다. 엔진 브레이크도 구동도 없이 굴러간 상태라 차를 제어할 수 없었습니다.`);
  // 입력 없음
  const idle = W2.filter((x) => (x.thr ?? 0) < 0.05 && (x.brk ?? 0) < 0.05 && Math.abs(x.steer ?? 0) < 0.05).length;
  if (W2.length > 10 && idle / W2.length > 0.9 && s0.v > 5) add(2.5, `${verb} 전 2초 동안 페달·조향 입력이 거의 없었습니다 (${(s0.v * KMH).toFixed(0)} km/h로 굴러가는 중). 손을 뗐거나 게임 메뉴가 열려 있었을 수 있습니다.`);
  // 직전 트랙 밖
  if (g.kind !== 'off' && W1.slice(0, -1).some((x) => x.off)) add(2, `${verb} 직전에 트랙 밖(잔디·흙·자갈)을 밟았습니다. 거기서 그립을 잃었습니다.`);
  // 가장자리를 넘은 거리
  let over = null;
  if ((g.kind === 'wide' || g.kind === 'off') && Number.isFinite(s0.lat)) {
    const ds = S.slice(on, Math.min(S.length, on + 300)).filter((x) => x._seg === s0._seg && Number.isFinite(x.lat) && Number.isFinite(x.edge)).map((x) => Math.abs(x.lat) - Math.abs(x.edge));
    if (ds.length) over = Math.max(...ds);
  }
  // 차가운 타이어 (절대 기준 60°C. 적정 온도는 차마다 다르고 LMU의 정확한 값은 모른다)
  if (s0.tire && s0.tire.every((x) => x > -200)) {
    const tt = s0.tire.reduce((a, b) => a + b, 0) / s0.tire.length;
    if (tt < 60) add(1.8, `타이어가 ${tt.toFixed(0)}°C로 차가웠습니다. 레이스 타이어는 이보다 훨씬 뜨거워야 제 그립이 나옵니다 (아웃랩 초반이면 브레이크도 차갑습니다). 첫 바퀴는 제동을 일찍, 코너 속도는 낮게 잡으세요.`);
    else if (cal.tire && tt < cal.tire - 12) add(1.5, `타이어 온도가 평소보다 ${(cal.tire - tt).toFixed(0)}°C 낮았습니다 (${tt.toFixed(0)}°C).`);
  }
  // 충돌
  const imp = g.items.find((e) => e.kind === 'impact');
  if (imp) {
    const j = Math.min(S.length - 1, imp.i + 30);
    const drop = (S[Math.max(0, imp.i - 3)].v - S[j].v) * KMH;
    add(3, imp.guessed ? `브레이크 없이 속도가 갑자기 ${drop.toFixed(0)} km/h 줄었습니다. 벽·방호벽·다른 차에 부딪힌 것으로 보입니다.` : `충격이 감지됐고 직후 속도가 ${drop.toFixed(0)} km/h 줄었습니다 (게임이 준 충격 세기 ${imp.mag}).`);
  }
  const near = nearestCar(S, on);
  if (near && near.d < 8) add(2, `다른 차(${near.n || '?'})가 ${near.d.toFixed(1)} m 거리에 있었습니다. 접촉이나 더티 에어 영향일 수 있습니다.`);
  // 라인 (기준 랩 있을 때)
  if (ref && corner && ref.offsetAt) {
    const off = ref.offsetAt(on);
    if (Number.isFinite(off) && corner.turn * off < -1.5) add(1.2, `기준 라인보다 ${(-corner.turn * off).toFixed(1)} m 바깥에 있었습니다. 남은 트랙 폭이 없어서 작은 실수도 이탈로 이어졌습니다.`);
  }
  // 정지
  if (g.kind === 'stop' && W2.some((x) => (x.brk ?? 0) > 0.8)) add(1, `브레이크를 끝까지 밟아 멈췄습니다. 왜 멈췄는지는 기록에 없습니다.`);

  const peakSlip = hasSlip ? Math.max(...S.slice(on, Math.min(S.length, on + 180)).map((x) => Math.abs(x.slip || 0))) : null;
  // 진행 방향이 얼마나 돌았나 (스핀 크기)
  let turned = 0;
  if (g.kind === 'spin') {
    const e = Math.min(S.length - 1, g.last + 60);
    for (let j = on + 1; j <= e; j++) if (S[j]._seg === s0._seg && Number.isFinite(S[j]._h) && Number.isFinite(S[j - 1]._h)) turned += wrap(S[j]._h - S[j - 1]._h);
  }
  if (g.endedAfter) add(0.5, '직후 기록이 끊겼습니다 (차고로 돌아가거나 리셋한 것으로 보입니다).');
  causes.sort((a, b) => b.w - a.w);
  const guessed = g.items.every((e) => e.guessed) && g.kind === 'impact';
  const name = { spin: hasSlip ? '스핀' : '스핀 (위치로 추정)', off: '트랙 이탈', wide: '트랙 밖으로 밀림', impact: guessed ? '충돌 (추정)' : '충돌', stop: '트랙 위 정지' }[g.kind];
  return {
    kind: g.kind, name, lap: s0.lap, t: s0.t, sample: on, refIdx: k0, corner: corner?.id ?? null, cornerIdx: corner ? ref.A.corners.indexOf(corner) : -1,
    phase, loss, endIdx, speed: s0.v * KMH, peakSlip, turned: Math.abs(deg(turned)), over, lapDist: s0.lapDist,
    x: s0.x, z: s0.z, recovery: g.recovered ? g.recovered - s0.t : null, extra: g.items.length,
    causes: causes.length ? causes.slice(0, 4).map((c) => c.text)
      : ['기록된 데이터(페달·조향·속도·위치)에서는 원인을 찾지 못했습니다. 노면·연석처럼 기록되지 않는 요인일 수 있고, 저도 원인을 모르겠습니다.'],
    evidence: hasSlip ? '' : '이 기록에는 차체 미끄러짐 각도·바퀴 회전이 없어(이전 브리지) 위치·페달·조향으로만 판단했습니다.',
  };
}

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
