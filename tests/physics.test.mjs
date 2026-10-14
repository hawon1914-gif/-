import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/physics.js';
import { CARS } from '../js/cars.js';

const env = { rho: P.airDensity(20, 1013.25) };

test('표준 대기 밀도', () => {
  assert.ok(Math.abs(P.airDensity(15, 1013.25) - 1.225) < 0.002);
});

test('강체 에어로에서 다운포스는 속도 제곱에 비례', () => {
  const car = CARS.gt3;
  const a = P.aeroState(car, env, { v: 40, platform: false });
  const b = P.aeroState(car, env, { v: 80, platform: false });
  assert.ok(Math.abs(b.df / a.df - 4) < 1e-6);
});

test('브레이킹 시 하중이 앞으로 이동하고 노즈가 내려간다', () => {
  const car = CARS.f1_2022;
  const cruise = P.aeroState(car, env, { v: 70 });
  const brake = P.aeroState(car, env, { v: 70, ax: -40 });
  assert.ok(brake.fzF > cruise.fzF && brake.fzR < cruise.fzR);
  assert.ok(brake.hF < cruise.hF && brake.hR > cruise.hR);
  assert.ok(Math.abs(brake.fzF + brake.fzR - (cruise.fzF + cruise.fzR) - (brake.df - cruise.df)) < 1);
});

test('후류: 간격이 가까울수록 항력 감소와 다운포스 손실이 크다', () => {
  const car = CARS.f1_2021;
  const near = P.wakeEffect(car, 10);
  const far = P.wakeEffect(car, 30);
  assert.ok(near.dragRed > far.dragRed && near.dfLoss > far.dfLoss);
  assert.ok(near.dfLossFront > near.dfLossRear);
  assert.ok(Math.abs(near.dfLoss - 0.47) < 0.01);
  assert.equal(P.wakeEffect(car, Infinity).dragRed, 0);
});

test('최고속도에서 출력 = 저항 × 속도', () => {
  const car = CARS.gt3;
  const v = P.topSpeed(car, env);
  const s = P.aeroState(car, env, { v });
  assert.ok(Math.abs((s.drag + s.rolling) * v - car.power * car.driveEff) < car.power * 0.001);
});

test('슬립스트림으로 직선에서 간격이 줄어든다', () => {
  const r = P.simulateStraight(CARS.f1_2022, env, { length: 800, v0: 30, gap0: 20 });
  assert.ok(r.finalGap < 20);
});

test('모든 프리셋의 결과가 현실 범위 안', () => {
  for (const car of Object.values(CARS)) {
    const v = P.toKmh(P.topSpeed(car, env));
    assert.ok(v > 250 && v < 380, `${car.name} vmax ${v}`);
    const b = P.maxBraking(car, env, P.toMs(200)).a / P.G;
    assert.ok(b > 1 && b < 7, `${car.name} brake ${b}`);
  }
});
