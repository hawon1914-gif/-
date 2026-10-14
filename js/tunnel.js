// 3D 풍동: three.js 장면 + LBM 워커 + 2D 유동장 + 3D 유선 입자.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as P from './physics.js';
import { buildCar, setAttitude, disposeCar, rasterize, fitImportedModel } from './model3d.js';

const U0 = 0.12; // 격자 단위 자유류 속도 (마하수 ≈ 0.2)
const NU = 0.004; // 격자 단위 동점성
const VIS_SPEED = 9; // 3D 유선의 화면상 속도 (m/s, 실제 속도와 무관하게 보기 좋게 축소)

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

// 발산형 색: 파랑(느림·저압·시계방향) - 흰색(자유류) - 빨강(빠름·고압·반시계)
const DIV = [[0.1, 0.3, 0.85], [0.55, 0.7, 0.95], [0.96, 0.96, 0.96], [0.97, 0.6, 0.45], [0.8, 0.12, 0.12]];
function ramp(stops, t) {
  t = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function createTunnel({ viewport, fieldCanvas, hud, status, getCar, getEnv }) {
  const opts = {
    speedKmh: 250, attitude: 'cruise', section: 'center', view: 'speed',
    leader: false, gap: 10, quality: 'std', ghost: false, plane: true, streaks: true,
  };

  // ---------- three.js 장면 ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  viewport.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
  camera.position.set(-6.5, 3.2, 7.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(1.6, 0.4, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 2;
  controls.maxDistance = 40;

  scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x30363d, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-4, 9, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 6, bottom: -6, near: 1, far: 30 });
  scene.add(sun);

  // 노면: 차량 기준 좌표계에서 흐르는 차선 표시로 속도감을 준다
  const stripeCanvas = document.createElement('canvas');
  stripeCanvas.width = 256; stripeCanvas.height = 256;
  const sctx = stripeCanvas.getContext('2d');
  const groundTex = new THREE.CanvasTexture(stripeCanvas);
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.repeat.set(16, 4);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 20), new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(4, -0.001, 0);
  ground.receiveShadow = true;
  scene.add(ground);
  const paintGround = () => {
    sctx.fillStyle = css('--asphalt');
    sctx.fillRect(0, 0, 256, 256);
    sctx.fillStyle = css('--asphalt-line');
    sctx.fillRect(0, 124, 120, 8);
    groundTex.needsUpdate = true;
  };
  paintGround();

  // 단면(컷 플레인): 2D 유동장 캔버스를 텍스처로 z=0 평면에 붙인다
  // 3D 컷 플레인용 텍스처: 자유류와 비슷한 곳은 투명하게 해서 교란된 흐름만 보이게 한다
  const texCanvas = document.createElement('canvas');
  let planeTex = new THREE.CanvasTexture(texCanvas);
  planeTex.colorSpace = THREE.SRGBColorSpace;
  const cutPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: planeTex, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false }));
  scene.add(cutPlane);

  // 유선 입자
  const NP = 2600;
  const TRAIL = 6;
  const pos = new Float32Array(NP * 3);
  const vel = new Float32Array(NP * 2);
  const linePos = new Float32Array(NP * 6);
  const lineCol = new Float32Array(NP * 6);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
  const streaks = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
  streaks.frustumCulled = false;
  scene.add(streaks);

  const arrows = new THREE.Group();
  scene.add(arrows);

  // ---------- 상태 ----------
  let car = null;
  let main = null; // 뒤차(측정 대상)
  let lead = null; // 앞차
  let imported = null; // 원본 glTF 장면(복제해서 앞차/뒤차에 붙인다)
  let importFlip = { flipLong: false, flipUp: false };
  let importInfo = '';
  let grid = null;
  let field = null;
  let worker = null;
  let pending = false;
  let lastFrameAt = 0;
  let maskTimer = null;
  let modelState = null;

  function makeWorker() {
    if (worker) worker.terminate();
    // 단일 파일 빌드에서는 워커 코드를 Blob URL로 미리 넣어 둔다 (file://에서도 동작)
    worker = new Worker(globalThis.AEROLAB_WORKER_URL ?? new URL('./lbm-worker.js', import.meta.url));
    worker.onmessage = (e) => {
      if (e.data.type !== 'frame') return;
      field = e.data;
      pending = false;
      drawField();
      updateHud();
    };
  }

  function gridFor() {
    const L = car.length;
    const fo = car.frontOverhang;
    const tail = L - fo;
    const NX = opts.quality === 'hi' ? 560 : 400;
    const leadX = -opts.gap - L;
    const xStart = (opts.leader ? leadX - fo : -fo) - 0.5 * L;
    const xEnd = tail + 1.4 * L;
    const dx = (xEnd - xStart) / NX;
    // 천장이 낮으면 2D 막힘 효과로 차 위 흐름이 과하게 빨라진다 → 차 높이의 약 6배 확보
    const NY = Math.min(Math.round(NX * 0.42), Math.max(64, Math.round(Math.max(car.height * 6, 0.26 * (xEnd - xStart)) / dx)));
    return { NX, NY, dx, x0: xStart, u0: U0, leadX };
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

  function rebuild() {
    car = getCar();
    [main, lead].forEach((r) => { if (r) { scene.remove(r); disposeCar(r); } });
    main = buildCar(car, { opacity: opts.ghost ? 0.35 : 1 });
    if (imported) attachImported(main);
    scene.add(main);
    lead = null;
    if (opts.leader) {
      lead = buildCar(car, { opacity: opts.ghost ? 0.35 : 1 });
      if (imported) attachImported(lead);
      scene.add(lead);
    }
    grid = gridFor();
    makeWorker();
    worker.postMessage({ type: 'init', NX: grid.NX, NY: grid.NY, u0: U0, nu: NU, cs: 0.16 });
    field = null;
    applyAttitude(true);
    worker.postMessage({ type: 'run' });
    const W = grid.NX * grid.dx;
    const H = grid.NY * grid.dx;
    cutPlane.geometry.dispose();
    cutPlane.geometry = new THREE.PlaneGeometry(W, H);
    cutPlane.position.set(grid.x0 + W / 2, H / 2, 0);
    seedAll();
    frameCamera();
  }

  // 차(앞차 포함)가 화면에 들어오도록 카메라를 맞춘다
  function frameCamera() {
    const x0 = (opts.leader ? grid.leadX : 0) - car.frontOverhang;
    const x1 = car.length - car.frontOverhang;
    const span = x1 - x0;
    const cx = (x0 + x1) / 2;
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.set(cx, 0.4, 0);
    camera.position.copy(controls.target).add(dir.multiplyScalar(Math.max(8, span * 1.15)));
  }

  function applyAttitude(immediate = false) {
    modelState = computeAttitude();
    setAttitude(main, modelState.hF, modelState.hR);
    if (lead) {
      // 앞차는 같은 속도로 단독 주행하는 자세
      const env = getEnv();
      const s = opts.attitude === 'static' ? { hF: car.rideFront, hR: car.rideRear } : P.aeroState(car, env, { v: P.toMs(opts.speedKmh) });
      lead.position.x = grid.leadX;
      setAttitude(lead, s.hF, s.hR);
    }
    drawArrows();
    clearTimeout(maskTimer);
    maskTimer = setTimeout(sendMask, immediate ? 0 : 150);
  }

  function sendMask() {
    status.textContent = '형상을 격자로 변환 중…';
    requestAnimationFrame(() => {
      const t0 = performance.now();
      const roots = [{ root: main, id: 1 }];
      if (lead) roots.push({ root: lead, id: 2 });
      const m = rasterize(roots, grid, opts.section);
      worker.postMessage({ type: 'mask', solid: m.solid.buffer, wux: m.wux.buffer, wuy: m.wuy.buffer }, [m.solid.buffer, m.wux.buffer, m.wuy.buffer]);
      status.textContent = `격자 ${grid.NX}×${grid.NY}, 칸 크기 ${(grid.dx * 100).toFixed(1)} cm · 변환 ${(performance.now() - t0).toFixed(0)} ms${importInfo}`;
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
    const d = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(car.length - car.frontOverhang + 0.1, 0.6, 0), Math.max(0.05, s.drag * scale * 2), new THREE.Color(css('--drag')), 0.18, 0.12);
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
    const fit = fitImportedModel(imported.clone(true), car, importFlip);
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

  async function loadModel(source) {
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
    if (fieldCanvas.width !== Math.round(w * dpr)) {
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
    const Lc = car.length / grid.dx;
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
    const Re = (U0 * (car.length / grid.dx)) / NU;
    const ReReal = (P.toMs(opts.speedKmh) * car.length) / 1.5e-5;
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
    rows.push(['계산', `${settle < 1 ? `흐름 발달 중 ${(settle * 100).toFixed(0)}% · ` : '안정 · '}${field.steps.toLocaleString()} 스텝 · 격자 Re ≈ ${Re.toFixed(0)} (실제 ${ReReal.toExponential(1)})`]);
    hud.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }

  // ---------- 3D 유선 ----------
  function seed(i, anywhere = false) {
    const hw = car.width / 2;
    const span = grid.NX * grid.dx;
    pos[i * 3] = grid.x0 + (anywhere ? Math.random() * span : Math.random() * 0.3);
    pos[i * 3 + 1] = 0.03 + Math.random() ** 1.6 * Math.min(grid.NY * grid.dx * 0.6, car.height * 2.2);
    pos[i * 3 + 2] = Math.random() < 0.75 ? (Math.random() - 0.5) * 2 * hw * 0.9 : (Math.random() - 0.5) * 2 * (hw + 1.5);
  }
  function seedAll() {
    for (let i = 0; i < NP; i++) seed(i, true);
  }

  function sample(x, y) {
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
    return [lerp(field.ux), lerp(field.uy), false];
  }

  function stepStreaks(dt) {
    if (!field) return;
    const hw = car.width / 2;
    for (let i = 0; i < NP; i++) {
      let x = pos[i * 3], y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      let [vx, vy, inside] = sample(x, y);
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
      vel[i * 2] = sx; vel[i * 2 + 1] = sy;
      if (x > grid.x0 + grid.NX * grid.dx || y > grid.NY * grid.dx) seed(i);
    }
    const k = TRAIL / 60;
    for (let i = 0; i < NP; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const sx = vel[i * 2], sy = vel[i * 2 + 1];
      linePos.set([x, y, z, x - sx * k, y - sy * k, z], i * 6);
      const sr = Math.hypot(sx, sy) / VIS_SPEED;
      const [r, g, b] = ramp(DIV, sr < 1 ? 0.5 * sr : 0.5 + (sr - 1));
      lineCol.set([r, g, b, r * 0.3, g * 0.3, b * 0.3], i * 6);
    }
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;
  }

  // ---------- 루프 ----------
  let last = performance.now();
  let groundOffset = 0;
  let visible = true;
  function resize() {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(viewport);

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (worker && !pending && now - lastFrameAt > 66) {
      pending = true;
      lastFrameAt = now;
      worker.postMessage({ type: 'frame' });
    }
    groundOffset = (groundOffset - dt * VIS_SPEED / 5) % 1;
    groundTex.offset.x = groundOffset;
    cutPlane.visible = opts.plane;
    streaks.visible = opts.streaks;
    if (opts.streaks) stepStreaks(dt);
    controls.update();
    renderer.render(scene, camera);
  }

  return {
    opts,
    start() { resize(); rebuild(); requestAnimationFrame(frame); },
    set(patch) {
      const prev = { ...opts };
      Object.assign(opts, patch);
      const needRebuild = ['leader', 'quality', 'ghost'].some((k) => k in patch && patch[k] !== prev[k])
        || ('gap' in patch && opts.leader && patch.gap !== prev.gap);
      if (needRebuild) rebuild();
      else if ('speedKmh' in patch || 'attitude' in patch || 'section' in patch) applyAttitude();
      if ('view' in patch) drawField();
    },
    carChanged() { rebuild(); },
    paramsChanged() { car = getCar(); applyAttitude(); },
    resetFlow() { rebuild(); },
    setVisible(v) {
      visible = v;
      if (worker) worker.postMessage({ type: v ? 'run' : 'pause' });
      if (v) { resize(); last = performance.now(); }
    },
    themeChanged() { paintGround(); drawField(); drawArrows(); },
    loadModel, flipModel, clearModel,
  };
}
