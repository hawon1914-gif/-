// 트랙 지도 자동 생성: 게임은 트랙 모양을 주지 않으므로
//  1) 공개된 실제 서킷 모양(track-shapes.js)을 주행 위치에 자동으로 맞추거나 (게임 랩 거리 + 위치로 회전·축척·시작점·방향을 찾는다)
//  2) 나와 다른 차들이 지나간 위치를 랩 거리별로 모아 만든다 (온라인·AI 세션이면 한 바퀴 돌기 전에 완성된다).
import { TRACK_SHAPES } from './track-shapes.js';

export function findShape(trackName) {
  const n = String(trackName || '').toLowerCase();
  if (!n) return null;
  return TRACK_SHAPES.find((s) => new RegExp(s.match, 'i').test(n)) || null;
}

// 모양 점들 → { n, x[], y[] }
function shapeArrays(shape, mirror) {
  const n = shape.pts.length / 2;
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = shape.pts[2 * i]; y[i] = mirror * shape.pts[2 * i + 1]; }
  return { n, x, y };
}

// 2차원 닮음 변환 (회전·축척·이동) 최소제곱: p ≈ s·R·q + t
function fitSimilarity(qx, qy, px, py) {
  const m = qx.length;
  let cqx = 0, cqy = 0, cpx = 0, cpy = 0;
  for (let k = 0; k < m; k++) { cqx += qx[k]; cqy += qy[k]; cpx += px[k]; cpy += py[k]; }
  cqx /= m; cqy /= m; cpx /= m; cpy /= m;
  let sxx = 0, sxy = 0, syx = 0, syy = 0, qq = 0;
  for (let k = 0; k < m; k++) {
    const ax = qx[k] - cqx, ay = qy[k] - cqy, bx = px[k] - cpx, by = py[k] - cpy;
    sxx += ax * bx; sxy += ax * by; syx += ay * bx; syy += ay * by; qq += ax * ax + ay * ay;
  }
  const th = Math.atan2(sxy - syx, sxx + syy);
  const c = Math.cos(th), sn = Math.sin(th);
  const s = (c * (sxx + syy) + sn * (sxy - syx)) / (qq || 1);
  const tx = cpx - s * (c * cqx - sn * cqy), ty = cpy - s * (sn * cqx + c * cqy);
  let err = 0;
  for (let k = 0; k < m; k++) {
    const ex = s * (c * qx[k] - sn * qy[k]) + tx - px[k], ey = s * (sn * qx[k] + c * qy[k]) + ty - py[k];
    err += ex * ex + ey * ey;
  }
  return { s, c, sn, tx, ty, rms: Math.sqrt(err / m) };
}

// obs: [{ x, z, ld }] 게임 위치와 랩 거리. trackLen: 게임이 준 트랙 길이.
// 결과: { layout: { x[], z[] } (결승선부터 진행 방향, 5 m 간격, 게임 좌표), rms } 또는 null
export function alignShape(shape, obs, trackLen) {
  if (!shape || !trackLen || obs.length < 20) return null;
  // 랩 거리 범위가 너무 좁으면 모양을 구분할 수 없다
  const bins = new Set(obs.map((o) => Math.floor((o.ld / trackLen) * 20)));
  if (bins.size < 5) return null;
  const sample = obs.length > 240 ? obs.filter((o, i) => i % Math.ceil(obs.length / 240) === 0) : obs;
  const m = sample.length;
  const px = sample.map((o) => o.x), py = sample.map((o) => o.z);
  const cands = [];
  for (const mirror of [1, -1]) {
    const B = shapeArrays(shape, mirror);
    const at = (s) => {
      const u = ((s % B.n) + B.n) % B.n, i = Math.floor(u), f = u - i, j = (i + 1) % B.n;
      return [B.x[i] + (B.x[j] - B.x[i]) * f, B.y[i] + (B.y[j] - B.y[i]) * f];
    };
    for (const dir of [1, -1]) {
      const fit = (o) => {
        const qx = new Float64Array(m), qy = new Float64Array(m);
        for (let k = 0; k < m; k++) { const [a, b] = at(o + dir * (sample[k].ld / trackLen) * B.n); qx[k] = a; qy[k] = b; }
        return fitSimilarity(qx, qy, px, py);
      };
      let best = null;
      for (let o = 0; o < B.n; o += 2) { const f = fit(o); if (!best || f.rms < best.f.rms) best = { o, f }; }
      // 시작점 미세 조정
      for (let o = best.o - 2; o <= best.o + 2; o += 0.25) { const f = fit(o); if (f.rms < best.f.rms) best = { o, f }; }
      cands.push({ mirror, dir, B, at, ...best });
    }
  }
  cands.sort((a, b) => a.f.rms - b.f.rms);
  const b = cands[0];
  // 맞춤이 충분히 좋고(15 m 이내), 축척이 실제 길이와 비슷하고, 다른 해석보다 확실히 나아야 받아들인다
  if (b.f.rms > 15 || b.f.s < 0.85 || b.f.s > 1.15 || (cands[1] && cands[1].f.rms < b.f.rms * 1.6)) return null;
  const { s, c, sn, tx, ty } = b.f;
  const n = b.B.n;
  const x = [], z = [];
  for (let i = 0; i < n; i++) {
    const [qx, qy] = b.at(b.o + b.dir * i);
    x.push(s * (c * qx - sn * qy) + tx);
    z.push(s * (sn * qx + c * qy) + ty);
  }
  return { layout: { x, z, step: 5, source: shape.name }, rms: b.f.rms };
}

