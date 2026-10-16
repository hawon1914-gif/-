import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/physics.js';
import { CARS } from '../js/cars.js';
import { engineFor } from '../js/drivetrain.js';
import { buildTrack } from '../js/track.js';
import { makeDemoSession } from '../js/coach-demo.js';
import { analyzeSession, coachLap, splitLaps, defaultReference, sessionSummary } from '../js/coach.js';

const env = { rho: P.airDensity(20, 1013.25) };
const D = makeDemoSession(CARS.gt3, env, engineFor('gt3'), buildTrack('technical'), { laps: 6, seed: 23 });
const A = analyzeSession(D.samples);
const ME = A.refs.find((c) => c.mine);

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
  const texts = A.laps.flatMap((l) => coachLap(A, l, ME).tips.flatMap((t) => t.reasons));
  assert.ok(texts.some((t) => /m 일찍 밟았습니다/.test(t)));
  assert.ok(texts.some((t) => /흘러갔습니다|가속하지 않았습니다/.test(t)));
});

test('라인: 꼭짓점을 바깥으로 지나간 것과 일찍 꺾은 것을 찾는다', () => {
  const texts = A.laps.flatMap((l) => coachLap(A, l, ME).tips.flatMap((t) => t.reasons));
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
    const r = coachLap(A, l, ME);
    l.traffic.forEach((tr, k) => { if (tr) assert.ok(!r.tips.some((t) => t.corner === A.corners[k].id)); });
  }
  // 상대 비교는 속도 지표만으로 동작
  const o = A.opponents.find((x) => x.cls === 'GT3');
  const r = coachLap(A, A.best, A.refs.find((c) => c.key === 'o' + o.id));
  assert.ok(Array.isArray(r.tips));
});

test('실제 기록의 이상한 랩: 차고 복귀·세션 재시작·느린 랩이 분석을 망가뜨리지 않는다', async () => {
  const S = D.samples.map((s) => ({ ...s }));
  // 3랩 중간에 차고로 갔다가 60초 뒤 다른 곳에서 다시 출발 (같은 랩 번호)
  const i3 = S.findIndex((s) => s.lap === 3) + 400;
  for (let i = i3; i < S.length; i++) S[i].t += 60;
  for (let i = i3; i < i3 + 300; i++) { S[i].x = S[i3].x + 500; S[i].v = 0; }
  // 5랩에서 1번 코너 부근에 40초 멈춤 (스핀 후 정지)
  const i5 = S.findIndex((s) => s.lap === 5) + 100;
  for (let i = i5; i < S.length; i++) S[i].t += 40;
  const stop = S[i5];
  S.splice(i5, 0, ...Array.from({ length: 40 * 60 }, (_, k) => ({ ...stop, t: stop.t - 40 + k / 60, v: 0, thr: 0, brk: 0 })));
  const B = analyzeSession(S);
  assert.ok(!B.error, B.error);
  const l3 = B.laps.find((l) => l.lap === 3);
  assert.ok(!l3 || !l3.valid);
  // 멈춘 랩은 버리지 않고 사고로 분석한다
  const l5 = B.laps.find((l) => l.lap === 5);
  assert.ok(l5 && l5.incidents.some((e) => e.loss > 30), JSON.stringify(l5?.incidents?.map((e) => [e.name, e.loss])));
  assert.notEqual(B.best, l5);
  // 손해·편차가 말이 되는 범위
  for (const c of sessionSummary(B, B.refs.find((x) => x.mine))) {
    assert.ok(c.avgLoss < 2, `${c.corner}번 평균 손해 ${c.avgLoss}`);
    assert.ok(c.spread < 2, `${c.corner}번 편차 ${c.spread}`);
  }
  assert.ok(B.best.time > 80 && B.best.time < 110);
});

test('스핀: 버리지 않고 직전 조작에서 원인을 찾는다 (스로틀을 급하게 연 탈출)', () => {
  const S = D.samples.map((s) => ({ ...s, slip: 0.5, wr: [100, 100, 100, 100] }));
  const L6 = S.filter((s) => s.lap === 6);
  // 6랩에서 조향이 크고 스로틀이 낮은 탈출 지점
  let on = L6.findIndex((s, i) => i > 200 && Math.abs(s.steer) > 0.3 && s.thr < 0.5 && s.v > 20);
  on = S.indexOf(L6[on]);
  for (let k = 1; k <= 12; k++) { S[on - 12 + k].thr = 0.2 + (0.8 * k) / 12; }
  for (let k = 0; k < 120; k++) {
    const x = S[on + k];
    x.slip = Math.min(150, k * 2);
    x.thr = 1;
    x.v = Math.max(3, x.v * (1 - k / 100));
    x.wr = [100, 100, 125, 125];
  }
  const B = analyzeSession(S);
  const l6 = B.laps.find((l) => l.lap === 6);
  const e = l6.incidents.find((x) => x.kind === 'spin');
  assert.ok(e, JSON.stringify(l6.incidents.map((x) => x.name)));
  const txt = e.causes.join(' ');
  assert.ok(/스로틀을 \d+%→\d+%로 열었/.test(txt), txt);
  assert.ok(/휠스핀/.test(txt), txt);
  // 사고 코너는 평균 계산에서 빠지고, 나머지 코너는 그대로 쓰인다
  assert.ok(l6.bad[e.cornerIdx]);
  assert.ok(l6.bad.some((b) => !b));
});

