// 트랙: 직선과 원호의 연속. 1 m 간격으로 곡률과 평면 좌표를 만든다.
// 모두 가상의 트랙이다. 실제 서킷 레이아웃은 정확한 자료가 없어 넣지 않았다.
// 구간: ['S', 길이] 직선 / ['R' 또는 'L', 반경, 각도(도)] 오른쪽·왼쪽 코너

export const TRACKS = {
  oval: {
    name: '오벌 (3.2 km)',
    segments: [['S', 800], ['L', 250, 180], ['S', 800], ['L', 250, 180]],
  },
  technical: {
    name: '테크니컬 서킷 (가상, 4.0 km)',
    segments: [
      ['S', 700], ['L', 40, 30], ['R', 40, 60], ['L', 40, 30], ['S', 300], ['R', 60, 90],
      ['S', 300], ['R', 150, 45], ['L', 150, 45], ['S', 200], ['R', 100, 90],
      ['S', 420], ['R', 35, 180], ['L', 35, 180], ['S', 300], ['R', 80, 90],
      ['S', 200], ['L', 120, 60], ['R', 120, 60], ['S', 175], ['R', 70, 90],
    ],
  },
  fast: {
    name: '고속 서킷 (가상, 6.3 km)',
    segments: [
      ['S', 1200], ['R', 30, 60], ['L', 30, 60], ['S', 300], ['R', 300, 90],
      ['S', 500], ['L', 45, 45], ['R', 45, 45], ['S', 300], ['R', 90, 45], ['S', 100], ['R', 110, 45],
      ['S', 1650], ['R', 200, 90], ['S', 1010], ['R', 150, 90],
    ],
  },
};

// 트랙이 정확히 닫히도록 직선 두 개의 길이를 조정한다.
// 방향이 고정이면 끝점 위치는 직선 길이에 대해 선형이라, 두 직선(방향이 평행하지 않은)으로 2×2 연립방정식을 풀면 된다.
// 모든 직선 쌍을 시도해 길이가 80 m 이상으로 유지되면서 변화가 가장 작은 해를 고른다.
function closeLoop(segments) {
  const heads = [];
  let h = 0;
  let ex = 0, ey = 0;
  for (const seg of segments) {
    if (seg[0] === 'S') {
      heads.push(h);
      ex += seg[1] * Math.cos(h);
      ey += seg[1] * Math.sin(h);
    } else {
      heads.push(null);
      const [dir, r, deg] = seg;
      const d = ((dir === 'L' ? 1 : -1) * deg * Math.PI) / 180;
      // 원호의 현 벡터
      const c = 2 * r * Math.sin(Math.abs(d) / 2);
      ex += c * Math.cos(h + d / 2);
      ey += c * Math.sin(h + d / 2);
      h += d;
    }
  }
  if (Math.hypot(ex, ey) < 1) return segments;
  let best = null;
  const idx = segments.map((sg, i) => (sg[0] === 'S' ? i : -1)).filter((i) => i >= 0);
  for (const a of idx) {
    for (const b of idx) {
      if (b <= a) continue;
      const ax = Math.cos(heads[a]), ay = Math.sin(heads[a]);
      const bx = Math.cos(heads[b]), by = Math.sin(heads[b]);
      const det = ax * by - ay * bx;
      if (Math.abs(det) < 0.2) continue;
      const da = (-ex * by + ey * bx) / det;
      const db = (-ax * ey + ay * ex) / det;
      const la = segments[a][1] + da;
      const lb = segments[b][1] + db;
      if (la < 80 || lb < 80) continue;
      const cost = Math.abs(da) + Math.abs(db);
      if (!best || cost < best.cost) best = { a, b, la, lb, cost };
    }
  }
  if (!best) return segments;
  const out = segments.map((sg) => sg.slice());
  out[best.a][1] = best.la;
  out[best.b][1] = best.lb;
  return out;
}

export function buildTrack(id) {
  const def = TRACKS[id];
  const segments = closeLoop(def.segments);
  const kappa = []; // 부호 있는 곡률 (왼쪽 +)
  for (const seg of segments) {
    if (seg[0] === 'S') {
      for (let i = 0; i < Math.round(seg[1]); i++) kappa.push(0);
    } else {
      const [dir, r, deg] = seg;
      const len = Math.round((r * deg * Math.PI) / 180);
      const k = (dir === 'L' ? 1 : -1) / r;
      for (let i = 0; i < len; i++) kappa.push(k);
    }
  }
  const N = kappa.length;
  const x = new Float32Array(N + 1);
  const y = new Float32Array(N + 1);
  let h = 0;
  for (let i = 0; i < N; i++) {
    x[i + 1] = x[i] + Math.cos(h);
    y[i + 1] = y[i] + Math.sin(h);
    h += kappa[i];
  }
  // 정수 m 반올림으로 남는 몇 m 오차만 지도에서 선형 보정
  const ex = x[N] - x[0];
  const ey = y[N] - y[0];
  for (let i = 0; i <= N; i++) {
    x[i] -= (ex * i) / N;
    y[i] -= (ey * i) / N;
  }
  return { id, name: def.name, length: N, kappa: Float32Array.from(kappa), x, y, closure: Math.hypot(ex, ey) };
}