// 랩 거리 5 m 칸마다 지나간 위치의 평균. 칸이 97% 이상 채워지면(짧은 빈칸은 이어서) 지도로 쓴다.
export function makeBins(trackLen) {
  const n = Math.max(10, Math.round(trackLen / 5));
  return { n, len: trackLen, sx: new Float64Array(n), sz: new Float64Array(n), cnt: new Uint16Array(n), filled: 0 };
}
export function addBin(bins, x, z, ld) {
  if (!Number.isFinite(ld) || ld < 0 || ld > bins.len * 1.02) return;
  const i = Math.min(bins.n - 1, Math.floor((ld / bins.len) * bins.n));
  if (bins.cnt[i] >= 50) return;
  if (!bins.cnt[i]) bins.filled++;
  bins.sx[i] += x; bins.sz[i] += z; bins.cnt[i]++;
}
export function binsToObs(bins) {
  const out = [];
  for (let i = 0; i < bins.n; i++) if (bins.cnt[i]) out.push({ x: bins.sx[i] / bins.cnt[i], z: bins.sz[i] / bins.cnt[i], ld: ((i + 0.5) / bins.n) * bins.len });
  return out;
}
export function layoutFromBins(bins) {
  if (bins.filled < bins.n * 0.97) return null;
  const x = new Array(bins.n), z = new Array(bins.n);
  const idx = [];
  for (let i = 0; i < bins.n; i++) if (bins.cnt[i]) { x[i] = bins.sx[i] / bins.cnt[i]; z[i] = bins.sz[i] / bins.cnt[i]; idx.push(i); }
  // 빈칸은 앞뒤 채워진 칸 사이를 잇는다 (한 바퀴를 돌아 이어지는 것까지)
  for (let k = 0; k < idx.length; k++) {
    const a = idx[k], b = idx[(k + 1) % idx.length];
    const gap = (b - a + bins.n) % bins.n;
    if (gap > 12) return null; // 60 m 넘게 빈 곳이 있으면 아직 아니다
    for (let g = 1; g < gap; g++) { const i = (a + g) % bins.n, f = g / gap; x[i] = x[a] + (x[b] - x[a]) * f; z[i] = z[a] + (z[b] - z[a]) * f; }
  }
  // 위치 잡음을 조금 다듬는다
  const sm = (arr) => arr.map((v, i) => { let s = 0; for (let k = -2; k <= 2; k++) s += arr[(i + k + arr.length) % arr.length]; return s / 5; });
  return { x: sm(x), z: sm(z), step: 5, source: '주행 기록' };
}

// 모양만으로 코너 위치 찾기 (속도 기록이 없는 지도용): 100 m 안에서 25° 넘게 도는 곳의 가운데
export function cornersFromShape(L) {
  const n = L.x.length, step = L.step || 5;
  const w = Math.max(2, Math.round(15 / step));
  const head = (i) => { const a = (i - w + n) % n, b = (i + w) % n; return Math.atan2(L.z[b] - L.z[a], L.x[b] - L.x[a]); };
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) { let d = head((i + 1) % n) - head(i); d = Math.atan2(Math.sin(d), Math.cos(d)); turn[i] = d; }
  const win = Math.round(100 / step);
  const tot = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -win / 2; k <= win / 2; k++) s += turn[(i + k + n) % n]; tot[i] = Math.abs(s); }
  const out = [];
  const sep = Math.round(120 / step);
  const order = [...tot.keys()].sort((a, b) => tot[b] - tot[a]);
  for (const i of order) {
    if (tot[i] < (25 * Math.PI) / 180) break;
    if (out.some((j) => Math.min(Math.abs(j - i), n - Math.abs(j - i)) < sep)) continue;
    out.push(i);
  }
  return out.sort((a, b) => a - b).map((i, k) => ({ id: k + 1, i }));
}