test('기준 랩: 같은 클래스에서 누가 달렸든 가장 빠른 랩, 다른 클래스는 기본 기준이 아니다', () => {
  const R = defaultReference(A);
  const same = A.refs.filter((c) => c.sameClass && c.lap);
  assert.equal(R, same[0]);
  assert.ok(same.every((c) => c.time >= R.time));
  // 하이퍼카는 GT3인 나와 클래스가 다르다
  const hyper = A.refs.find((c) => c.cls === 'Hypercar');
  assert.ok(hyper && !hyper.sameClass);
  assert.notEqual(R, hyper);
});

test('게임 공식 랩 시간·섹터: 결승선 직후 게임 값으로 바꾸고, 게임이 인정하지 않은 랩은 기준에서 뺀다', () => {
  // 랩마다 게임 공식 시간을 흉내: 측정 시간 + 0.012초, 섹터 3등분. 가장 빠른 랩은 게임 베스트가 갱신되지 않음(트랙 리밋으로 삭제)
  const S = D.samples.map((x) => ({ ...x }));
  const raw = splitLaps(D.samples);
  const cut = raw.reduce((a, b) => (b.time < a.time ? b : a)).lap;
  let ll = 0, bl = 0;
  const end = new Map(raw.map((l) => [l.lap, l]));
  let curLap = S[0].lap;
  for (const x of S) {
    if (x.lap !== curLap) {
      const L = end.get(curLap);
      if (L) {
        ll = +(L.time + 0.012).toFixed(3);
        if (L.lap !== cut && (!bl || ll < bl)) bl = ll;
      }
      curLap = x.lap;
    }
    x.ll = ll; x.bl = bl; x.ls1 = +(ll / 3).toFixed(3); x.ls2 = +((2 * ll) / 3).toFixed(3);
  }
  const B = analyzeSession(S);
  const l2 = B.laps.find((l) => l.lap !== cut && l.lap > 1);
  assert.ok(l2.official);
  assert.ok(Math.abs(l2.time - (l2.measured + 0.012)) < 0.002);
  assert.ok(l2.sectors && Math.abs(l2.sectors.reduce((a, b) => a + b, 0) - l2.time) < 0.003);
  const lc = B.laps.find((l) => l.lap === cut);
  assert.ok(lc.why.some((w) => /인정하지 않음/.test(w)), JSON.stringify(lc.why));
  assert.notEqual(B.best, lc);
  assert.equal(B.theoryKind, '섹터별 최고 기록의 합');
  assert.ok(B.theoretical <= B.best.time && B.best.time - B.theoretical < 3);
});

test('코너 가이드: 제동 시점·기어·코너 속도, TC/ABS 개입과 덜 밟을 정도', async () => {
  const { cornerGuide, guideText, gearRatios, recommendGear } = await import('../js/coach.js');
  // ABS·TC 흉내: 강하게 제동하는 곳에서 ABS, 꼭짓점 뒤 급가속에서 TC
  const S = D.samples.map((x) => ({ ...x, abs: x.brk > 0.9 && x.v > 30 ? 1 : 0, tc: x.thr > 0.95 && x.v < 25 ? 1 : 0 }));
  const B = analyzeSession(S);
  const G = gearRatios(B.samples);
  assert.ok(Object.keys(G.ratio).length >= 3);
  const r = recommendGear(G, 25);
  assert.ok(r.gear >= 1 && r.rpm <= G.maxRpm);
  const guide = cornerGuide(B, defaultReference(B));
  assert.equal(guide.length, B.corners.length);
  assert.ok(guide.every((g) => g.targetGear >= 1));
  assert.ok(guide.some((g) => g.abs) && guide.some((g) => g.tc));
  const t = guideText(guide.find((g) => g.abs));
  assert.match(t.aids, /ABS \d+ m 개입.*→ 처음 브레이크 \d+%를 \d+% 정도로/);
});
