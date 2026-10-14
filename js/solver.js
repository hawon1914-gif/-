// 유체 해석기 선택: GPU(WebGL2)를 우선 쓰고, 안 되면 CPU 워커로 대체한다. 둘 다 같은 인터페이스.
import { createGpuLbm } from './lbm-gpu.js';

function createCpuLbm() {
  // 단일 파일 빌드에서는 워커 코드를 Blob URL로 미리 넣어 둔다 (file://에서도 동작)
  const worker = new Worker(globalThis.AEROLAB_WORKER_URL ?? new URL('./lbm-worker.js', import.meta.url));
  let waiting = null;
  worker.onmessage = (e) => {
    if (e.data.type !== 'frame' || !waiting) return;
    const cb = waiting;
    waiting = null;
    cb(e.data);
  };
  return {
    kind: 'cpu',
    init(o) { worker.postMessage({ type: 'init', ...o }); },
    setMask(m) {
      worker.postMessage({ type: 'mask', solid: m.solid.buffer, wux: m.wux.buffer, wuy: m.wuy.buffer }, [m.solid.buffer, m.wux.buffer, m.wuy.buffer]);
    },
    step() { /* 워커가 스스로 계속 계산한다 */ },
    busy: () => waiting !== null,
    requestFrame(cb) {
      waiting = cb;
      worker.postMessage({ type: 'frame' });
    },
    run() { worker.postMessage({ type: 'run' }); },
    pause() { worker.postMessage({ type: 'pause' }); },
    dispose() { worker.terminate(); waiting = null; },
  };
}

export function createSolver({ preferGpu = true } = {}) {
  if (preferGpu) {
    try {
      const gpu = createGpuLbm();
      if (gpu) {
        return {
          ...gpu,
          busy: () => false,
          requestFrame(cb) { cb(gpu.read()); },
          run() {},
          pause() {},
        };
      }
    } catch (err) {
      console.warn('GPU 해석기를 쓸 수 없어 CPU로 대체:', err);
    }
  }
  return createCpuLbm();
}
