// GPU 격자 볼츠만(D2Q9) 해석기. lbm-worker.js(CPU)와 같은 물리를 WebGL2 셰이더로 계산한다.
// - 분포함수 9개를 RGBA32F 텍스처 3장에 나눠 담고(f0..3 / f4..7 / f8, ρ, ux, uy) 핑퐁
// - 한 번의 그리기로 흐름(stream) + 충돌(collide) + 운동량 교환 힘을 동시에 계산 (MRT 4장)
// - 화면 표시·유선·힘 합산에 필요한 값만 주기적으로 CPU로 읽어 온다
// float 텍스처에 그리기(EXT_color_buffer_float)를 못 하면 null을 돌려주고, 호출 측이 CPU로 대체한다.

const MAX_ID = 8;
const GROUND = 255;

const VS = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D F0, F1, F2, OB;
uniform float u0, tau0, smag;
uniform int NX, NY;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 oF;
const ivec2 C[9] = ivec2[9](ivec2(0,0), ivec2(1,0), ivec2(0,1), ivec2(-1,0), ivec2(0,-1), ivec2(1,1), ivec2(-1,1), ivec2(-1,-1), ivec2(1,-1));
const float W[9] = float[9](4.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0);
const int OPP[9] = int[9](0, 3, 4, 1, 2, 7, 8, 5, 6);
float feq(int i, float r, vec2 u) {
  float cu = 3.0 * dot(vec2(C[i]), u);
  return W[i] * r * (1.0 + cu + 0.5 * cu * cu - 1.5 * dot(u, u));
}
void writeEq(float r, vec2 u) {
  float e[9];
  for (int i = 0; i < 9; i++) e[i] = feq(i, r, u);
  o0 = vec4(e[0], e[1], e[2], e[3]);
  o1 = vec4(e[4], e[5], e[6], e[7]);
  o2 = vec4(e[8], r, u);
  oF = vec4(0.0);
}
`;

// 한 스텝: 이웃에서 분포를 당겨 오고(pull), 고체 이웃은 이동벽 bounce-back, 그 다음 BGK+스마고린스키 충돌
const STEP_FS = COMMON + `
float getF(ivec2 p, int i) {
  if (i < 4) return texelFetch(F0, p, 0)[i];
  if (i < 8) return texelFetch(F1, p, 0)[i - 4];
  return texelFetch(F2, p, 0).x;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 ob = texelFetch(OB, p, 0);
  if (ob.x > 0.5) { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0); oF = vec4(0.0); return; }
  // 입구(왼쪽)·천장: 자유류 평형
  if (p.x == 0 || p.y == NY - 1) { writeEq(1.0, vec2(u0, 0.0)); return; }
  // 출구(오른쪽): 0 기울기 (이웃 값 복사)
  if (p.x == NX - 1) {
    ivec2 q = p - ivec2(1, 0);
    o0 = texelFetch(F0, q, 0); o1 = texelFetch(F1, q, 0); o2 = texelFetch(F2, q, 0); oF = vec4(0.0);
    return;
  }
  vec4 a = texelFetch(F0, p, 0), b = texelFetch(F1, p, 0), c = texelFetch(F2, p, 0);
  float fo[9] = float[9](a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w, c.x);
  float f[9];
  vec3 force = vec3(0.0);
  float fid = 0.0;
  for (int i = 0; i < 9; i++) {
    ivec2 s = p - C[i];
    vec4 os = texelFetch(OB, s, 0);
    if (os.x > 0.5) {
      // 이동벽 bounce-back: 벽 쪽으로 나간 분포가 벽 속도만큼 보정되어 되돌아온다
      float outF = fo[OPP[i]];
      float v = outF + 6.0 * W[i] * dot(vec2(C[i]), os.yz);
      f[i] = v;
      if (os.x < 254.5) {
        // 벽이 받는 운동량 = (나간 것 + 돌아온 것) × 나간 방향
        vec2 m = (outF + v) * vec2(C[OPP[i]]);
        force += vec3(m, float(p.x) * m.y);
        fid = os.x;
      }
    } else {
      f[i] = getF(s, i);
    }
  }
  float r = 0.0;
  vec2 mom = vec2(0.0);
  for (int i = 0; i < 9; i++) { r += f[i]; mom += f[i] * vec2(C[i]); }
  vec2 u = mom / r;
  float e[9];
  float pxx = 0.0, pyy = 0.0, pxy = 0.0;
  for (int i = 0; i < 9; i++) {
    e[i] = feq(i, r, u);
    float d = f[i] - e[i];
    vec2 ci = vec2(C[i]);
    pxx += ci.x * ci.x * d; pyy += ci.y * ci.y * d; pxy += ci.x * ci.y * d;
  }
  float q = sqrt(pxx * pxx + pyy * pyy + 2.0 * pxy * pxy);
  float om = 2.0 / (tau0 + sqrt(tau0 * tau0 + smag * q / r));
  float n[9];
  for (int i = 0; i < 9; i++) n[i] = f[i] + om * (e[i] - f[i]);
  o0 = vec4(n[0], n[1], n[2], n[3]);
  o1 = vec4(n[4], n[5], n[6], n[7]);
  o2 = vec4(n[8], r, u);
  oF = vec4(force, fid);
}`;

// 형상이 바뀐 직후: 새로 유체가 된 칸(분포 합이 0)과 전체 초기화 시 자유류 평형으로 채운다
const FIX_FS = COMMON + `
uniform int resetAll;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 ob = texelFetch(OB, p, 0);
  if (ob.x > 0.5) { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0); oF = vec4(0.0); return; }
  vec4 a = texelFetch(F0, p, 0), b = texelFetch(F1, p, 0), c = texelFetch(F2, p, 0);
  float sum = a.x + a.y + a.z + a.w + b.x + b.y + b.z + b.w + c.x;
  if (resetAll == 1 || !(sum > 0.01) ) { writeEq(1.0, vec2(u0, 0.0)); return; }
  o0 = a; o1 = b; o2 = c; oF = vec4(0.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export function createGpuLbm() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false });
  if (!gl || !gl.getExtension('EXT_color_buffer_float') || gl.getParameter(gl.MAX_DRAW_BUFFERS) < 4) return null;

  let stepProg, fixProg;
  try {
    stepProg = program(gl, STEP_FS);
    fixProg = program(gl, FIX_FS);
  } catch (err) {
    console.warn('GPU 해석기 셰이더 컴파일 실패, CPU로 대체:', err);
    return null;
  }
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  let NX = 0, NY = 0, u0 = 0.1, tau0 = 0.515, smag = 0;
  let sets = []; // [{ tex: [F0,F1,F2,FORCE], fbo }] ×2
  let cur = 0;
  let obTex = null;
  let solid = null;
  let steps = 0;
  let stepsAtRead = 0;
  let resets = 0;
  const force = new Float64Array(MAX_ID * 3);
  let bufF2 = null;
  let bufForce = null;

  const makeTex = (data = null) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, NX, NY, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  function freeAll() {
    for (const s of sets) { s.tex.forEach((t) => gl.deleteTexture(t)); gl.deleteFramebuffer(s.fbo); }
    if (obTex) gl.deleteTexture(obTex);
    sets = [];
    obTex = null;
  }

  // 유니폼 위치는 프레임마다 수백 번 쓰이므로 캐시한다
  const locCache = new Map();
  const loc = (prog, name) => {
    let m = locCache.get(prog);
    if (!m) { m = {}; locCache.set(prog, m); }
    if (!(name in m)) m[name] = gl.getUniformLocation(prog, name);
    return m[name];
  };

  function draw(prog, src, dst, extra) {
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, NX, NY);
    const names = ['F0', 'F1', 'F2'];
    for (let k = 0; k < 3; k++) {
      gl.activeTexture(gl.TEXTURE0 + k);
      gl.bindTexture(gl.TEXTURE_2D, src.tex[k]);
      gl.uniform1i(loc(prog, names[k]), k);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, obTex);
    gl.uniform1i(loc(prog, 'OB'), 3);
    gl.uniform1f(loc(prog, 'u0'), u0);
    gl.uniform1f(loc(prog, 'tau0'), tau0);
    gl.uniform1f(loc(prog, 'smag'), smag);
    gl.uniform1i(loc(prog, 'NX'), NX);
    gl.uniform1i(loc(prog, 'NY'), NY);
    if (extra) extra(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function fix(resetAll) {
    const src = sets[cur];
    const dst = sets[1 - cur];
    draw(fixProg, src, dst, (p) => gl.uniform1i(loc(p, 'resetAll'), resetAll ? 1 : 0));
    cur = 1 - cur;
  }

  function uploadObstacle(ids, wx, wy) {
    const data = new Float32Array(NX * NY * 4);
    for (let c = 0; c < NX * NY; c++) {
      data[c * 4] = ids[c];
      data[c * 4 + 1] = wx[c];
      data[c * 4 + 2] = wy[c];
    }
    if (obTex) gl.deleteTexture(obTex);
    obTex = makeTex(data);
  }

  return {
    kind: 'gpu',
    init(opts) {
      freeAll();
      NX = opts.NX; NY = opts.NY; u0 = opts.u0;
      tau0 = 0.5 + 3 * opts.nu;
      smag = 18 * Math.SQRT2 * opts.cs * opts.cs;
      for (let k = 0; k < 2; k++) {
        const tex = [makeTex(), makeTex(), makeTex(), makeTex()];
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        tex.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('GPU 해석기 프레임버퍼를 만들 수 없습니다');
        sets.push({ tex, fbo });
      }
      // 노면(y=0)만 있는 초기 장애물
      solid = new Uint8Array(NX * NY);
      const wx = new Float32Array(NX * NY);
      for (let x = 0; x < NX; x++) { solid[x] = GROUND; wx[x] = u0; }
      uploadObstacle(solid, wx, new Float32Array(NX * NY));
      cur = 0;
      fix(true);
      steps = 0; stepsAtRead = 0; resets = 0;
      force.fill(0);
      bufF2 = new Float32Array(NX * NY * 4);
      bufForce = new Float32Array(NX * NY * 4);
    },
    setMask({ solid: ids, wux, wuy }) {
      solid = new Uint8Array(ids);
      const wx = new Float32Array(wux);
      const wy = new Float32Array(wuy);
      // 노면은 공기와 같은 속도로 움직인다
      for (let x = 0; x < NX; x++) { solid[x] = GROUND; wx[x] = u0; wy[x] = 0; }
      uploadObstacle(solid, wx, wy);
      fix(false);
      force.fill(0);
    },
    step(n) {
      for (let k = 0; k < n; k++) {
        draw(stepProg, sets[cur], sets[1 - cur]);
        cur = 1 - cur;
      }
      steps += n;
    },
    // 현재 유동장과 힘을 CPU로 읽는다 (화면 표시·유선·측정값용)
    read() {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sets[cur].fbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT2);
      gl.readPixels(0, 0, NX, NY, gl.RGBA, gl.FLOAT, bufF2);
      gl.readBuffer(gl.COLOR_ATTACHMENT3);
      gl.readPixels(0, 0, NX, NY, gl.RGBA, gl.FLOAT, bufForce);
      const N = NX * NY;
      const ux = new Float32Array(N), uy = new Float32Array(N), rho = new Float32Array(N);
      let diverged = false;
      for (let c = 0; c < N; c++) {
        rho[c] = bufF2[c * 4 + 1];
        ux[c] = bufF2[c * 4 + 2];
        uy[c] = bufF2[c * 4 + 3];
        if (!solid[c] && !Number.isFinite(rho[c])) diverged = true;
      }
      // 힘: 마지막 스텝의 순간값을 물체별로 합산하고, CPU 해석기와 같은 시상수로 지수 평균
      const inst = new Float64Array(MAX_ID * 3);
      for (let c = 0; c < N; c++) {
        const id = bufForce[c * 4 + 3];
        if (!id) continue;
        const k = (id & 7) * 3;
        inst[k] += bufForce[c * 4];
        inst[k + 1] += bufForce[c * 4 + 1];
        inst[k + 2] += bufForce[c * 4 + 2];
      }
      const a = 1 - Math.pow(1 - 0.0007, Math.max(1, steps - stepsAtRead));
      stepsAtRead = steps;
      for (let k = 0; k < force.length; k++) force[k] += a * (inst[k] - force[k]);
      if (diverged) {
        // 발산하면 자유류로 다시 시작
        fix(true);
        force.fill(0);
        steps = 0; stepsAtRead = 0;
        resets++;
      }
      return { ux, uy, rho, solid: solid.slice(), force: Array.from(force), steps, resets };
    },
    dispose() {
      freeAll();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
