// 의존성 없는 캔버스 라인 차트. 색은 CSS 변수에서 읽어 라이트/다크 테마를 따른다.

function cssVar(el, name) {
  return getComputedStyle(el).getPropertyValue(name).trim() || '#888';
}

function niceStep(range, target = 5) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function fmt(v) {
  const a = Math.abs(v);
  if (a >= 10000) return (v / 1000).toFixed(0) + 'k';
  if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export class LineChart {
  constructor(canvas, { xLabel = '', yLabel = '', height = 240 } = {}) {
    this.canvas = canvas;
    this.xLabel = xLabel;
    this.yLabel = yLabel;
    this.height = height;
    this.series = [];
    this.markers = [];
    this.hoverX = null;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
  }

  // series: [{ name, color: '--css-var', x: [], y: [], dash: [] , unit }]
  set(series, { markers = [], yMin = null, yMax = null } = {}) {
    this.series = series;
    this.markers = markers;
    this.yMinFixed = yMin;
    this.yMaxFixed = yMax;
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const w = c.parentElement.clientWidth;
    const h = this.height;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.series.length) return;

    const ink = cssVar(c, '--ink-2');
    const grid = cssVar(c, '--grid');
    const font = cssVar(c, '--font-data');
    const pad = { l: 46, r: 12, t: 14, b: 34 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;

    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of this.series) {
      for (let i = 0; i < s.x.length; i++) {
        if (!Number.isFinite(s.y[i])) continue;
        xMin = Math.min(xMin, s.x[i]); xMax = Math.max(xMax, s.x[i]);
        yMin = Math.min(yMin, s.y[i]); yMax = Math.max(yMax, s.y[i]);
      }
    }
    if (this.yMinFixed !== null) yMin = this.yMinFixed;
    else yMin = Math.min(0, yMin);
    if (this.yMaxFixed !== null) yMax = this.yMaxFixed;
    if (yMax - yMin < 1e-9) yMax = yMin + 1;
    if (xMax - xMin < 1e-9) xMax = xMin + 1;
    const yStep = niceStep(yMax - yMin);
    yMax = Math.ceil(yMax / yStep - 1e-9) * yStep;
    yMin = Math.floor(yMin / yStep + 1e-9) * yStep;
    const X = (v) => pad.l + ((v - xMin) / (xMax - xMin)) * pw;
    const Y = (v) => pad.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

    ctx.font = `11px ${font}`;
    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    ctx.fillStyle = ink;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = yMin; v <= yMax + yStep * 1e-6; v += yStep) {
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(pad.l + pw, Y(v)); ctx.stroke();
      ctx.fillText(fmt(v), pad.l - 6, Y(v));
    }
    const xStep = niceStep(xMax - xMin, Math.max(3, Math.floor(pw / 70)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax + 1e-9; v += xStep) {
      ctx.beginPath(); ctx.moveTo(X(v), pad.t); ctx.lineTo(X(v), pad.t + ph); ctx.stroke();
      ctx.fillText(fmt(v), X(v), pad.t + ph + 5);
    }
    ctx.textAlign = 'right';
    ctx.fillText(this.xLabel, pad.l + pw, pad.t + ph + 19);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(this.yLabel, pad.l + 4, 1);

    for (const m of this.markers) {
      if (m.x < xMin || m.x > xMax) continue;
      ctx.strokeStyle = cssVar(c, m.color || '--ink-2');
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(m.x), pad.t); ctx.lineTo(X(m.x), pad.t + ph); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar(c, m.color || '--ink-2');
      ctx.textAlign = X(m.x) > pad.l + pw / 2 ? 'right' : 'left';
      ctx.fillText(m.label, X(m.x) + (ctx.textAlign === 'right' ? -4 : 4), pad.t + 2);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.clip();
    for (const s of this.series) {
      ctx.strokeStyle = cssVar(c, s.color);
      ctx.lineWidth = s.width || 2;
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.x.length; i++) {
        if (!Number.isFinite(s.y[i])) { started = false; continue; }
        if (!started) { ctx.moveTo(X(s.x[i]), Y(s.y[i])); started = true; }
        else ctx.lineTo(X(s.x[i]), Y(s.y[i]));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    if (this.hoverX !== null && this.hoverX >= pad.l && this.hoverX <= pad.l + pw) {
      const xv = xMin + ((this.hoverX - pad.l) / pw) * (xMax - xMin);
      ctx.strokeStyle = ink;
      ctx.beginPath(); ctx.moveTo(this.hoverX, pad.t); ctx.lineTo(this.hoverX, pad.t + ph); ctx.stroke();
      const rows = [`${this.xLabel} ${fmt(xv)}`];
      const colors = [ink];
      for (const s of this.series) {
        const yv = interp(s.x, s.y, xv);
        if (yv === null) continue;
        rows.push(`${s.name}  ${fmt(yv)}`);
        colors.push(cssVar(c, s.color));
        ctx.fillStyle = cssVar(c, s.color);
        ctx.beginPath(); ctx.arc(X(xv), Y(yv), 3, 0, Math.PI * 2); ctx.fill();
      }
      const bw = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 16;
      const bh = rows.length * 15 + 8;
      let bx = this.hoverX + 10;
      if (bx + bw > w - 2) bx = this.hoverX - bw - 10;
      ctx.fillStyle = cssVar(c, '--panel');
      ctx.strokeStyle = grid;
      ctx.fillRect(bx, pad.t + 4, bw, bh);
      ctx.strokeRect(bx, pad.t + 4, bw, bh);
      ctx.textAlign = 'left';
      rows.forEach((r, i) => {
        ctx.fillStyle = colors[i];
        ctx.fillText(r, bx + 8, pad.t + 9 + i * 15);
      });
    }
  }
}

function interp(xs, ys, x) {
  if (!xs.length) return null;
  const asc = xs[xs.length - 1] >= xs[0];
  const lo = asc ? xs[0] : xs[xs.length - 1];
  const hi = asc ? xs[xs.length - 1] : xs[0];
  if (x < lo || x > hi) return null;
  for (let i = 1; i < xs.length; i++) {
    const a = xs[i - 1], b = xs[i];
    if ((x - a) * (x - b) <= 0) {
      const t = b === a ? 0 : (x - a) / (b - a);
      return ys[i - 1] + t * (ys[i] - ys[i - 1]);
    }
  }
  return null;
}
