// 차종별 절차적 3D 모델. 좌표: x = 앞차축 기준 뒤쪽(+), y = 위, z = 옆. 노즈는 -x를 향한다.
// 차체(스프렁)와 바퀴(언스프렁)를 분리해, 라이드하이트·피치가 바뀌어도 바퀴는 노면에 붙어 있다.
import * as THREE from 'three';

// 단면이 초타원인 로프트. stations: [{x, yb, yt, hw, n}]
function loft(stations, segs = 28) {
  const pos = [];
  const idx = [];
  const ring = (st) => {
    const yc = (st.yb + st.yt) / 2;
    const hy = (st.yt - st.yb) / 2;
    const e = 2 / (st.n ?? 2.6);
    const pts = [];
    for (let k = 0; k < segs; k++) {
      const t = (k / segs) * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      pts.push([st.x, yc + hy * Math.sign(s) * Math.abs(s) ** e, st.hw * Math.sign(c) * Math.abs(c) ** e]);
    }
    return pts;
  };
  stations.forEach((st) => ring(st).forEach((p) => pos.push(...p)));
  for (let j = 0; j < stations.length - 1; j++) {
    for (let k = 0; k < segs; k++) {
      const a = j * segs + k;
      const b = j * segs + ((k + 1) % segs);
      const c = a + segs;
      const d = b + segs;
      idx.push(a, c, b, b, c, d);
    }
  }
  // 양 끝 마개
  for (const [j, flip] of [[0, true], [stations.length - 1, false]]) {
    const st = stations[j];
    const center = pos.length / 3;
    pos.push(st.x, (st.yb + st.yt) / 2, 0);
    for (let k = 0; k < segs; k++) {
      const a = j * segs + k;
      const b = j * segs + ((k + 1) % segs);
      if (flip) idx.push(center, a, b);
      else idx.push(center, b, a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 뒤집힌 캠버 익형(다운포스용). 앞전 x0, 시위 chord, 받음각 aoa(rad, 뒷전이 올라감)
function wing(x0, y0, chord, thick, span, aoa) {
  const shape = new THREE.Shape();
  const n = 16;
  const upper = [];
  const lower = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const xt = t * chord;
    const th = 5 * thick * chord * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4);
    const camber = -0.06 * chord * 4 * t * (1 - t); // 아래로 볼록 → 다운포스
    upper.push([xt, camber + th]);
    lower.push([xt, camber - th]);
  }
  shape.moveTo(upper[0][0], upper[0][1]);
  upper.slice(1).forEach(([x, y]) => shape.lineTo(x, y));
  lower.reverse().forEach(([x, y]) => shape.lineTo(x, y));
  const g = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, -span / 2);
  g.rotateZ(aoa);
  g.translate(x0, y0, 0);
  return g;
}

function box(x0, x1, y0, y1, hw) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, hw * 2);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
  return g;
}

function plate(x0, x1, y0, y1, z, thick = 0.02) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, thick);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
  return g;
}

function rod(a, b, r = 0.015) {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const g = new THREE.CylinderGeometry(r, r, len, 6);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  g.applyQuaternion(q);
  g.translate(...a);
  return g;
}

