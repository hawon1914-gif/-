import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/physics.js';
import { CARS } from '../js/cars.js';
import { engineFor, torqueScale, engineTorque, rpmAt } from '../js/drivetrain.js';
import { buildTrack, TRACKS } from '../js/track.js';
import { createDriveSim } from '../js/drive.js';

const env = { rho: P.airDensity(20, 1013.25) };

test('토크 곡선의 최대 출력이 차량 출력과 같다', () => {
  for (const id of Object.keys(CARS)) {
    const eng = engineFor(id);
    const sc = torqueScale(eng, CARS[id].power);
    let best = 0;
    for (let rpm = eng.idle; rpm <= eng.redline; rpm += 50) best = Math.max(best, engineTorque(eng, sc, rpm, 1, 1) * rpm * 2 * Math.PI / 60);
    assert.ok(Math.abs(best / CARS[id].power - 1) < 0.01, id);
  }
});

test('모든 트랙이 닫힌다', () => {
  for (const id of Object.keys(TRACKS)) assert.ok(buildTrack(id).closure < 10, id);
});

test('AI는 이상 랩보다 느리지만 6% 안쪽, 트랙 이탈 없음', () => {
  const sim = createDriveSim(CARS.gt3, env, engineFor('gt3'), buildTrack('technical'));
  let off = false;
  for (let k = 0; k < 240 * 300 && sim.state.laps.length < 2; k++) {
    sim.step({ ai: true });
    if (sim.state.flags.offtrack > 0) off = true;
  }
  const lap = sim.state.laps[1];
  assert.ok(!off && lap.valid);
  assert.ok(lap.time > sim.ideal.time && lap.time < sim.ideal.time * 1.06, `${lap.time} vs ${sim.ideal.time}`);
});

test('F1 0-100 km/h가 현실 범위 (2~3.5초)', () => {
  const sim = createDriveSim(CARS.f1_2022, env, engineFor('f1_2022'), buildTrack('oval'));
  let t = null;
  for (let k = 0; k < 240 * 10 && t === null; k++) {
    sim.step({ throttle: 1, brake: 0, autoGear: true });
    if (P.toKmh(sim.state.v) >= 100) t = sim.state.t;
  }
  assert.ok(t > 2 && t < 3.5, String(t));
});

test('회전수가 레드존을 넘는 저단 변속은 거부된다', () => {
  const eng = engineFor('gt3');
  const sim = createDriveSim(CARS.gt3, env, eng, buildTrack('oval'));
  sim.state.gear = 4;
  sim.state.v = 60; // 216 km/h
  assert.ok(rpmAt(eng, 1, 60) > eng.redline);
  sim.step({ throttle: 0, brake: 0, shiftDown: true });
  sim.step({ throttle: 0, brake: 0, shiftDown: true });
  for (let k = 0; k < 40; k++) sim.step({ throttle: 0, brake: 0 });
  assert.ok(sim.state.gear >= 3);
});
