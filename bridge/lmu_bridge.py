"""
Le Mans Ultimate (rFactor 2 엔진) 텔레메트리 브리지.

게임의 공유 메모리(rF2 Shared Memory Map Plugin)를 초당 60번 읽어서
  1) http://127.0.0.1:8770/stream 으로 실시간 전송 (Aero Lab의 '코칭' 탭이 받음)
  2) recordings/ 폴더에 세션을 .jsonl 파일로 기록
한다. 파이썬 표준 라이브러리만 쓰므로 따로 설치할 것이 없다 (Python 3.8 이상, Windows).

사용법:
  python lmu_bridge.py            게임 연결 (게임 실행 중이어야 함)
  python lmu_bridge.py --demo     게임 없이 가짜 데이터로 연결 시험
  python lmu_bridge.py --replay 파일.jsonl   기록 파일을 실제 속도로 다시 보내기

메모리 구조는 rF2 Shared Memory Map Plugin(The Iron Wolf)의 rF2State.h와 같은 순서·크기로 정의했다.
"""
import argparse
import ctypes
import json
import math
import mmap
import os
import queue
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_VEHICLES = 128


# ---------------------------------------------------------------- 메모리 구조 (pack 4)
class Vec3(ctypes.Structure):
    _pack_ = 4
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double), ('z', ctypes.c_double)]


class Wheel(ctypes.Structure):
    _pack_ = 4
    _fields_ = [
        ('mSuspensionDeflection', ctypes.c_double), ('mRideHeight', ctypes.c_double), ('mSuspForce', ctypes.c_double),
        ('mBrakeTemp', ctypes.c_double), ('mBrakePressure', ctypes.c_double), ('mRotation', ctypes.c_double),
        ('mLateralPatchVel', ctypes.c_double), ('mLongitudinalPatchVel', ctypes.c_double),
        ('mLateralGroundVel', ctypes.c_double), ('mLongitudinalGroundVel', ctypes.c_double),
        ('mCamber', ctypes.c_double), ('mLateralForce', ctypes.c_double), ('mLongitudinalForce', ctypes.c_double),
        ('mTireLoad', ctypes.c_double), ('mGripFract', ctypes.c_double), ('mPressure', ctypes.c_double),
        ('mTemperature', ctypes.c_double * 3), ('mWear', ctypes.c_double), ('mTerrainName', ctypes.c_ubyte * 16),
        ('mSurfaceType', ctypes.c_ubyte), ('mFlat', ctypes.c_ubyte), ('mDetached', ctypes.c_ubyte),
        ('mStaticUndeflectedRadius', ctypes.c_ubyte), ('mVerticalTireDeflection', ctypes.c_double),
        ('mWheelYLocation', ctypes.c_double), ('mToe', ctypes.c_double), ('mTireCarcassTemperature', ctypes.c_double),
        ('mTireInnerLayerTemperature', ctypes.c_double * 3), ('mExpansion', ctypes.c_ubyte * 24),
    ]