function bodyParts(car) {
  const L = car.length;
  const wb = car.wheelbase;
  const fo = car.frontOverhang;
  const nose = -fo;
  const tail = L - fo;
  const hw = car.width / 2;
  const H = car.height;
  const parts = [];
  const add = (geo, role = 'paint') => parts.push({ geo, role });

  if (car.shape === 'open') {
    // 플로어(벤투리 + 디퓨저 킥업)
    add(loft([
      { x: -0.2, yb: 0.0, yt: 0.03, hw: 0.75, n: 10 },
      { x: 1.0, yb: 0.0, yt: 0.03, hw: 0.95, n: 10 },
      { x: wb - 0.6, yb: 0.0, yt: 0.03, hw: 0.8, n: 10 },
      { x: wb - 0.1, yb: 0.02, yt: 0.05, hw: 0.55, n: 10 },
      { x: wb + 0.55, yb: 0.2, yt: 0.23, hw: 0.5, n: 10 },
    ]), 'carbon');
    // 노즈 → 모노코크 → 사이드포드 → 엔진 커버 → 기어박스
    add(loft([
      { x: nose + 0.05, yb: 0.12, yt: 0.2, hw: 0.08, n: 2.4 },
      { x: -0.4, yb: 0.13, yt: 0.33, hw: 0.14 },
      { x: 0.3, yb: 0.12, yt: 0.5, hw: 0.22 },
      { x: 0.9, yb: 0.03, yt: 0.62, hw: 0.38, n: 3 },
      { x: 1.35, yb: 0.03, yt: 0.66, hw: 0.78, n: 4 },
      { x: 2.3, yb: 0.03, yt: 0.66, hw: 0.68, n: 4 },
      { x: 3.0, yb: 0.05, yt: 0.55, hw: 0.36, n: 3 },
      { x: wb + 0.2, yb: 0.12, yt: 0.42, hw: 0.18 },
      { x: wb + 0.65, yb: 0.2, yt: 0.33, hw: 0.08 },
    ]));
    // 에어박스/롤후프와 엔진 커버 핀
    add(loft([
      { x: 1.25, yb: 0.55, yt: 0.82, hw: 0.12 },
      { x: 1.55, yb: 0.55, yt: H, hw: 0.15 },
      { x: 2.4, yb: 0.5, yt: 0.82, hw: 0.14 },
      { x: 3.4, yb: 0.4, yt: 0.55, hw: 0.06 },
    ]));
    // 헤일로
    const halo = new THREE.CatmullRomCurve3([
      new THREE.Vector3(1.5, 0.66, -0.34), new THREE.Vector3(1.05, 0.8, -0.33), new THREE.Vector3(0.72, 0.84, 0),
      new THREE.Vector3(1.05, 0.8, 0.33), new THREE.Vector3(1.5, 0.66, 0.34),
    ]);
    add(new THREE.TubeGeometry(halo, 24, 0.022, 8, false), 'carbon');
    add(rod([0.6, 0.55, 0], [0.74, 0.84, 0], 0.025), 'carbon');
    // 프론트 윙 3엘리먼트 + 엔드플레이트
    add(wing(nose + 0.05, 0.1, 0.28, 0.1, 1.95, 0.08), 'carbon');
    add(wing(nose + 0.3, 0.14, 0.2, 0.09, 1.9, 0.3), 'carbon');
    add(wing(nose + 0.46, 0.2, 0.14, 0.09, 1.85, 0.5), 'carbon');
    for (const z of [-0.98, 0.98]) add(plate(nose + 0.02, nose + 0.62, 0.05, 0.3, z), 'carbon');
    // 리어 윙 + 빔 윙 + 엔드플레이트
    add(wing(tail - 0.55, 0.78, 0.36, 0.12, 1.0, 0.18));
    add(wing(tail - 0.3, 0.88, 0.2, 0.1, 1.0, 0.55));
    add(wing(wb + 0.25, 0.32, 0.22, 0.1, 0.9, 0.15), 'carbon');
    for (const z of [-0.5, 0.5]) add(plate(tail - 0.6, tail - 0.02, 0.35, 0.98, z));
    // 서스펜션 암(장식)
    for (const s of [-1, 1]) {
      const tz = s * (car.track / 2 - 0.12);
      add(rod([-0.1, 0.32, s * 0.22], [0, 0.4, tz]), 'carbon');
      add(rod([0.3, 0.3, s * 0.22], [0, 0.4, tz]), 'carbon');
      add(rod([-0.1, 0.18, s * 0.2], [0, 0.26, tz]), 'carbon');
      add(rod([wb - 0.5, 0.35, s * 0.3], [wb, 0.42, tz]), 'carbon');
      add(rod([wb - 0.3, 0.2, s * 0.3], [wb, 0.25, tz]), 'carbon');
    }
    return parts;
  }

  if (car.shape === 'proto') {
    // 넓고 낮은 터브, 앞뒤 펜더가 바퀴를 덮는다
    add(loft([
      { x: nose + 0.02, yb: 0.08, yt: 0.22, hw: hw * 0.92, n: 8 },
      { x: nose + 0.3, yb: 0.04, yt: 0.4, hw: hw * 0.97, n: 8 },
      { x: -0.1, yb: 0.04, yt: 0.62, hw: hw, n: 8 },
      { x: 0.55, yb: 0.04, yt: 0.55, hw: hw * 0.95, n: 7 },
      { x: 1.3, yb: 0.04, yt: 0.6, hw: hw * 0.9, n: 6 },
      { x: wb - 0.6, yb: 0.04, yt: 0.66, hw: hw, n: 8 },
      { x: wb + 0.2, yb: 0.08, yt: 0.72, hw: hw, n: 8 },
      { x: tail - 0.05, yb: 0.3, yt: 0.72, hw: hw * 0.95, n: 9 },
    ]));
    // 캐노피
    add(loft([
      { x: 0.2, yb: 0.5, yt: 0.56, hw: 0.32 },
      { x: 0.8, yb: 0.5, yt: H - 0.04, hw: 0.48, n: 3 },
      { x: 1.5, yb: 0.52, yt: H, hw: 0.5, n: 3 },
      { x: 2.3, yb: 0.55, yt: 0.82, hw: 0.32 },
      { x: 2.9, yb: 0.6, yt: 0.68, hw: 0.12 },
    ]), 'glass');
    // 샤크 핀
    add(loft([
      { x: 1.8, yb: 0.7, yt: H - 0.05, hw: 0.012, n: 6 },
      { x: tail - 0.5, yb: 0.7, yt: 1.0, hw: 0.012, n: 6 },
    ]));
    add(box(nose - 0.02, nose + 0.45, 0.04, 0.06, hw * 0.9), 'carbon'); // 스플리터
    add(wing(tail - 0.5, 0.96, 0.42, 0.11, car.width * 0.95, 0.2), 'carbon');
    for (const z of [-hw * 0.95, hw * 0.95]) add(plate(tail - 0.6, tail, 0.6, 1.08, z), 'carbon');
    return parts;
  }

  // gt / road: 쿠페 차체 + 그린하우스
  const gt = car.shape === 'gt';
  add(loft([
    { x: nose + 0.02, yb: 0.14, yt: 0.42, hw: hw * 0.8, n: 4 },
    { x: nose + 0.35, yb: 0.09, yt: 0.62, hw: hw * 0.97, n: 5 },
    { x: 0.2, yb: 0.08, yt: 0.72, hw: hw, n: 5 },
    { x: 1.2, yb: 0.08, yt: 0.8, hw: hw * 0.96, n: 5 },
    { x: wb - 0.1, yb: 0.09, yt: 0.86, hw: hw, n: 5 },
    { x: tail - 0.25, yb: 0.2, yt: 0.88, hw: hw * 0.95, n: 6 },
    { x: tail - 0.02, yb: 0.32, yt: 0.82, hw: hw * 0.85, n: 6 },
  ]));
  add(loft([
    { x: 0.25, yb: 0.72, yt: 0.76, hw: hw * 0.72 },
    { x: 0.95, yb: 0.74, yt: H - 0.02, hw: hw * 0.7, n: 3 },
    { x: 1.75, yb: 0.76, yt: H, hw: hw * 0.68, n: 3 },
    { x: gt ? wb + 0.3 : tail - 0.3, yb: 0.8, yt: 0.92, hw: hw * 0.62 },
  ]), 'glass');
  if (gt) {
    add(box(nose - 0.06, nose + 0.4, 0.05, 0.08, hw * 0.92), 'carbon'); // 스플리터
    add(wing(tail - 0.5, H - 0.02, 0.38, 0.12, car.width * 0.9, 0.18), 'carbon');
    for (const z of [-hw * 0.9, hw * 0.9]) add(plate(tail - 0.55, tail - 0.1, H - 0.12, H + 0.12, z), 'carbon');
    for (const z of [-0.45, 0.45]) add(plate(tail - 0.4, tail - 0.25, 0.85, H - 0.02, z, 0.03), 'carbon');
  } else {
    add(box(nose + 0.05, nose + 0.5, 0.08, 0.1, hw * 0.85), 'carbon'); // 작은 립 스포일러
  }
  return parts;
}

