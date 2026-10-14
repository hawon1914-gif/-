// 3D 모델 라이브러리. preset: 이 모델에 어울리는 차량 프리셋 (모델 선택 시 자동 전환)
export const MODELS = [
  { id: 'procedural', name: '차종별 기본 형상' },
  { id: 'carconcept', name: 'Car Concept (공개, CC BY 4.0)', file: 'assets/models/CarConcept.glb', preset: 'chiron', credit: 'carconcept' },
  { id: 'lowpoly-f1', name: '로우폴리 F1', file: 'assets/models/user/lowpoly-f1.glb', preset: 'f1_2022' },
  { id: 'arcade-racer', name: '아케이드 레이스카', file: 'assets/models/user/arcade-racer.glb', preset: 'gt3' },
  { id: 'sport-car', name: '스포츠카 (로우폴리)', file: 'assets/models/user/sport-car.glb', preset: 'roadcar' },
  { id: 'muscle-car', name: '머슬카 (로우폴리)', file: 'assets/models/user/muscle-car.glb', preset: 'roadcar' },
  { id: 'hatchback', name: '해치백 (로우폴리)', file: 'assets/models/user/hatchback.glb', preset: 'roadcar' },
  { id: 'classic-car', name: '클래식카 (로우폴리)', file: 'assets/models/user/classic-car.glb', preset: 'roadcar' },
  { id: 'police-car', name: '경찰차 (로우폴리)', file: 'assets/models/user/police-car.glb', preset: 'roadcar' },
  { id: 'pickup', name: '픽업트럭 (로우폴리)', file: 'assets/models/user/pickup.glb', preset: 'roadcar' },
  { id: 'van', name: '밴 (로우폴리)', file: 'assets/models/user/van.glb', preset: 'roadcar' },
  { id: 'monster-truck', name: '몬스터트럭 (로우폴리)', file: 'assets/models/user/monster-truck.glb', preset: 'roadcar' },
  { id: 'military', name: '군용차 (로우폴리)', file: 'assets/models/user/military.glb', preset: 'roadcar' },
];
