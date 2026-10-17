# 작업 안내 (다음 대화용)

## 사용자
- 한국어로 답한다. 공감 표현 없이 객관적으로, 틀리면 틀렸다고, 모르면 모른다고 정확히 말한다.
- 이 컴퓨터(Windows)에서만 쓴다. 배포·저작권은 신경 쓰지 않아도 된다.
- 사용자에게 작업을 부탁하지 말고 직접 한다. 고치는 도중 모호하면 묻는다.
- PS5 패드로 운전한다. 백그라운드 상주 프로그램은 원하지 않는다(실행 파일 하나를 직접 켜는 방식).
- 결과물은 `npm run build`로 만든 `dist/LMUCoach.html` 한 파일을 사용자에게 보낸다 (사용자는 bridge 폴더에 넣어 쓴다).

## 구조
- 브리지(`bridge/lmu_bridge.py`)가 LMU 공유 메모리 `LMU_Data`를 읽어 샘플을 `http://127.0.0.1:8770/stream`(SSE)으로 보내고 `recordings/*.jsonl`에 기록한다. `/`에서 `LMUCoach.html`(예전 이름 `AeroLab.html`도)을 서빙한다. `--open`이면 브라우저를 연다.
  - LMU 구조체 오프셋: LMUObjectOut 324820, scoring 1632, telemetry 128464, LMUVehicleTelemetry 1888바이트, LMU 전용 필드 mLapInvalidated 745, mABSActive 746, mTCActive 747, mTC 750, mABS 756, mWheels 848 (pyLMUSharedMemory 기준).
  - 샘플 필드 표는 `bridge/README.md`.
- 화면은 `js/main.js` → `createCoach({ root })`(`js/coach-ui.js`). 분석은 `js/coach.js`의 `analyzeSession(samples)`이 중심.
- localStorage 키는 예전 프로그램과 같은 `aerolab.*`, `aerolab-port`, `aerolab-autolive`를 그대로 쓴다 (같은 주소 127.0.0.1:8770에서 저장된 트랙 지도·목표 시간을 이어 쓰기 위해). 바꾸면 기존 저장값이 사라진다.

## 검증
- `npm test` (Node 테스트 + Python 브리지 테스트).
- 화면 확인: `npm run build` 후 Playwright(크로미움)로 `dist/LMUCoach.html`을 열고 `#co-file`에 jsonl을 넣는다. 실시간은 `python3 bridge/lmu_bridge.py --replay 파일.jsonl`.

## 실제 게임에서 아직 확인 못 한 것
- 실행 파일·미니맵 창(Document Picture-in-Picture)·서킷 모양 맞춤의 실제 좌표 동작
- TC/ABS 덜 밟기 기준(브레이크 −7%p, 스로틀 −10%p), 스핀 회복 기준(카운터스티어 0.35초, 스로틀 20~40%, 90°)은 경험적 출발점
- 무효 랩의 `ll`(마지막 랩 시간) 동작

## 미뤄 둔 아이디어 (요청 없으면 하지 않음)
- 타이어 온도·그립 모델, 엔진 소리
