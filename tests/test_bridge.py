"""브리지의 공유 메모리 구조 크기가 rF2 Shared Memory Map Plugin과 같은지 확인 (python3 -m unittest)."""
import ctypes
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

    def test_demo_reader(self):
        r = B.DemoReader()
        s = r.read()
        for k in ('t', 'lap', 'x', 'z', 'v', 'thr', 'brk', 'steer', 'gear'):
            self.assertIn(k, s)


if __name__ == '__main__':
    unittest.main()