class VehicleTelemetry(ctypes.Structure):
    _pack_ = 4
    _fields_ = [
        ('mID', ctypes.c_int), ('mDeltaTime', ctypes.c_double), ('mElapsedTime', ctypes.c_double),
        ('mLapNumber', ctypes.c_int), ('mLapStartET', ctypes.c_double),
        ('mVehicleName', ctypes.c_ubyte * 64), ('mTrackName', ctypes.c_ubyte * 64),
        ('mPos', Vec3), ('mLocalVel', Vec3), ('mLocalAccel', Vec3), ('mOri', Vec3 * 3),
        ('mLocalRot', Vec3), ('mLocalRotAccel', Vec3),
        ('mGear', ctypes.c_int), ('mEngineRPM', ctypes.c_double), ('mEngineWaterTemp', ctypes.c_double),
        ('mEngineOilTemp', ctypes.c_double), ('mClutchRPM', ctypes.c_double),
        ('mUnfilteredThrottle', ctypes.c_double), ('mUnfilteredBrake', ctypes.c_double),
        ('mUnfilteredSteering', ctypes.c_double), ('mUnfilteredClutch', ctypes.c_double),
        ('mFilteredThrottle', ctypes.c_double), ('mFilteredBrake', ctypes.c_double),
        ('mFilteredSteering', ctypes.c_double), ('mFilteredClutch', ctypes.c_double),
        ('mSteeringShaftTorque', ctypes.c_double), ('mFront3rdDeflection', ctypes.c_double),
        ('mRear3rdDeflection', ctypes.c_double), ('mFrontWingHeight', ctypes.c_double),
        ('mFrontRideHeight', ctypes.c_double), ('mRearRideHeight', ctypes.c_double), ('mDrag', ctypes.c_double),
        ('mFrontDownforce', ctypes.c_double), ('mRearDownforce', ctypes.c_double), ('mFuel', ctypes.c_double),
        ('mEngineMaxRPM', ctypes.c_double), ('mScheduledStops', ctypes.c_ubyte), ('mOverheating', ctypes.c_ubyte),
        ('mDetached', ctypes.c_ubyte), ('mHeadlights', ctypes.c_ubyte), ('mDentSeverity', ctypes.c_ubyte * 8),
        ('mLastImpactET', ctypes.c_double), ('mLastImpactMagnitude', ctypes.c_double), ('mLastImpactPos', Vec3),
        ('mEngineTorque', ctypes.c_double), ('mCurrentSector', ctypes.c_int), ('mSpeedLimiter', ctypes.c_ubyte),
        ('mMaxGears', ctypes.c_ubyte), ('mFrontTireCompoundIndex', ctypes.c_ubyte),
        ('mRearTireCompoundIndex', ctypes.c_ubyte), ('mFuelCapacity', ctypes.c_double),
        ('mFrontFlapActivated', ctypes.c_ubyte), ('mRearFlapActivated', ctypes.c_ubyte),
        ('mRearFlapLegalStatus', ctypes.c_ubyte), ('mIgnitionStarter', ctypes.c_ubyte),
        ('mFrontTireCompoundName', ctypes.c_ubyte * 18), ('mRearTireCompoundName', ctypes.c_ubyte * 18),
        ('mSpeedLimiterAvailable', ctypes.c_ubyte), ('mAntiStallActivated', ctypes.c_ubyte),
        ('mUnused', ctypes.c_ubyte * 2), ('mVisualSteeringWheelRange', ctypes.c_float),
        ('mRearBrakeBias', ctypes.c_double), ('mTurboBoostPressure', ctypes.c_double),
        ('mPhysicsToGraphicsOffset', ctypes.c_float * 3), ('mPhysicalSteeringWheelRange', ctypes.c_float),
        ('mExpansion', ctypes.c_ubyte * 152), ('mWheels', Wheel * 4),
    ]


class Telemetry(ctypes.Structure):
    _pack_ = 4
    _fields_ = [
        ('mVersionUpdateBegin', ctypes.c_int), ('mVersionUpdateEnd', ctypes.c_int),
        ('mBytesUpdatedHint', ctypes.c_int), ('mNumVehicles', ctypes.c_int),
        ('mVehicles', VehicleTelemetry * MAX_VEHICLES),
    ]


class ScoringInfo(ctypes.Structure):
    _pack_ = 4
    _fields_ = [
        ('mTrackName', ctypes.c_ubyte * 64), ('mSession', ctypes.c_int), ('mCurrentET', ctypes.c_double),
        ('mEndET', ctypes.c_double), ('mMaxLaps', ctypes.c_int), ('mLapDist', ctypes.c_double),
        ('pointer1', ctypes.c_ubyte * 8), ('mNumVehicles', ctypes.c_int), ('mGamePhase', ctypes.c_ubyte),
        ('mYellowFlagState', ctypes.c_ubyte), ('mSectorFlag', ctypes.c_ubyte * 3), ('mStartLight', ctypes.c_ubyte),
        ('mNumRedLights', ctypes.c_ubyte), ('mInRealtime', ctypes.c_ubyte), ('mPlayerName', ctypes.c_ubyte * 32),
        ('mPlrFileName', ctypes.c_ubyte * 64), ('mDarkCloud', ctypes.c_double), ('mRaining', ctypes.c_double),
        ('mAmbientTemp', ctypes.c_double), ('mTrackTemp', ctypes.c_double), ('mWind', Vec3),
        ('mMinPathWetness', ctypes.c_double), ('mMaxPathWetness', ctypes.c_double), ('mGameMode', ctypes.c_ubyte),
        ('mIsPasswordProtected', ctypes.c_ubyte), ('mServerPort', ctypes.c_short), ('mServerPublicIP', ctypes.c_int),
        ('mMaxPlayers', ctypes.c_int), ('mServerName', ctypes.c_ubyte * 32), ('mStartET', ctypes.c_float),
        ('mAvgPathWetness', ctypes.c_double), ('mExpansion', ctypes.c_ubyte * 200), ('pointer2', ctypes.c_ubyte * 8),
    ]