function wheelRadius(car) {
  return car.shape === 'open' ? 0.36 : car.shape === 'road' ? 0.35 : 0.36;
}

export function buildCar(car, { opacity = 1 } = {}) {
  const mats = {
    paint: new THREE.MeshStandardMaterial({ color: car.paint, metalness: 0.35, roughness: 0.38, side: THREE.DoubleSide }),
    carbon: new THREE.MeshStandardMaterial({ color: 0x1b1f24, metalness: 0.2, roughness: 0.55, side: THREE.DoubleSide }),
    glass: new THREE.MeshStandardMaterial({ color: 0x223040, metalness: 0.6, roughness: 0.15, side: THREE.DoubleSide }),
    tire: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9, side: THREE.DoubleSide }),
    rim: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.8, roughness: 0.3, side: THREE.DoubleSide }),
  };
  if (opacity < 1) Object.values(mats).forEach((m) => { m.transparent = true; m.opacity = opacity; });

  const root = new THREE.Group();
  const body = new THREE.Group();
  const wheels = new THREE.Group();
  root.add(body, wheels);

  for (const { geo, role } of bodyParts(car)) {
    const mesh = new THREE.Mesh(geo, mats[role]);
    mesh.castShadow = true;
    mesh.userData.part = 'body';
    body.add(mesh);
  }

  const R = wheelRadius(car);
  const wheelDefs = [];
  for (const [x, w] of [[0, car.shape === 'open' ? 0.3 : 0.3], [car.wheelbase, car.shape === 'open' ? 0.4 : 0.32]]) {
    for (const s of [-1, 1]) {
      const z = s * (car.track / 2);
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(R, R, w, 32), mats.tire);
      tire.rotation.x = Math.PI / 2;
      tire.position.set(x, R, z);
      tire.castShadow = true;
      tire.userData = { part: 'wheel', cx: x, cy: R, r: R };
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.62, R * 0.62, w + 0.01, 20), mats.rim);
      rim.rotation.x = Math.PI / 2;
      rim.position.copy(tire.position);
      rim.userData = { part: 'deco' };
      wheels.add(tire, rim);
      wheelDefs.push({ x, z, R });
    }
  }
  root.userData = { car, body, wheels, R, mats };
  setAttitude(root, car.rideFront, car.rideRear);
  return root;
}

