// 측면도: 피치(라이드하이트 차이)와 앞/뒤 다운포스·타이어 하중을 화살표로 표시.
// 라이드하이트는 눈에 보이도록 과장해서 그린다.

function cssVar(el, name) {
  return getComputedStyle(el).getPropertyValue(name).trim() || '#888';
}

export function drawCarView(canvas, car, frame) {
  const w = canvas.parentElement.clientWidth;
  const h = 220;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const ink = cssVar(canvas, '--ink');
  const ink2 = cssVar(canvas, '--ink-2');
  const front = cssVar(canvas, '--front');
  const rear = cssVar(canvas, '--rear');
  const drag = cssVar(canvas, '--drag');
  const tire = cssVar(canvas, '--tire');
  const font = cssVar(canvas, '--font-data');

  const groundY = h - 34;
  const wheelR = 20;
  const span = Math.min(w * 0.52, 340);
  const rx = w / 2 - span / 2; // 뒤 차축 (차는 오른쪽을 향함)
  const fx = w / 2 + span / 2; // 앞 차축
  const exag = 1.6; // mm → px 과장 배율
  const yF = groundY - 2 * wheelR - frame.hF * exag + 8;
  const yR = groundY - 2 * wheelR - frame.hR * exag + 8;

  ctx.strokeStyle = ink2;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(w, groundY); ctx.stroke();

  // 차체: 앞/뒤 차축 위치의 바닥 높이를 잇는 직선 위에 그린다
  const floorAt = (x) => yR + ((x - rx) / (fx - rx)) * (yF - yR);
  const ov = span * 0.32;
  ctx.fillStyle = cssVar(canvas, '--body');
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const xs = car.type === 'open'
    ? [[rx - ov * 0.7, -6], [rx - ov * 0.7, 30], [rx - ov * 0.3, 30], [rx + span * 0.25, 22], [rx + span * 0.45, 40], [rx + span * 0.6, 22], [fx + ov * 0.6, 8], [fx + ov * 0.85, 2], [fx + ov * 0.85, -6]]
    : [[rx - ov * 0.6, -4], [rx - ov * 0.6, 34], [rx + span * 0.15, 44], [rx + span * 0.45, 58], [rx + span * 0.75, 40], [fx + ov * 0.6, 26], [fx + ov * 0.7, 6], [fx + ov * 0.7, -4]];
  xs.forEach(([x, up], i) => {
    const y = floorAt(x) - up;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  for (const x of [rx, fx]) {
    ctx.fillStyle = tire;
    ctx.beginPath(); ctx.arc(x, groundY - wheelR, wheelR, 0, Math.PI * 2); ctx.fill();
  }

  const maxLoad = car.mass * 9.80665 * 1.6;
  const arrow = (x, y0, len, color, dir, label) => {
    const l = Math.max(4, Math.min(90, Math.abs(len)));
    const y1 = y0 + dir * l;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 6, y1 - dir * 8); ctx.lineTo(x, y1); ctx.lineTo(x + 6, y1 - dir * 8); ctx.fill();
    ctx.font = `11px ${font}`;
    ctx.textAlign = 'center';
    ctx.fillText(label, x, dir > 0 ? y0 - 6 : y1 - 6);
  };
  const scale = 90 / maxLoad;
  arrow(fx - 26, floorAt(fx) - 70, frame.dfF * scale, front, 1, `DF ${(frame.dfF / 1000).toFixed(1)}kN`);
  arrow(rx - 26, floorAt(rx) - 70, frame.dfR * scale, rear, 1, `DF ${(frame.dfR / 1000).toFixed(1)}kN`);
  arrow(fx + 28, groundY, frame.fzF * scale, tire, -1, `${(frame.fzF / 1000).toFixed(1)}kN`);
  arrow(rx + 28, groundY, frame.fzR * scale, tire, -1, `${(frame.fzR / 1000).toFixed(1)}kN`);

  // 항력: 차 뒤쪽으로 향하는 수평 화살표
  const dl = Math.min(80, frame.drag * scale * 2);
  const dy = floorAt(rx) - 50;
  ctx.strokeStyle = drag; ctx.fillStyle = drag; ctx.lineWidth = 3;
  const dx0 = rx - ov * 0.8;
  ctx.beginPath(); ctx.moveTo(dx0, dy); ctx.lineTo(dx0 - dl, dy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(dx0 - dl + 8, dy - 6); ctx.lineTo(dx0 - dl, dy); ctx.lineTo(dx0 - dl + 8, dy + 6); ctx.fill();
  ctx.textAlign = 'right';
  ctx.fillText(`항력 ${(frame.drag / 1000).toFixed(1)}kN`, dx0 - 4, dy - 10);

  ctx.fillStyle = ink2;
  ctx.textAlign = 'left';
  ctx.font = `11px ${font}`;
  ctx.fillText(`F ${frame.hF.toFixed(1)}mm  R ${frame.hR.toFixed(1)}mm  (높이 ${exag}× 과장)`, 8, h - 10);
  ctx.textAlign = 'right';
  ctx.fillText('주행 방향 →', w - 8, h - 10);
}
