import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACK_SHAPES } from '../js/track-shapes.js';
import { findShape, alignShape, makeBins, addBin, binsToObs, layoutFromBins, cornersFromShape } from '../js/track-maps.js';

// 게임 좌표 흉내: 모양을 임의로 회전·이동·좌우 반전하고, 결승선 위치와 진행 방향도 바꾼다
function fakeGame(shape, { rot, mirror, start, dir, noise = 1.5 }) {
  const n = shape.pts.length / 2;
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (i) => {
    const k = ((start + dir * i) % n + n) % n;
    const x = shape.pts[2 * k], y = mirror * shape.pts[2 * k + 1];
    return { x: c * x - s * y + 1234, z: s * x + c * y - 567 };
  };
  const len = shape.len * 1.01; // 게임 길이는 조금 다를 수 있다
  return { P, n, len };
}

test('트랙 이름으로 모양 찾기', () => {
  assert.equal(findShape('Autodromo Nazionale Monza').id, 'monza');
  assert.equal(findShape('Circuit de Spa-Francorchamps').id, 'spa');
  assert.equal(findShape('Bahrain International Circuit').id, 'bahrain');
  assert.equal(findShape('Fuji Speedway'), null);
});

test('모양을 게임 좌표에 맞춘다 (회전·반전·시작점·방향 모름, 한 바퀴의 30%만 달린 상태)', () => {
  for (const id of ['monza', 'spa', 'imola']) {
    const shape = TRACK_SHAPES.find((t) => t.id === id);
    const g = fakeGame(shape, { rot: 1.1, mirror: -1, start: 200, dir: -1 });
    const obs = [];
    for (let i = 0; i < g.n * 0.3; i += 2) {
      const p = g.P(i);
      obs.push({ x: p.x + (Math.random() - 0.5) * 3, z: p.z + (Math.random() - 0.5) * 3, ld: (i / g.n) * g.len });
    }
    const r = alignShape(shape, obs, g.len);
    assert.ok(r, id);
    assert.ok(r.rms < 6, `${id} rms ${r.rms}`);
    // 맞춘 지도의 0번 점 = 결승선, 진행 방향도 같아야 한다
    const p0 = g.P(0), p10 = g.P(10);
    assert.ok(Math.hypot(r.layout.x[0] - p0.x, r.layout.z[0] - p0.z) < 15, id);
    assert.ok(Math.hypot(r.layout.x[10] - p10.x, r.layout.z[10] - p10.z) < 15, id);
  }
});

test('다른 서킷 위치로는 맞추지 않는다', () => {
  const monza = TRACK_SHAPES.find((t) => t.id === 'monza'), spa = TRACK_SHAPES.find((t) => t.id === 'spa');
  const g = fakeGame(spa, { rot: 0.3, mirror: 1, start: 0, dir: 1 });
  const obs = [];
  for (let i = 0; i < g.n * 0.5; i += 3) { const p = g.P(i); obs.push({ x: p.x, z: p.z, ld: (i / g.n) * g.len }); }
  assert.equal(alignShape(monza, obs, g.len), null);
});

test('다른 차·내 위치를 랩 거리별로 모아 지도를 만들고 코너를 찾는다', () => {
  const shape = TRACK_SHAPES.find((t) => t.id === 'bahrain');
  const g = fakeGame(shape, { rot: 0, mirror: 1, start: 0, dir: 1 });
  const bins = makeBins(g.len);
  for (let i = 0; i < g.n; i += 1) { const p = g.P(i); addBin(bins, p.x, p.z, (i / g.n) * g.len); }
  const L = layoutFromBins(bins);
  assert.ok(L);
  assert.ok(binsToObs(bins).length > 1000);
  const cs = cornersFromShape(L);
  assert.ok(cs.length >= 10 && cs.length <= 18, String(cs.length)); // 바레인은 15개 코너
});