class VehicleScoring(ctypes.Structure):
    _pack_ = 4
    _fields_ = [
        ('mID', ctypes.c_int), ('mDriverName', ctypes.c_ubyte * 32), ('mVehicleName', ctypes.c_ubyte * 64),
        ('mTotalLaps', ctypes.c_short), ('mSector', ctypes.c_ubyte), ('mFinishStatus', ctypes.c_ubyte),
        ('mLapDist', ctypes.c_double), ('mPathLateral', ctypes.c_double), ('mTrackEdge', ctypes.c_double),
        ('mBestSector1', ctypes.c_double), ('mBestSector2', ctypes.c_double), ('mBestLapTime', ctypes.c_double),
        ('mLastSector1', ctypes.c_double), ('mLastSector2', ctypes.c_double), ('mLastLapTime', ctypes.c_double),
        ('mCurSector1', ctypes.c_double), ('mCurSector2', ctypes.c_double), ('mNumPitstops', ctypes.c_short),
        ('mNumPenalties', ctypes.c_short), ('mIsPlayer', ctypes.c_ubyte), ('mControl', ctypes.c_ubyte),
        ('mInPits', ctypes.c_ubyte), ('mPlace', ctypes.c_ubyte), ('mVehicleClass', ctypes.c_ubyte * 32),
        ('mTimeBehindNext', ctypes.c_double), ('mLapsBehindNext', ctypes.c_int),
        ('mTimeBehindLeader', ctypes.c_double), ('mLapsBehindLeader', ctypes.c_int),
        ('mLapStartET', ctypes.c_double), ('mPos', Vec3), ('mLocalVel', Vec3), ('mLocalAccel', Vec3),
        ('mOri', Vec3 * 3), ('mLocalRot', Vec3), ('mLocalRotAccel', Vec3), ('mHeadlights', ctypes.c_ubyte),
        ('mPitState', ctypes.c_ubyte), ('mServerScored', ctypes.c_ubyte), ('mIndividualPhase', ctypes.c_ubyte),
        ('mQualification', ctypes.c_int), ('mTimeIntoLap', ctypes.c_double), ('mEstimatedLapTime', ctypes.c_double),
        ('mPitGroup', ctypes.c_ubyte * 24), ('mFlag', ctypes.c_ubyte), ('mUnderYellow', ctypes.c_ubyte),
        ('mCountLapFlag', ctypes.c_ubyte), ('mInGarageStall', ctypes.c_ubyte), ('mUpgradePack', ctypes.c_ubyte * 16),
        ('mPitLapDist', ctypes.c_float), ('mBestLapSector1', ctypes.c_float), ('mBestLapSector2', ctypes.c_float),
        ('mExpansion', ctypes.c_ubyte * 48),
    ]


class Scoring(ctypes.Structure):
    _pack_ = 4
    _fields_ = [
        ('mVersionUpdateBegin', ctypes.c_int), ('mVersionUpdateEnd', ctypes.c_int),
        ('mBytesUpdatedHint', ctypes.c_int), ('mScoringInfo', ScoringInfo),
        ('mVehicles', VehicleScoring * MAX_VEHICLES),
    ]


def text(arr):
    return bytes(arr).split(b'\0', 1)[0].decode('utf-8', 'replace')


# 노면 종류: 0 아스팔트, 1 젖은 노면, 2 잔디, 3 흙, 4 자갈, 5 연석, 6 특수
OFF_SURFACES = {2, 3, 4}