// 라이드하이트(mm)로 차체 높이와 피치를 맞춘다. 차체 로컬 y=0이 플로어 바닥.
export function setAttitude(root, hFmm, hRmm) {
  const { car, body } = root.userData;
  const hF = hFmm / 1000;
  const hR = hRmm / 1000;
  body.position.set(0, hF, 0);
  body.rotation.z = Math.atan2(hR - hF, car.wheelbase);
  root.updateMatrixWorld(true);
}

export function disposeCar(root) {
  root.traverse((o) => {
    // 불러온 모델의 지오메트리는 원본과 공유하므로 남겨 둔다
    if (o.geometry && !o.userData.shared) o.geometry.dispose();
  });
  Object.values(root.userData.mats ?? {}).forEach((m) => m.dispose());
}

// 불러온 glTF 모델을 차체/바퀴로 나눠 이 좌표계에 맞춘다.
// - 가장 긴 축을 길이(x), 가장 짧은 축을 높이(y)로 자동 정렬
// - 이름에 wheel/tire/rim/brake가 들어간 부품은 바퀴(언스프렁)로 분리
// - 바퀴가 있으면 휠베이스를 프리셋에 맞추고 앞차축을 x=0에 둔다
const WHEEL_RE = /wheel|tire|tyre|rim|brake/i;
const NOT_WHEEL_RE = /steer/i;

function isWheelMesh(o) {
  for (let n = o; n; n = n.parent) {
    if (n.name && NOT_WHEEL_RE.test(n.name)) return false;
    if (n.name && WHEEL_RE.test(n.name)) return true;
  }
  return false;
}

