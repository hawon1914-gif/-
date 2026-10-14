// 3D 풍동: three.js 장면 + 유체 해석기(GPU 우선, 안 되면 CPU 워커) + 2D 유동장 + 3D 유선.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer, RenderPass, EffectPass, SMAAEffect, BloomEffect, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import * as P from './physics.js';
import { buildCar, setAttitude, disposeCar, rasterize, fitImportedModel } from './model3d.js';
import { createSolver } from './solver.js';

const U0 = 0.12; // 격자 단위 자유류 속도 (마하수 ≈ 0.2)
const NU = 0.004; // 격자 단위 동점성
const VIS_SPEED = 9; // 3D 유선의 화면상 속도 (m/s, 실제 속도와 무관하게 보기 좋게 축소)
const TRAIL = 12; // 유선 꼬리 길이(점 개수)

// 그래픽 품질 단계. 자동 모드는 '높음'에서 시작해 프레임이 떨어지면 한 단계씩 내린다.
const QUALITY = {
  high: { post: true, shadows: true, pixelRatio: 2, particles: 2600, label: '높음' },
  medium: { post: false, shadows: true, pixelRatio: 1.5, particles: 2200, label: '보통' },
  low: { post: false, shadows: false, pixelRatio: 1, particles: 1400, label: '낮음' },
};
const ORDER = ['high', 'medium', 'low'];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

