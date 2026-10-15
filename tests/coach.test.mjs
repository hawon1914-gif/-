import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/physics.js';
import { CARS } from '../js/cars.js';
import { engineFor } from '../js/drivetrain.js';
import { buildTrack } from '../js/track.js';
import { makeDemoSession } from '../js/coach-demo.js';
import { analyzeSession, coachLap, splitLaps } from '../js/coach.js';

const env = { rho: P.airDensity(20, 1013.25) };
const D = makeDemoSession(CARS.gt3, env, engineFor('gt3'), buildTrack('technical'), { laps: 6, seed: 23 });
const A = analyzeSession(D.samples);

test('랩 분리: 첫 랩(출발)과 끝나지 않은 마지막 랩은 뺀다', () => {
  const laps = splitLaps(D.samples);
  assert.ok(laps.length >= 5);
  assert.ok(!laps.some((l) => l.lap === 0));
});

test('코너를 검출하고 이론상 베스트는 베스트 랩보다 빠르거나 같다', () => {
  assert.ok(!A.error);
  assert.ok(A.corners.length >= 6, String(A.corners.length));
  assert.ok(A.theoretical <= A.best.time + 1e-6);
  // 코너 구간은 겹치지 않고 순서대로
  for (let k = 1; k < A.corners.length; k++) assert.ok(A.corners[k].from > A.corners[k - 1].from);
});

test('일찍 밟은 브레이크를 거리와 함께 찾는다', () => {
  const texts = A.laps.flatMap((l) => coachLap(A, l).tips.flatMap((t) => t.reasons));
  assert.ok(texts.some((t) => /m 일찍 밟았습니다/.test(t)));
  assert.ok(texts.some((t) => /흘러갔습니다|가속하지 않았습니다/.test(t)));
});

test('라인: 꼭짓점을 바깥으로 지나간 것과 일찍 꺾은 것을 찾는다', () => {
  const texts = A.laps.flatMap((l) => coachLap(A, l).tips.flatMap((t) => t.reasons));
  assert.ok(texts.some((t) => /꼭짓점에서 기준보다 [\d.]+ m 바깥/.test(t)));
  assert.ok(texts.some((t) => /너무 일찍 꺾어서/.test(t)));
  // 게임이 준 가로 위치로 안쪽 가장자리까지 거리도 함께 말한다
  assert.ok(texts.some((t) => /안쪽 가장자리까지 [\d.]+ m/.test(t)));
});

test('다른 차: 상대 랩을 만들고, 가까이 붙은 코너는 코칭에서 뺀다', () => {
  assert.ok(A.opponents.length >= 2);
  assert.ok(A.opponents.every((o) => o.best.R.n === A.ref.n));
  const flagged = A.laps.filter((l) => l.traffic.some(Boolean));
  assert.ok(flagged.length >= 1);
  for (const l of flagged) {
    const r = coachLap(A, l);
    l.traffic.forEach((tr, k) => { if (tr) assert.ok(!r.tips.some((t) => t.corner === A.corners[k].id)); });
  }
  // 상대 비교는 속도 지표만으로 동작
  const o = A.opponents.find((x) => x.cls === 'GT3');
  const r = coachLap(A, A.best, { lap: o.best, name: o.name });
  assert.ok(Array.isArray(r.tips));
});