export function fitImportedModel(object, car, { flipLong = false, flipUp = false } = {}) {
  const holder = new THREE.Group();
  holder.add(object);
  holder.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3()).toArray();
  const order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
  const axis = (i) => new THREE.Vector3(...[0, 1, 2].map((k) => (k === i ? 1 : 0)));
  const eLong = axis(order[0]);
  const eUp = axis(order[2]);
  const eSide = new THREE.Vector3().crossVectors(eLong, eUp);
  // 모델 축 → 장면 축 회전 (행렬의 행이 모델 기준 단위벡터)
  const m = new THREE.Matrix4().set(
    eLong.x, eLong.y, eLong.z, 0,
    eUp.x, eUp.y, eUp.z, 0,
    eSide.x, eSide.y, eSide.z, 0,
    0, 0, 0, 1,
  );
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  // 부품 이름(헤드라이트·앞유리 vs 테일라이트·리어)으로 앞쪽을 찾아 노즈가 -x를 향하게 한다
  holder.quaternion.copy(q);
  holder.updateMatrixWorld(true);
  const centerX = (re) => {
    const xs = [];
    object.traverse((o) => {
      if (!o.isMesh) return;
      for (let n = o; n; n = n.parent) {
        if (n.name && re.test(n.name)) {
          xs.push(new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).x);
          return;
        }
      }
    });
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const fx = centerX(/head|windshield|windscreen|front|hood|bonnet/i);
  const rx = centerX(/tail|rear|back/i);
  if (fx !== null && rx !== null && fx > rx) flipLong = !flipLong;
  if (flipLong) q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  if (flipUp) q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
  holder.quaternion.copy(q);
  holder.updateMatrixWorld(true);

  const meshes = [];
  object.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const wheelMeshes = meshes.filter(isWheelMesh);
  const boxOf = (list) => list.reduce((b, o) => b.expandByObject(o), new THREE.Box3());

  box = boxOf(meshes);
  const midX = (box.min.x + box.max.x) / 2;
  let xf = box.min.x + car.frontOverhang * ((box.max.x - box.min.x) / car.length);
  let scale = car.length / (box.max.x - box.min.x);
  if (wheelMeshes.length >= 2) {
    const front = wheelMeshes.filter((o) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).x < midX);
    const rear = wheelMeshes.filter((o) => !front.includes(o));
    if (front.length && rear.length) {
      xf = boxOf(front).getCenter(new THREE.Vector3()).x;
      const xr = boxOf(rear).getCenter(new THREE.Vector3()).x;
      scale = car.wheelbase / (xr - xf);
    }
  }
  const ground = (wheelMeshes.length ? boxOf(wheelMeshes) : box).min.y;
  const zc = (box.min.z + box.max.z) / 2;
  holder.scale.setScalar(scale);
  holder.position.set(-xf * scale, -ground * scale, -zc * scale);
  holder.updateMatrixWorld(true);

  const bodyGroup = new THREE.Group();
  const wheelGroup = new THREE.Group();
  for (const w of wheelMeshes) {
    wheelGroup.attach(w);
    const b = new THREE.Box3().setFromObject(w);
    const c = b.getCenter(new THREE.Vector3());
    w.userData = { part: 'wheel', cx: c.x, cy: c.y, r: (b.max.y - b.min.y) / 2 };
  }
  const bodyMeshes = meshes.filter((o) => !wheelMeshes.includes(o));
  const bodyMinY = bodyMeshes.length ? boxOf(bodyMeshes).min.y : 0;
  bodyGroup.attach(holder);
  // 차체 로컬 y=0이 차체 바닥이 되도록 (모델 자체의 지상고는 버리고 프리셋 라이드하이트를 쓴다)
  bodyGroup.position.y = -bodyMinY;
  for (const o of bodyMeshes) o.userData = { part: 'body' };
  for (const o of meshes) {
    o.castShadow = true;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((mat) => { mat.side = THREE.DoubleSide; });
  }
  return { bodyGroup, wheelGroup, wheels: wheelMeshes.length, scale };
}