// 발산형 색: 파랑(느림·저압·시계방향) - 흰색(자유류) - 빨강(빠름·고압·반시계)
const DIV = [[0.1, 0.3, 0.85], [0.55, 0.7, 0.95], [0.96, 0.96, 0.96], [0.97, 0.6, 0.45], [0.8, 0.12, 0.12]];
function ramp(stops, t) {
  if (!Number.isFinite(t)) t = 0.5;
  t = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// 아스팔트 질감: 미세한 알갱이 노이즈 + 차선. 차량 기준 좌표계라 텍스처가 흘러가며 속도감을 준다.
function paintAsphalt(ctx, size, base, line) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let k = 0; k < d.length; k += 4) {
    const n = (Math.random() - 0.5) * 26;
    d[k] += n; d[k + 1] += n; d[k + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = line;
  ctx.fillRect(0, size * 0.485, size * 0.45, size * 0.03);
}

// 차 바로 아래가 어두워지는 접촉 그림자용 텍스처
function contactShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export function createTunnel({ viewport, fieldCanvas, hud, status, getCar, getEnv }) {
  const opts = {
    speedKmh: 250, attitude: 'cruise', section: 'center', view: 'speed',
    leader: false, gap: 10, quality: 'std', ghost: false, plane: true, streaks: true,
    graphics: 'auto',
  };

  // ---------- three.js 장면 ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewport.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 300);
  camera.position.set(-6.5, 3.2, 7.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(1.6, 0.4, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 2;
  controls.maxDistance = 60;

  // 환경 반사: 이미지 파일 없이 스튜디오 조명 환경을 만들어 도장·유리에 반사를 준다
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x30363d, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-4, 9, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  const asphaltCanvas = document.createElement('canvas');
  asphaltCanvas.width = asphaltCanvas.height = 512;
  const groundTex = new THREE.CanvasTexture(asphaltCanvas);
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.repeat.set(16, 4);
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 30), new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.92, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(4, -0.001, 0);
  ground.receiveShadow = true;
  scene.add(ground);
  const shadowTex = contactShadowTexture();

  function applyTheme() {
    paintAsphalt(asphaltCanvas.getContext('2d'), 512, css('--asphalt'), css('--asphalt-line'));
    groundTex.needsUpdate = true;
    const bg = new THREE.Color(css('--scene-bg'));
    scene.background = bg;
    scene.fog = new THREE.Fog(bg, 30, 90);
  }
  applyTheme();

  // 단면(컷 플레인): 자유류와 비슷한 곳은 투명하게 해서 교란된 흐름만 보이게 한다
  const texCanvas = document.createElement('canvas');
  let planeTex = new THREE.CanvasTexture(texCanvas);
  planeTex.colorSpace = THREE.SRGBColorSpace;
  const cutPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: planeTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false }));
  scene.add(cutPlane);

  // ---------- 유선: 꼬리가 점점 흐려지는 궤적 ----------
  const NP_MAX = QUALITY.high.particles;
  const pos = new Float32Array(NP_MAX * 3);
  const hist = new Float32Array(NP_MAX * TRAIL * 3); // 입자별 최근 위치 (0 = 머리)
  const speed = new Float32Array(NP_MAX);
  const SEG = TRAIL - 1;
  const linePos = new Float32Array(NP_MAX * SEG * 6);
  const lineCol = new Float32Array(NP_MAX * SEG * 8);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 4).setUsage(THREE.DynamicDrawUsage));
  const streaks = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
  streaks.frustumCulled = false;
  scene.add(streaks);
  let NP = QUALITY.medium.particles;

  const arrows = new THREE.Group();
  scene.add(arrows);

  // ---------- 후처리 (품질 '높음') ----------
  let composer = null;
  let aoPass = null;
  function buildComposer() {
    composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    composer.addPass(new RenderPass(scene, camera));
    aoPass = new N8AOPostPass(scene, camera, 1, 1);
    aoPass.configuration.aoRadius = 0.6;
    aoPass.configuration.distanceFalloff = 0.6;
    aoPass.configuration.intensity = 1.4;
    aoPass.configuration.halfRes = true;
    composer.addPass(aoPass);
    composer.addPass(new EffectPass(camera,
      new BloomEffect({ luminanceThreshold: 0.9, intensity: 0.35, mipmapBlur: true }),
      new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
      new SMAAEffect()));
  }

  // ---------- 상태 ----------
  let car = null;
  let main = null; // 뒤차(측정 대상)
  let lead = null; // 앞차
  let imported = null; // 원본 glTF 장면(복제해서 앞차/뒤차에 붙인다)
  let importFlip = { flipLong: false, flipUp: false };
  let importInfo = '';
  let importOpts = {};
  let grid = null;
  let field = null; // 가장 최근 유동장
  let fieldPrev = null; // 그 직전 유동장 (유선 보간용)
  let fieldAt = 0;
  let fieldPrevAt = 0;
  let solver = null;
  let lastFrameAt = 0;
  let maskTimer = null;
  let modelState = null;
  let gpuFailed = false;
  let quality = 'high';
  // 차체 자세는 목표값으로 감쇠 이동한다 (서스펜션처럼)
  const pose = { main: null, lead: null };

  function makeSolver() {
    solver?.dispose();
    field = fieldPrev = null;
    solver = createSolver({ preferGpu: !gpuFailed });
    try {
      solver.init({ NX: grid.NX, NY: grid.NY, u0: U0, nu: NU, cs: 0.16 });
    } catch (err) {
      console.warn('GPU 해석기 초기화 실패, CPU로 대체:', err);
      gpuFailed = true;
      solver.dispose();
      grid = gridFor();
      solver = createSolver({ preferGpu: false });
      solver.init({ NX: grid.NX, NY: grid.NY, u0: U0, nu: NU, cs: 0.16 });
    }
    solver.run();
  }

  function onField(f) {
    fieldPrev = field;
    fieldPrevAt = fieldAt;
    field = f;
    fieldAt = performance.now();
    drawField();
    updateHud();
  }

  function gridFor() {
    // 불러온 모델이 프리셋보다 크면(원래 크기 비행기 등) 모델 크기에 맞춰 영역을 넓힌다
    const ext = main?.userData.extent;
    const fo = Math.max(car.frontOverhang, ext ? -ext.noseX : 0);
    const tail = Math.max(car.length - car.frontOverhang, ext ? ext.tailX : 0);
    const L = fo + tail;
    // GPU는 훨씬 촘촘한 격자를 감당한다
    const gpu = !gpuFailed;
    const NX = opts.quality === 'hi' ? (gpu ? 1024 : 560) : (gpu ? 640 : 400);
    const leadX = -opts.gap - L;
    const xStart = (opts.leader ? leadX - fo : -fo) - 0.5 * L;
    const xEnd = tail + 1.4 * L;
    const dx = (xEnd - xStart) / NX;
    // 천장이 낮으면 2D 막힘 효과로 차 위 흐름이 과하게 빨라진다 → 차 높이의 약 6배 확보
    const H = Math.max(car.height, ext ? ext.height : 0);
    const NY = Math.min(Math.round(NX * 0.42), Math.max(64, Math.round(Math.max(H * 6, 0.26 * (xEnd - xStart)) / dx)));
    return { NX, NY, dx, x0: xStart, u0: U0, leadX, L, fo, tail };
  }

  // 물리 모델로 현재 조건의 라이드하이트·하중을 구한다
  function computeAttitude() {
    const env = getEnv();
    const v = P.toMs(opts.speedKmh);
    if (opts.attitude === 'static') {
      return { hF: car.rideFront, hR: car.rideRear, s: P.aeroState(car, env, { v: 0 }), a: 0 };
    }
    const gap = opts.leader ? opts.gap : Infinity;
    if (opts.attitude === 'brake') {
      const b = P.maxBraking(car, env, v, { gap, ideal: false });
      return { hF: b.state.hF, hR: b.state.hR, s: b.state, a: -b.a };
    }
    const s = P.aeroState(car, env, { v, gap });
    return { hF: s.hF, hR: s.hR, s, a: 0 };
  }

  function addContactShadow(root) {
    const ext = root.userData.extent;
    const len = ext ? ext.tailX - ext.noseX : car.length;
    const x0 = ext ? ext.noseX : -car.frontOverhang;
    const wid = ext ? Math.min(ext.width, car.width * 1.3) : car.width;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len * 1.08, wid * 1.2), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, fog: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x0 + len / 2, 0.003, 0);
    m.userData.part = 'deco';
    m.renderOrder = -1;
    root.add(m);
  }

  function rebuild() {
    car = getCar();
    [main, lead].forEach((r) => { if (r) { scene.remove(r); disposeCar(r); } });
    main = buildCar(car, { opacity: opts.ghost ? 0.35 : 1 });
    if (imported) attachImported(main);
    addContactShadow(main);
    scene.add(main);
    lead = null;
    if (opts.leader) {
      lead = buildCar(car, { opacity: opts.ghost ? 0.35 : 1 });
      if (imported) attachImported(lead);
      addContactShadow(lead);
      scene.add(lead);
    }
    grid = gridFor();
    makeSolver();
    pose.main = pose.lead = null;
    applyAttitude(true);
    const W = grid.NX * grid.dx;
    const H = grid.NY * grid.dx;
    cutPlane.geometry.dispose();
    cutPlane.geometry = new THREE.PlaneGeometry(W, H);
    cutPlane.position.set(grid.x0 + W / 2, H / 2, 0);
    // 그림자 범위를 풍동 영역에 맞춘다
    const cx = grid.x0 + W / 2;
    sun.position.set(cx - 4, 9, 6);
    sun.target.position.set(cx, 0, 0);
    Object.assign(sun.shadow.camera, { left: -W / 2, right: W / 2, top: 8, bottom: -8, near: 1, far: 40 });
    sun.shadow.camera.updateProjectionMatrix();
    seedAll();
    frameCamera();
  }

  // 차(앞차 포함)가 화면에 들어오도록 카메라를 맞춘다
  function frameCamera() {
    const x0 = (opts.leader ? grid.leadX : 0) - grid.fo;
    const x1 = grid.tail;
    const span = x1 - x0;
    const cx = (x0 + x1) / 2;
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.set(cx, 0.4, 0);
    // 비행기처럼 폭이 길이보다 큰 모델도 화면에 들어오도록 폭도 고려한다
    const width = main?.userData.extent?.width ?? car.width;
    camera.position.copy(controls.target).add(dir.multiplyScalar(Math.max(8, span * 1.15, width * 1.6)));
  }

  function leadTarget() {
    const env = getEnv();
    // 앞차는 같은 속도로 단독 주행하는 자세
    const s = opts.attitude === 'static' ? { hF: car.rideFront, hR: car.rideRear } : P.aeroState(car, env, { v: P.toMs(opts.speedKmh) });
    return { hF: s.hF, hR: s.hR };
  }

  function applyAttitude(immediate = false) {
    modelState = computeAttitude();
    const tMain = { hF: modelState.hF, hR: modelState.hR };
    if (!pose.main || immediate) pose.main = { ...tMain, vF: 0, vR: 0 };
    pose.main.target = tMain;
    if (lead) {
      lead.position.x = grid.leadX;
      const t = leadTarget();
      if (!pose.lead || immediate) pose.lead = { ...t, vF: 0, vR: 0 };
      pose.lead.target = t;
    }
    setAttitude(main, pose.main.hF, pose.main.hR);
    if (lead) setAttitude(lead, pose.lead.hF, pose.lead.hR);
    drawArrows();
    clearTimeout(maskTimer);
    maskTimer = setTimeout(sendMask, immediate ? 0 : 150);
  }

  // 임계 감쇠 스프링으로 현재 자세를 목표 자세로 옮긴다
  function animatePose(root, p, dt) {
    if (!p?.target) return;
    const w = 9; // 고유 진동수 (rad/s)
    for (const [h, v] of [['hF', 'vF'], ['hR', 'vR']]) {
      const x = p[h] - p.target[h];
      const a = -w * w * x - 2 * w * p[v];
      p[v] += a * dt;
      p[h] += p[v] * dt;
    }
    setAttitude(root, p.hF, p.hR);
  }

  function sendMask() {
    status.textContent = '형상을 격자로 변환 중…';
    requestAnimationFrame(() => {
      const t0 = performance.now();
      // 격자는 애니메이션 중간 자세가 아니라 목표 자세로 만든다
      setAttitude(main, pose.main.target.hF, pose.main.target.hR);
      if (lead) setAttitude(lead, pose.lead.target.hF, pose.lead.target.hR);
      const roots = [{ root: main, id: 1 }];
      if (lead) roots.push({ root: lead, id: 2 });
      const m = rasterize(roots, grid, opts.section, {}, renderer);
      setAttitude(main, pose.main.hF, pose.main.hR);
      if (lead) setAttitude(lead, pose.lead.hF, pose.lead.hR);
      solver.setMask(m);
      const kind = solver.kind === 'gpu' ? 'GPU 해석' : 'CPU 해석 (이 브라우저에서 GPU 계산 불가)';
      status.textContent = `${kind} · 격자 ${grid.NX}×${grid.NY}, 칸 크기 ${(grid.dx * 100).toFixed(1)} cm · 변환 ${(performance.now() - t0).toFixed(0)} ms${importInfo}`;
    });
  }

  function drawArrows() {
    arrows.clear();
    if (opts.attitude === 'static' || !modelState) return;
    const s = modelState.s;
    const scale = 1.4 / (car.mass * P.G);
    const mk = (x, y, len, color) => {
      const a = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(x, y + len, car.width / 2 + 0.25), len, color, 0.18, 0.12);
      arrows.add(a);
    };
    mk(0, 1.0, Math.max(0.05, s.dfF * scale), new THREE.Color(css('--front')));
    mk(car.wheelbase, 1.0, Math.max(0.05, s.dfR * scale), new THREE.Color(css('--rear')));
    const d = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(grid.tail + 0.1, 0.6, 0), Math.max(0.05, s.drag * scale * 2), new THREE.Color(css('--drag')), 0.18, 0.12);
    arrows.add(d);
  }

  // ---------- glTF 불러오기 ----------
  function attachImported(root) {
    const { body, wheels } = root.userData;
    for (const g of [body, wheels]) {
      g.children.slice().forEach((c) => {
        c.traverse((o) => o.geometry?.dispose());
        g.remove(c);
      });
    }
    const fit = fitImportedModel(imported.clone(true), car, { ...importFlip, nativeScale: importOpts.nativeScale });
    root.userData.extent = { noseX: fit.noseX, tailX: fit.tailX, height: fit.height, width: fit.width };
    fit.bodyGroup.traverse((o) => { o.userData.shared = true; });
    fit.wheelGroup.traverse((o) => { o.userData.shared = true; });
    body.add(fit.bodyGroup);
    wheels.add(fit.wheelGroup);
    root.userData.imported = true;
    importInfo = ` · 불러온 모델: 바퀴 부품 ${fit.wheels}개 분리${fit.wheels ? '' : ' (바퀴를 못 찾아 차 길이에 맞춤)'}`;
  }

  async function fetchModel(url) {
    // 단일 파일 빌드에는 모델이 base64로 들어 있다
    const embedded = globalThis.AEROLAB_ASSETS?.[url];
    if (embedded) return Uint8Array.from(atob(embedded), (c) => c.charCodeAt(0)).buffer;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}을(를) 읽을 수 없습니다 (${res.status})`);
    return res.arrayBuffer();
  }

  async function loadModel(source, modelOpts = {}) {
    importOpts = modelOpts;
    const name = source.name ?? source;
    status.textContent = `${name} 불러오는 중…`;
    const buf = typeof source === 'string' ? await fetchModel(source) : await source.arrayBuffer();
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
    imported = gltf.scene;
    importFlip = { flipLong: false, flipUp: false };
    rebuild();
  }

  function flipModel(key) {
    if (!imported) return;
    importFlip[key] = !importFlip[key];
    rebuild();
  }

  function clearModel() {
    imported = null;
    importOpts = {};
    importInfo = '';
    rebuild();
  }

  // ---------- 2D 유동장 ----------
  const off = document.createElement('canvas');
  let img = null;
  let timg = null;
  function drawField() {
    if (!field || !grid) return;
    const { NX, NY } = grid;
    if (field.ux.length !== NX * NY) return;
    if (off.width !== NX || off.height !== NY) {
      off.width = NX; off.height = NY;
      img = off.getContext('2d').createImageData(NX, NY);
      // 텍스처 크기가 바뀌면 GPU 텍스처도 새로 만들어야 한다
      texCanvas.width = NX; texCanvas.height = NY;
      timg = texCanvas.getContext('2d').createImageData(NX, NY);
      planeTex.dispose();
      planeTex = new THREE.CanvasTexture(texCanvas);
      planeTex.colorSpace = THREE.SRGBColorSpace;
      cutPlane.material.map = planeTex;
      cutPlane.material.needsUpdate = true;
    }
    const td = timg.data;
    const { ux, uy, rho, solid } = field;
    const d = img.data;
    const bodyCol = hexRgb(css('--solid'));
    const groundCol = hexRgb(css('--asphalt'));
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const c = y * NX + x;
        const p = ((NY - 1 - y) * NX + x) * 4;
        const s = solid[c];
        let col;
        let t = 0.5;
        if (s === 255) col = groundCol;
        else if (s) col = bodyCol;
        else {
          if (opts.view === 'speed') {
            // 자유류 대비 속도: 0 → 0, 자유류 → 0.5, 1.5배 → 1
            const r = Math.hypot(ux[c], uy[c]) / U0;
            t = r < 1 ? 0.5 * r : 0.5 + (r - 1);
          } else if (opts.view === 'vort') {
            const w = x > 0 && x < NX - 1 && y > 0 && y < NY - 1
              ? (uy[c + 1] - uy[c - 1] - ux[c + NX] + ux[c - NX]) / 2 : 0;
            t = 0.5 + w / (U0 * 0.5);
          } else {
            // 압력계수 Cp = (p - p∞) / (½ρu0²), p = ρ/3
            const cp = ((rho[c] - 1) / 3) / (0.5 * U0 * U0);
            t = 0.5 + cp / 2;
          }
          col = ramp(DIV, t).map((v) => v * 255);
        }
        d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; d[p + 3] = 255;
        const a = s ? 0 : Math.min(1, Math.abs(t - 0.5) * 5);
        td[p] = col[0]; td[p + 1] = col[1]; td[p + 2] = col[2]; td[p + 3] = a * 235;
      }
    }
    off.getContext('2d').putImageData(img, 0, 0);
    texCanvas.getContext('2d').putImageData(timg, 0, 0);
    const w = fieldCanvas.parentElement.clientWidth;
    const h = Math.round((w * NY) / NX);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (fieldCanvas.width !== Math.round(w * dpr) || fieldCanvas.height !== Math.round(h * dpr)) {
      fieldCanvas.width = Math.round(w * dpr);
      fieldCanvas.height = Math.round(h * dpr);
      fieldCanvas.style.height = h + 'px';
    }
    const ctx = fieldCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, fieldCanvas.width, fieldCanvas.height);
    planeTex.needsUpdate = true;
  }

  function hexRgb(hex) {
    const m = hex.replace('#', '');
    const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // ---------- 측정값 ----------
  function forcesFor(id, root) {
    const f = field.force;
    const fx = f[id * 3], fy = f[id * 3 + 1], m = f[id * 3 + 2];
    const Lc = grid.L / grid.dx;
    const qL = 0.5 * U0 * U0 * Lc;
    const cd = fx / qL;
    const cl = -fy / qL; // 다운포스 양수
    // 압력중심 → 앞/뒤 축 분배
    let bal = null;
    if (Math.abs(fy) > 1e-9) {
      const xcp = grid.x0 + (m / fy + 0.5) * grid.dx;
      const xf = root.position.x;
      const xr = root.position.x + car.wheelbase;
      bal = (xr - xcp) / (xr - xf);
    }
    return { cd, cl, bal };
  }

  function updateHud() {
    if (!field || !modelState) return;
    const s = modelState.s;
    const mm = forcesFor(1, main);
    const kg = (n) => (n / P.G).toFixed(0);
    const Re = (U0 * (grid.L / grid.dx)) / NU;
    const ReReal = (P.toMs(opts.speedKmh) * grid.L) / 1.5e-5;
    const rows = [
      ['준정적 모델', `DF ${kg(s.df)} kgf (F ${kg(s.dfF)} · R ${kg(s.dfR)}) · 항력 ${kg(s.drag)} kgf · 밸런스 ${(s.balance * 100).toFixed(1)}% F`],
      ['차 자세', `라이드하이트 F ${modelState.hF.toFixed(1)} mm · R ${modelState.hR.toFixed(1)} mm${s.stalledFront || s.stalledRear ? ' · 실속' : ''}${modelState.a < 0 ? ` · 감속 ${(-modelState.a / P.G).toFixed(2)} G` : ''}`],
      ['LBM 단면 측정', `항력계수 ${mm.cd.toFixed(3)} · 다운포스계수 ${mm.cl.toFixed(3)}${mm.bal !== null && Math.abs(mm.cl) > 0.1 ? ` · 압력중심 ${(Math.min(1.5, Math.max(-0.5, mm.bal)) * 100).toFixed(0)}% F` : ''}`],
    ];
    if (lead) {
      const lm = forcesFor(2, lead);
      // 분모가 0에 가까우면 비율이 의미 없으므로 0.1 미만이면 표시하지 않는다
      const pct = (a, b) => (Math.abs(b) >= 0.1 ? `${a >= b ? '+' : ''}${((a / b - 1) * 100).toFixed(0)}%` : '앞차 값이 작아 비율 생략');
      rows.push(['앞차 대비 (뒤차)', `항력 ${pct(mm.cd, lm.cd)} · 다운포스 ${pct(mm.cl, lm.cl)} (앞차 Cd ${lm.cd.toFixed(3)}, Cl ${lm.cl.toFixed(3)})`]);
    }
    // 공기가 영역을 두 번 통과할 때까지는 초기 과도 상태라 측정값이 흔들린다
    const settle = Math.min(1, field.steps / ((2 * grid.NX) / U0));
    rows.push(['계산', `${solver.kind === 'gpu' ? `GPU ${stepsPerFrame}스텝/프레임` : 'CPU'} · ${field.resets ? `발산해서 ${field.resets}회 재시작 · ` : ''}${settle < 1 ? `흐름 발달 중 ${(settle * 100).toFixed(0)}% · ` : '안정 · '}${field.steps.toLocaleString()} 스텝 · 격자 Re ≈ ${Re.toFixed(0)} (실제 ${ReReal.toExponential(1)}) · 그래픽 ${QUALITY[quality].label}${fpsText}`]);
    hud.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }

  // ---------- 3D 유선 ----------
  function seed(i, anywhere = false) {
    const hw = car.width / 2;
    const span = grid.NX * grid.dx;
    const x = grid.x0 + (anywhere ? Math.random() * span : Math.random() * 0.3);
    const y = 0.03 + Math.random() ** 1.6 * Math.min(grid.NY * grid.dx * 0.6, Math.max(car.height, main?.userData.extent?.height ?? 0) * 2.2);
    const z = Math.random() < 0.75 ? (Math.random() - 0.5) * 2 * hw * 0.9 : (Math.random() - 0.5) * 2 * (hw + 1.5);
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    // 새 입자는 꼬리를 머리 위치로 채워 길이 0에서 시작
    for (let k = 0; k < TRAIL; k++) hist.set([x, y, z], (i * TRAIL + k) * 3);
  }
  function seedAll() {
    for (let i = 0; i < NP_MAX; i++) seed(i, true);
  }

  // 두 유동장 사이를 시간 보간해서 계산 갱신(초당 십수 번) 사이에도 흐름이 매끄럽게 이어지게 한다
  function sample(x, y, blend) {
    const gx = (x - grid.x0) / grid.dx - 0.5;
    const gy = y / grid.dx - 0.5;
    const { NX, NY } = grid;
    if (gx < 0 || gy < 0 || gx >= NX - 1 || gy >= NY - 1) return [U0, 0, false];
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const c = y0 * NX + x0;
    const S = field.solid;
    if (S[c] && S[c] !== 255 && S[c + 1] && S[c + NX] && S[c + NX + 1]) return [0, 0, true];
    const lerp = (A) => (A[c] * (1 - fx) + A[c + 1] * fx) * (1 - fy) + (A[c + NX] * (1 - fx) + A[c + NX + 1] * fx) * fy;
    let vx = lerp(field.ux);
    let vy = lerp(field.uy);
    if (blend < 1 && fieldPrev && fieldPrev.ux.length === field.ux.length) {
      vx = lerp(fieldPrev.ux) * (1 - blend) + vx * blend;
      vy = lerp(fieldPrev.uy) * (1 - blend) + vy * blend;
    }
    return [vx, vy, false];
  }

  function stepStreaks(dt, now) {
    if (!field || field.ux.length !== grid.NX * grid.NY) return;
    const hw = car.width / 2;
    const span = fieldAt - fieldPrevAt;
    const blend = span > 0 ? Math.min(1, (now - fieldAt) / span) : 1;
    for (let i = 0; i < NP; i++) {
      let x = pos[i * 3], y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      let [vx, vy, inside] = sample(x, y, blend);
      // 단면 유동장은 차폭 안에서만 그대로 쓰고, 바깥으로 갈수록 자유류로 섞는다
      const az = Math.abs(z);
      const wz = az <= hw ? 1 : Math.exp(-(((az - hw) / 0.5) ** 2));
      vx = U0 + (vx - U0) * wz;
      vy = vy * wz;
      if (inside && wz > 0.9) { seed(i); continue; }
      const sx = (vx / U0) * VIS_SPEED;
      const sy = (vy / U0) * VIS_SPEED;
      x += sx * dt; y += sy * dt;
      if (y < 0.01) y = 0.01;
      pos[i * 3] = x; pos[i * 3 + 1] = y;
      speed[i] = Math.hypot(sx, sy) / VIS_SPEED;
      if (x > grid.x0 + grid.NX * grid.dx || y > grid.NY * grid.dx) { seed(i); continue; }
      // 꼬리 한 칸씩 밀고 머리에 현재 위치
      const b = i * TRAIL * 3;
      hist.copyWithin(b + 3, b, b + (TRAIL - 1) * 3);
      hist[b] = x; hist[b + 1] = y; hist[b + 2] = z;
    }
    for (let i = 0; i < NP; i++) {
      const sr = speed[i];
      const t = sr < 1 ? 0.5 * sr : 0.5 + (sr - 1);
      const [r, g, bl] = ramp(DIV, t);
      // 자유류와 같은 속도의 공기는 거의 투명하게, 느려지거나 빨라진 공기만 또렷하게
      const vis = 0.12 + 0.88 * Math.min(1, Math.abs(t - 0.5) * 4);
      const b = i * TRAIL * 3;
      for (let k = 0; k < SEG; k++) {
        const o = (i * SEG + k) * 6;
        linePos[o] = hist[b + k * 3]; linePos[o + 1] = hist[b + k * 3 + 1]; linePos[o + 2] = hist[b + k * 3 + 2];
        linePos[o + 3] = hist[b + k * 3 + 3]; linePos[o + 4] = hist[b + k * 3 + 4]; linePos[o + 5] = hist[b + k * 3 + 5];
        // 머리 쪽은 진하게, 꼬리로 갈수록 투명하게
        const a0 = vis * (1 - k / SEG);
        const a1 = vis * (1 - (k + 1) / SEG);
        const q = (i * SEG + k) * 8;
        lineCol[q] = r; lineCol[q + 1] = g; lineCol[q + 2] = bl; lineCol[q + 3] = a0;
        lineCol[q + 4] = r; lineCol[q + 5] = g; lineCol[q + 6] = bl; lineCol[q + 7] = a1;
      }
    }
    lineGeo.setDrawRange(0, NP * SEG * 2);
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;
  }

  // ---------- 그래픽 품질 ----------
  function applyQuality(q) {
    quality = q;
    const Q = QUALITY[q];
    renderer.setPixelRatio(Math.min(Q.pixelRatio, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = Q.shadows;
    sun.castShadow = Q.shadows;
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    NP = Q.particles;
    // 후처리를 쓸 때는 톤 매핑을 후처리 단계에서 한다
    if (Q.post) {
      if (!composer) buildComposer();
      renderer.toneMapping = THREE.NoToneMapping;
    } else {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
    }
    resize();
  }

  // 자동 모드: 3초 평균 프레임이 30fps 아래면 한 단계 내린다
  let fpsWindow = [];
  let fpsText = '';
  let lastDowngrade = 0;
  function watchFps(dtMs, now) {
    fpsWindow.push(dtMs);
    if (fpsWindow.length < 90) return;
    const avg = fpsWindow.reduce((a, b) => a + b, 0) / fpsWindow.length;
    fpsWindow = [];
    fpsText = ` · ${(1000 / avg).toFixed(0)} fps`;
    if (opts.graphics === 'auto' && avg > 1000 / 30 && now - lastDowngrade > 4000) {
      const next = ORDER[ORDER.indexOf(quality) + 1];
      if (next) {
        lastDowngrade = now;
        applyQuality(next);
      }
    }
  }

  // ---------- 루프 ----------
  let last = performance.now();
  let groundOffset = 0;
  let visible = true;
  function resize() {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    composer?.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(viewport);

  // GPU 해석기의 한 프레임당 스텝 수: 프레임이 느리면 줄이고 여유가 있으면 늘려서 화면이 끊기지 않게 한다
  let stepsPerFrame = 8;
  function adaptSteps(dtMs) {
    if (dtMs > 28) stepsPerFrame = Math.max(1, Math.floor(stepsPerFrame * 0.7));
    else if (dtMs < 18) stepsPerFrame = Math.min(grid.NX > 800 ? 40 : 80, stepsPerFrame + 2);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible) return;
    const dtMs = now - last;
    const dt = Math.min(0.05, dtMs / 1000);
    last = now;
    watchFps(dtMs, now);
    if (solver) {
      if (solver.kind === 'gpu') adaptSteps(dtMs);
      solver.step(stepsPerFrame);
      // 화면용 유동장은 초당 약 15번 읽는다
      if (!solver.busy() && now - lastFrameAt > 66) {
        lastFrameAt = now;
        solver.requestFrame(onField);
      }
    }
    animatePose(main, pose.main, dt);
    if (lead) animatePose(lead, pose.lead, dt);
    groundOffset = (groundOffset - dt * VIS_SPEED / 5) % 1;
    groundTex.offset.x = groundOffset;
    cutPlane.visible = opts.plane;
    streaks.visible = opts.streaks;
    if (opts.streaks) stepStreaks(dt, now);
    controls.update();
    if (QUALITY[quality].post && composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  return {
    opts,
    start() {
      applyQuality(opts.graphics === 'auto' ? 'high' : opts.graphics);
      resize();
      rebuild();
      requestAnimationFrame(frame);
    },
    set(patch) {
      const prev = { ...opts };
      Object.assign(opts, patch);
      const needRebuild = ['leader', 'quality', 'ghost'].some((k) => k in patch && patch[k] !== prev[k])
        || ('gap' in patch && opts.leader && patch.gap !== prev.gap);
      if (needRebuild) rebuild();
      else if ('speedKmh' in patch || 'attitude' in patch || 'section' in patch) applyAttitude();
      if ('view' in patch) drawField();
      if ('graphics' in patch && patch.graphics !== prev.graphics) applyQuality(opts.graphics === 'auto' ? 'high' : opts.graphics);
    },
    carChanged() { rebuild(); },
    paramsChanged() { car = getCar(); applyAttitude(); },
    resetFlow() { rebuild(); },
    setVisible(v) {
      visible = v;
      if (solver) solver[v ? 'run' : 'pause']();
      if (v) { resize(); last = performance.now(); }
    },
    themeChanged() { applyTheme(); drawField(); drawArrows(); },
    loadModel, flipModel, clearModel,
  };
}