# ---------------------------------------------------------------- 게임 읽기
class GameReader:
    def __init__(self):
        if sys.platform != 'win32':
            raise SystemExit('게임 연결은 Windows에서만 됩니다. 시험하려면 --demo 를 쓰세요.')
        self.tel_map = mmap.mmap(-1, ctypes.sizeof(Telemetry), '$rFactor2SMMP_Telemetry$')
        self.sco_map = mmap.mmap(-1, ctypes.sizeof(Scoring), '$rFactor2SMMP_Scoring$')
        self.tel = Telemetry()
        self.sco = Scoring()
        self.player_id = None
        self.last_scoring = 0

    def _copy(self, mm, struct):
        # 게임이 쓰는 도중에 읽으면 깨진 값이 나오므로, 시작·끝 버전 번호가 같을 때까지 다시 읽는다
        for _ in range(10):
            mm.seek(0)
            ctypes.memmove(ctypes.addressof(struct), mm.read(ctypes.sizeof(struct)), ctypes.sizeof(struct))
            if struct.mVersionUpdateBegin == struct.mVersionUpdateEnd:
                return True
        return False

    def read(self):
        now = time.time()
        if now - self.last_scoring > 0.2 or self.player_id is None:
            if self._copy(self.sco_map, self.sco):
                self.last_scoring = now
                self.player_id = None
                for i in range(min(self.sco.mScoringInfo.mNumVehicles, MAX_VEHICLES)):
                    v = self.sco.mVehicles[i]
                    if v.mIsPlayer:
                        self.player_id = v.mID
                        self.player_scoring = v
                        break
        if self.player_id is None or not self._copy(self.tel_map, self.tel):
            return None
        for i in range(min(self.tel.mNumVehicles, MAX_VEHICLES)):
            t = self.tel.mVehicles[i]
            if t.mID != self.player_id:
                continue
            vel = t.mLocalVel
            wheels = t.mWheels
            off = sum(1 for w in wheels if w.mSurfaceType in OFF_SURFACES) >= 2
            return {
                't': round(t.mElapsedTime, 4), 'lap': t.mLapNumber,
                'x': round(t.mPos.x, 3), 'y': round(t.mPos.y, 3), 'z': round(t.mPos.z, 3),
                'v': round(math.sqrt(vel.x ** 2 + vel.y ** 2 + vel.z ** 2), 3),
                'thr': round(t.mUnfilteredThrottle, 3), 'brk': round(t.mUnfilteredBrake, 3),
                'steer': round(t.mUnfilteredSteering, 3), 'gear': t.mGear, 'rpm': round(t.mEngineRPM),
                'maxRpm': round(t.mEngineMaxRPM), 'off': off,
                'tire': [round(sum(w.mTireInnerLayerTemperature) / 3 - 273.15, 1) for w in wheels],
                'lapDist': round(self.player_scoring.mLapDist, 1),
                'track': text(t.mTrackName), 'car': text(t.mVehicleName),
                'trackLen': round(self.sco.mScoringInfo.mLapDist, 1),
                'realtime': bool(self.sco.mScoringInfo.mInRealtime),
            }
        return None


# ---------------------------------------------------------------- 시험용 가짜 데이터
class DemoReader:
    """게임 없이 연결을 시험하기 위한 데이터. 타원 트랙을 돌며 직선 끝에서 브레이크를 밟는다."""

    def __init__(self):
        self.t0 = time.time()
        self.s = 0.0
        self.v = 30.0
        self.lap = 1
        self.last = time.time()

    def read(self):
        now = time.time()
        dt = min(0.1, now - self.last)
        self.last = now
        L = 2400.0
        a, b = 500.0, 220.0
        u = (self.s / L) % 1.0
        in_corner = 0.22 < u < 0.5 or 0.72 < u < 1.0
        before = 0.17 < u < 0.22 or 0.67 < u < 0.72
        thr, brk = (0.0, 0.9) if before else ((0.35, 0.0) if in_corner else (1.0, 0.0))
        self.v += (thr * 8 - brk * 25 - 0.0004 * self.v * self.v) * dt
        self.v = max(20.0, min(75.0, self.v))
        self.s += self.v * dt
        if self.s >= L * self.lap:
            self.lap += 1
        ang = 2 * math.pi * u
        return {
            't': round(now - self.t0, 4), 'lap': self.lap, 'x': round(a * math.cos(ang), 3), 'y': 0,
            'z': round(b * math.sin(ang), 3), 'v': round(self.v, 3), 'thr': thr, 'brk': brk,
            'steer': 0.3 if in_corner else 0.0, 'gear': max(1, min(6, int(self.v / 12))), 'rpm': 4000 + int(self.v * 60),
            'maxRpm': 8500, 'off': False, 'tire': [80, 80, 82, 82], 'lapDist': round(self.s % L, 1),
            'track': '데모 타원', 'car': '데모 차량', 'trackLen': L, 'realtime': True,
        }


class ReplayReader:
    """기록 파일을 원래 시간 간격대로 다시 보낸다."""

    def __init__(self, path, speed=1.0):
        with open(path, encoding='utf-8') as f:
            self.rows = [json.loads(line) for line in f if line.strip()]
        self.i = 0
        self.speed = speed
        self.start = time.time()

    def read(self):
        # 그동안 지나간 샘플을 모두 돌려준다 (배속 재생에서도 빠짐없이 보내도록)
        if self.i >= len(self.rows):
            return None
        elapsed = (time.time() - self.start) * self.speed
        t0 = self.rows[0]['t']
        due = []
        while self.i < len(self.rows) and self.rows[self.i]['t'] - t0 <= elapsed:
            due.append(self.rows[self.i])
            self.i += 1
        return due


