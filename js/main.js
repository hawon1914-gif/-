// LMU 코치 진입점: 코칭 화면을 만들고, 브리지가 게임 데이터를 받기 시작하면 자동으로 연결한다.
import { createCoach } from './coach-ui.js';

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

const coach = createCoach({ root: document.getElementById('coach') });
coach.setVisible(true);

// 게임 자동 연결: 버튼을 누를 필요가 없다. 화면의 "게임 자동 연결"을 끄면 멈춘다.
function watchBridge() {
  let busy = false;
  const check = async () => {
    if (busy || coach.isLive() || coach.autoBlocked() || storageGet('aerolab-autolive') === '0') return;
    busy = true;
    try {
      // 브리지가 띄운 페이지면 그 브리지의 포트, 파일로 연 페이지면 마지막에 쓴 포트
      const port = location.protocol.startsWith('http') && location.port ? +location.port : +(storageGet('aerolab-port') || 8770);
      const r = await fetch(`http://127.0.0.1:${port}/status`, { cache: 'no-store' });
      const st = await r.json();
      if (st.connected) coach.connect(true);
    } catch { /* 브리지가 꺼져 있음: 다음에 다시 본다 */ } finally { busy = false; }
  };
  setInterval(check, 2000);
  check();
}
watchBridge();

const redraw = () => coach.themeChanged();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
