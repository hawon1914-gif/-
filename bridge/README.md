# Le Mans Ultimate 텔레메트리 브리지

게임의 텔레메트리를 읽어 Aero Lab의 **코칭** 탭으로 보내고, 주행을 파일로 기록합니다.

## 1. 게임 쪽 준비

최근 르망 얼티밋은 게임이 직접 공유 메모리(`LMU_Data`)를 내보냅니다. 브리지는 이것을 먼저 찾으므로 **따로 설치할 플러그인이 없습니다.**

- 게임 설정에 플러그인 사용(Enable Plugins) 항목이 있으면 켜 두세요. 다른 프로그램(LMU Pitwall)의 안내로는 이 설정이 켜져 있어야 데이터가 나온다고 합니다. 직접 확인하지는 못했습니다.
- 메모리 구조는 게임 폴더 `Support\SharedMemoryInterface\SharedMemoryInterface.hpp`(S397) 기준이며, 공개 구현 pyLMUSharedMemory(TinyPedal)와 크기·오프셋을 맞췄습니다.

`LMU_Data`가 없는 예전 버전이면 **rF2 Shared Memory Map Plugin**을 찾습니다.

1. https://github.com/TheIronWolfModding/rF2SharedMemoryMapPlugin/releases 에서 `rFactor2SharedMemoryMapPlugin64.dll`을 받아 르망 얼티밋 설치 폴더의 `Plugins` 폴더에 넣습니다.
2. `UserData\player\CustomPluginVariables.JSON`에 `"rFactor2SharedMemoryMapPlugin64.dll": { " Enabled": 1 }` 항목을 넣고 게임을 다시 시작합니다.

연결이 안 되면 브리지 창에 10초마다 무엇을 찾았는지(공유 메모리 종류, 차량 수, 내 차 여부, 주행 중 여부)가 나옵니다. 그 줄을 알려주세요.

## 2. 브리지 실행

- `start_lmu_bridge.bat`을 더블클릭합니다 (Python 3.8 이상 필요, 추가 설치 없음).
- 게임에서 트랙에 나가면 브리지 창에 "기록 중"이 뜹니다.
- Aero Lab의 **코칭** 탭에서 **실시간 연결**을 누릅니다.

명령으로 직접 실행할 때:

```bat
python lmu_bridge.py              :: 게임 연결
python lmu_bridge.py --demo       :: 게임 없이 연결 시험
python lmu_bridge.py --replay recordings\파일.jsonl   :: 기록을 실시간처럼 다시 보내기
```

## 3. 기록 파일

주행은 `recordings` 폴더에 `.jsonl`로 저장됩니다. 한 줄이 한 샘플(초당 약 60개)이고, 코칭 탭의 **기록 파일 열기**로 나중에 다시 분석할 수 있습니다.

| 항목 | 뜻 |
| --- | --- |
| t | 세션 시간 (초) |
| lap | 랩 번호 |
| x, y, z | 위치 (m, y가 위) |
| v | 속도 (m/s) |
| thr, brk | 스로틀, 브레이크 (0~1, 게임이 받은 입력) |
| steer | 조향 (-1~1) |
| gear, rpm | 기어, 엔진 회전수 |
| off | 바퀴 2개 이상이 잔디·흙·자갈 위 |
| tire | 타이어 안쪽 고무층 온도 (°C, 앞왼·앞오·뒤왼·뒤오) |
| lapDist | 게임이 계산한 랩 거리 (m) |

## 다른 차·라인 데이터

- 내 차 샘플에 `lat`(트랙 중심선 기준 가로 위치, m), `edge`(중심선에서 가장자리까지, m), `pit`가 들어갑니다. 순위표 값이라 초당 5번만 바뀝니다. `lat`의 좌우 부호는 공개 문서에 없어서, 분석 프로그램이 위치 데이터와 비교해 스스로 맞춥니다.
- 3샘플마다(약 20 Hz) `cars` 배열로 다른 차의 이름·클래스·순위·위치·속도·랩·랩 거리·피트 여부·베스트/지난 랩이 들어갑니다.
- 온라인에서 다른 사람의 페달·조향 입력은 게임이 주지 않거나 0이라 기록하지 않습니다. 상대와는 속도와 라인만 비교합니다.
- 실제 르망 얼티밋 온라인 세션에서는 아직 시험하지 못했습니다. 다른 차 위치가 이상하면 기록 파일(.jsonl)을 보내 주세요.
