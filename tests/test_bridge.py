"""브리지의 공유 메모리 구조 크기가 rF2 Shared Memory Map Plugin과 같은지 확인 (python3 -m unittest)."""
import ctypes
import io
import importlib.util
import os
import unittest

spec = importlib.util.spec_from_file_location('lmu_bridge', os.path.join(os.path.dirname(__file__), '..', 'bridge', 'lmu_bridge.py'))
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)


class StructSizes(unittest.TestCase):
    # 기준값: rF2State.h를 옮긴 공개 정의(pyRfactor2SharedMemory)로 잰 크기
    def test_sizes(self):
        expect = {'Vec3': 24, 'Wheel': 260, 'VehicleTelemetry': 1888, 'Telemetry': 241680,
                  'ScoringInfo': 548, 'VehicleScoring': 584, 'Scoring': 75312}
        for name, size in expect.items():
            self.assertEqual(ctypes.sizeof(getattr(B, name)), size, name)

    def test_lmu_layout(self):
        # 기준값: pyLMUSharedMemory(TinyPedal)의 LMUObjectOut 크기와 오프셋
        self.assertEqual(ctypes.sizeof(B.LMUObjectOut), 324820)
        self.assertEqual(B.LMUObjectOut.scoring.offset, 1632)
        self.assertEqual(B.LMUObjectOut.telemetry.offset, 128464)

    def test_lmu_reader(self):
        # 가짜 LMU_Data 버퍼: 내 차 1대 + 다른 차 1대
        o = B.LMUObjectOut()
        o.scoring.mScoringInfo.mNumVehicles = 2
        o.scoring.mScoringInfo.mInRealtime = 1
        o.scoring.mScoringInfo.mLapDist = 5000
        for i, (vid, me) in enumerate([(7, 1), (9, 0)]):
            v = o.scoring.mVehicles[i]
            v.mID, v.mIsPlayer, v.mLapDist, v.mPathLateral, v.mTrackEdge = vid, me, 100.0 + i * 50, 1.5, 6.0
            v.mDriverName[:3] = list(b'Bob')
        o.telemetry.mActiveVehicles = 2
        o.telemetry.mPlayerHasVehicle = True
        o.telemetry.mPlayerVehicleIdx = 1
        for i, vid in enumerate([9, 7]):  # 텔레메트리 순서는 순위표와 다를 수 있다
            t = o.telemetry.mVehicles[i]
            t.mID, t.mLapNumber, t.mElapsedTime = vid, 3, 12.5
            t.mLocalVel.z = 50.0 if vid == 7 else 40.0
            t.mUnfilteredThrottle = 0.8
            t.mTrackName[:4] = list(b'Spa\0')
        mm = io.BytesIO(bytes(o))
        r = B.GameReader(B.LMUSource(mm))
        samples = [r.read() for _ in range(3)]
        s = samples[0]
        self.assertAlmostEqual(s['v'], 50.0)
        self.assertEqual(s['lat'], 1.5)
        self.assertEqual(s['track'], 'Spa')
        self.assertTrue(s['realtime'])
        cars = samples[2]['cars']
        self.assertEqual(len(cars), 1)
        self.assertEqual(cars[0]['id'], 9)
        self.assertEqual(cars[0]['n'], 'Bob')
        self.assertAlmostEqual(cars[0]['v'], 40.0)

    def test_demo_reader(self):
        r = B.DemoReader()
        s = r.read()
        for k in ('t', 'lap', 'x', 'z', 'v', 'thr', 'brk', 'steer', 'gear'):
            self.assertIn(k, s)
        # 3번째 샘플마다 다른 차 목록
        cars = [r.read().get('cars') for _ in range(3)]
        self.assertTrue(any(c for c in cars))
        c = next(c for c in cars if c)[0]
        for k in ('id', 'n', 'c', 'x', 'z', 'v', 'lap', 'pit'):
            self.assertIn(k, c)


if __name__ == '__main__':
    unittest.main()