# ---------------------------------------------------------------- 전송·기록
clients = []
clients_lock = threading.Lock()
status = {'source': '', 'connected': False, 'samples': 0, 'recording': None, 'track': '', 'car': ''}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _cors(self):
        # 파일로 연 Aero Lab(file://)에서도 받을 수 있게 모든 출처를 허용 (127.0.0.1에서만 열림)
        self.send_header('Access-Control-Allow-Origin', '*')

    def do_GET(self):
        if self.path.startswith('/status'):
            body = json.dumps(status, ensure_ascii=False).encode()
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(body)
            return
        if not self.path.startswith('/stream'):
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        q = queue.Queue(maxsize=600)
        with clients_lock:
            clients.append(q)
        try:
            while True:
                item = q.get()
                self.wfile.write(b'data: ' + item + b'\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            with clients_lock:
                clients.remove(q)


def broadcast(sample):
    data = json.dumps(sample, ensure_ascii=False, separators=(',', ':')).encode()
    with clients_lock:
        for q in clients:
            try:
                q.put_nowait(data)
            except queue.Full:
                pass


def main():
    ap = argparse.ArgumentParser(description='Le Mans Ultimate 텔레메트리 브리지')
    ap.add_argument('--demo', action='store_true', help='게임 없이 가짜 데이터로 시험')
    ap.add_argument('--replay', help='기록 파일(.jsonl)을 다시 보내기')
    ap.add_argument('--speed', type=float, default=1.0, help='재생 배속 (--replay와 함께)')
    ap.add_argument('--port', type=int, default=8770)
    ap.add_argument('--hz', type=float, default=60)
    ap.add_argument('--no-record', action='store_true', help='기록 파일을 만들지 않음')
    args = ap.parse_args()

    if args.replay:
        reader, status['source'] = ReplayReader(args.replay, args.speed), '기록 재생'
    elif args.demo:
        reader, status['source'] = DemoReader(), '데모'
    else:
        reader, status['source'] = GameReader(), 'Le Mans Ultimate'

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f'[브리지] {status["source"]} → http://127.0.0.1:{args.port}/stream')
    print('[브리지] Aero Lab의 "코칭" 탭에서 "실시간 연결"을 누르세요. 끝내려면 Ctrl+C.')

    rec_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'recordings')
    rec = None
    last_t = None
    waiting_msg = 0
    period = 1.0 / args.hz
    try:
        while True:
            tick = time.time()
            got = reader.read()
            batch = got if isinstance(got, list) else ([got] if got else [])
            if isinstance(got, list) and not got and reader.i < len(reader.rows):
                time.sleep(max(0.0, period - (time.time() - tick)))
                continue
            for s in batch:
                if s.get('realtime', True) and s['t'] != last_t:
                    last_t = s['t']
                    status.update(connected=True, track=s.get('track', ''), car=s.get('car', ''))
                    status['samples'] += 1
                    broadcast(s)
                    if not args.no_record and not args.replay:
                        if rec is None:
                            os.makedirs(rec_dir, exist_ok=True)
                            safe = ''.join(ch if ch.isalnum() else '_' for ch in s.get('track', 'track'))[:40]
                            path = os.path.join(rec_dir, f'{datetime.now():%Y%m%d_%H%M%S}_{safe}.jsonl')
                            rec = open(path, 'w', encoding='utf-8')
                            status['recording'] = path
                            print(f'[브리지] 기록 중: {path}')
                        rec.write(json.dumps(s, ensure_ascii=False, separators=(',', ':')) + '\n')
                        # 프로그램이 갑자기 꺼져도 기록이 남도록 1초마다 디스크에 쓴다
                        if status['samples'] % 60 == 0:
                            rec.flush()
            if not batch:
                status['connected'] = False
                if time.time() - waiting_msg > 10:
                    waiting_msg = time.time()
                    if args.replay and reader.i >= len(reader.rows):
                        print('[브리지] 재생이 끝났습니다.')
                        break
                    print('[브리지] 게임 데이터를 기다리는 중… (트랙에 나가 있어야 하고, 플러그인이 켜져 있어야 합니다)')
            time.sleep(max(0.0, period - (time.time() - tick)))
    except KeyboardInterrupt:
        pass
    finally:
        if rec:
            rec.close()
            print(f'[브리지] 기록을 저장했습니다: {status["recording"]}')


if __name__ == '__main__':
    main()