// 풍동 격자에 넣을 고체 마스크. 위에서 아래로 광선을 쏴서 메시 내부 구간을 칠한다.
// mode 'center': z=0 중앙 단면 / 'silhouette': 여러 z 단면의 합집합(측면 실루엣)
// 라이드하이트는 격자에서 '기본 gap0칸 + mm당 cellsPerMm칸'으로 과장한다.
// 수 cm 칸으로 실제 15~40mm 틈을 그대로 넣으면 틈이 1~2칸이 되어 점성 윤활막(양력)처럼 동작하기 때문.
export function rasterize(roots, grid, mode = 'center', { gap0 = 4, cellsPerMm = 0.1 } = {}) {
  const { NX, NY, x0, dx, u0 } = grid;
  const solid = new Uint8Array(NX * NY);
  const wux = new Float32Array(NX * NY);
  const wuy = new Float32Array(NX * NY);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const top = NY * dx + 1;

  roots.forEach(({ root, id }) => {
    const { car, body } = root.userData;
    // 불러온 모델은 보통 닫힌 솔리드가 아니라 겉면(껍데기)이라 내부 판정 대신 외곽 포락선을 쓴다
    const envelope = !!root.userData.imported;
    root.updateMatrixWorld(true);
    // 앞/뒤 차축 위치의 실제 라이드하이트 → 과장된 격자 틈으로 옮기는 선형 보정 Δ(x)
    const axleF = new THREE.Vector3(0, 0, 0).applyMatrix4(body.matrixWorld);
    const axleR = new THREE.Vector3(car.wheelbase, 0, 0).applyMatrix4(body.matrixWorld);
    const dF = (gap0 + axleF.y * 1000 * cellsPerMm) * dx - axleF.y;
    const dR = (gap0 + axleR.y * 1000 * cellsPerMm) * dx - axleR.y;
    const lift = (x) => dF + ((x - axleF.x) / (axleR.x - axleF.x)) * (dR - dF);
    const zs = mode === 'center' ? [0] : Array.from({ length: 9 }, (_, k) => (k / 8 - 0.5) * car.width * 0.98);
    const meshes = [];
    root.traverse((o) => {
      if (!o.isMesh || o.userData.part === 'deco') return;
      if (o.userData.part === 'wheel' && mode === 'center') return;
      meshes.push({ mesh: o, bb: new THREE.Box3().setFromObject(o), wheel: o.userData.part === 'wheel' });
    });
    const fill = (gx, ylo, yhi, shift) => {
      const g0 = Math.max(1, Math.round((ylo + shift) / dx));
      const g1 = Math.min(NY - 2, Math.max(g0, Math.round((yhi + shift) / dx)));
      for (let gy = g0; gy <= g1; gy++) {
        const c = gy * NX + gx;
        solid[c] = id;
        wux[c] = 0;
        wuy[c] = 0;
      }
    };
    for (let gx = 0; gx < NX; gx++) {
      const x = x0 + (gx + 0.5) * dx;
      for (const z of zs) {
        let envLo = Infinity;
        let envHi = -Infinity;
        for (const { mesh, bb, wheel } of meshes) {
          if (x < bb.min.x || x > bb.max.x || z < bb.min.z || z > bb.max.z) continue;
          ray.set(new THREE.Vector3(x, top, z), down);
          const hits = ray.intersectObject(mesh, false).map((h) => h.point.y);
          if (envelope && !wheel) {
            for (const y of hits) { envLo = Math.min(envLo, y); envHi = Math.max(envHi, y); }
            continue;
          }
          if (hits.length < 2) continue;
          const spans = [];
          if (hits.length % 2 === 0) for (let k = 0; k < hits.length; k += 2) spans.push([hits[k + 1], hits[k]]);
          else spans.push([hits[hits.length - 1], hits[0]]); // 닫히지 않은 메시: 바깥 껍질만
          const shift = wheel ? 0 : lift(x);
          for (const [ylo, yhi] of spans) {
            const g0 = Math.max(1, Math.round((ylo + shift) / dx));
            const g1 = Math.min(NY - 2, Math.max(g0, Math.round((yhi + shift) / dx)));
            for (let gy = g0; gy <= g1; gy++) {
              const c = gy * NX + gx;
              if (wheel) {
                // 바퀴 표면 속도: 접지점이 노면과 같은 속도가 되도록 회전
                const { cx, cy, r } = mesh.userData;
                // 바퀴 중심은 바퀴 그룹(차 루트 기준) 좌표로 저장되어 있다
                const wpos = new THREE.Vector3(cx, cy, 0).applyMatrix4(root.userData.wheels.matrixWorld);
                const om = u0 / (r / dx);
                if (!solid[c] || (solid[c] & 7) !== id) {
                  wux[c] = -om * (gy - wpos.y / dx);
                  wuy[c] = om * (gx - (wpos.x - x0) / dx);
                }
                if (!solid[c]) solid[c] = id | 8;
              } else {
                solid[c] = id;
                wux[c] = 0;
                wuy[c] = 0;
              }
            }
          }
        }
        if (envHi > envLo) fill(gx, envLo, envHi, lift(x));
      }
    }
  });
  return { solid, wux, wuy };
}
