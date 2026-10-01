// Graphiques en <canvas> (sans bibliothèque), avec infobulle au survol.
import { formatPct } from './stats.js';

const PAD = { left: 48, right: 14, top: 12, bottom: 34 };

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.font = '12px system-ui, sans-serif';
  return { g, w, h };
}

function niceTicks(max, count = 5) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let i = 0; i * step < max + step - 1e-9; i++) ticks.push(i * step);
  return ticks;
}

function drawAxes(g, w, h, xScale, yScale, xTicks, yTicks, xFmt, yFmt, xLabel) {
  g.strokeStyle = css('--grid');
  g.fillStyle = css('--text-muted');
  g.lineWidth = 1;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (const t of yTicks) {
    const y = Math.round(yScale(t)) + 0.5;
    g.beginPath(); g.moveTo(PAD.left, y); g.lineTo(w - PAD.right, y); g.stroke();
    g.fillText(yFmt(t), PAD.left - 6, y);
  }
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (const t of xTicks) g.fillText(xFmt(t), xScale(t), h - PAD.bottom + 6);
  g.fillText(xLabel, (PAD.left + w - PAD.right) / 2, h - 14);
  g.strokeStyle = css('--axis');
  g.beginPath(); g.moveTo(PAD.left, h - PAD.bottom + 0.5); g.lineTo(w - PAD.right, h - PAD.bottom + 0.5); g.stroke();
}

function band(g, x0, x1, yScale, low, high, color) {
  g.fillStyle = color;
  g.fillRect(x0, yScale(high), x1 - x0, yScale(low) - yScale(high));
}

class Tooltip {
  constructor(canvas) {
    this.el = document.createElement('div');
    this.el.className = 'chart-tooltip';
    canvas.parentElement.appendChild(this.el);
    this.hide();
  }
  show(x, y, html) {
    this.el.innerHTML = html;
    this.el.style.display = 'block';
    const parentW = this.el.parentElement.clientWidth;
    const left = Math.min(Math.max(x + 12, 0), parentW - this.el.offsetWidth - 4);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${Math.max(y - this.el.offsetHeight - 10, 0)}px`;
  }
  hide() { this.el.style.display = 'none'; }
}

/**
 * Évolution de la fréquence cumulée de l'issue suivie en fonction du nombre de lancers.
 */
export class FrequencyChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.tooltip = new Tooltip(canvas);
    this.data = null;
    canvas.addEventListener('mousemove', (e) => this.hover(e));
    canvas.addEventListener('mouseleave', () => { this.hoverX = null; this.tooltip.hide(); this.draw(); });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  /** @param data { outcomes: Uint8Array, count, target, real: {f, low, high} | null, label } */
  update(data) {
    this.data = data;
    const { outcomes, count, target } = data;
    // points sous-échantillonnés (≤ 600) de la fréquence cumulée
    const pts = [];
    const stepN = Math.max(1, Math.ceil(count / 600));
    let k = 0;
    for (let i = 0; i < count; i++) {
      if (outcomes[i] === target) k++;
      if ((i + 1) % stepN === 0 || i === count - 1) pts.push([i + 1, k / (i + 1)]);
    }
    this.points = pts;
    this.draw();
  }

  draw() {
    const { g, w, h } = setupCanvas(this.canvas);
    const d = this.data;
    if (!d || !d.count) {
      g.fillStyle = css('--text-muted');
      g.textAlign = 'center';
      g.fillText('Aucun lancer pour l’instant', w / 2, h / 2);
      return;
    }
    const n = d.count;
    const xScale = (x) => PAD.left + (x / n) * (w - PAD.left - PAD.right);
    const yScale = (y) => PAD.top + (1 - y) * (h - PAD.top - PAD.bottom);
    drawAxes(g, w, h, xScale, yScale, niceTicks(n).filter((t) => t <= n), [0, 0.25, 0.5, 0.75, 1],
      (t) => t.toLocaleString('fr-FR'), (t) => `${t * 100} %`, 'Nombre de lancers');

    if (d.real) {
      band(g, PAD.left, w - PAD.right, yScale, d.real.low, d.real.high, css('--series-2-soft'));
      g.strokeStyle = css('--series-2');
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.beginPath(); g.moveTo(PAD.left, yScale(d.real.f)); g.lineTo(w - PAD.right, yScale(d.real.f)); g.stroke();
      g.setLineDash([]);
    }

    g.strokeStyle = css('--series-1');
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    this.points.forEach(([x, y], i) => (i ? g.lineTo(xScale(x), yScale(y)) : g.moveTo(xScale(x), yScale(y))));
    g.stroke();

    if (this.hoverX != null) {
      const p = this.nearest(this.hoverX, xScale);
      if (p) {
        const px = xScale(p[0]), py = yScale(p[1]);
        g.strokeStyle = css('--axis');
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(px + 0.5, PAD.top); g.lineTo(px + 0.5, h - PAD.bottom); g.stroke();
        g.fillStyle = css('--series-1');
        g.strokeStyle = css('--surface');
        g.lineWidth = 2;
        g.beginPath(); g.arc(px, py, 4.5, 0, 2 * Math.PI); g.fill(); g.stroke();
        let html = `<b>${p[0].toLocaleString('fr-FR')} lancers</b><br>Simulation : ${formatPct(p[1])}`;
        if (d.real) html += `<br>Expérience : ${formatPct(d.real.f)}`;
        this.tooltip.show(px, py, html);
      }
    }
  }

  nearest(mx, xScale) {
    let best = null, bd = Infinity;
    for (const p of this.points || []) {
      const dd = Math.abs(xScale(p[0]) - mx);
      if (dd < bd) { bd = dd; best = p; }
    }
    return best;
  }

  hover(e) {
    if (!this.data?.count) return;
    const r = this.canvas.getBoundingClientRect();
    this.hoverX = e.clientX - r.left;
    this.draw();
  }
}

/**
 * Répartition des fréquences observées sur chaque série de n lancers,
 * avec l'intervalle de fluctuation p ± 1/√n.
 */
export class SeriesHistogram {
  constructor(canvas) {
    this.canvas = canvas;
    this.tooltip = new Tooltip(canvas);
    canvas.addEventListener('mousemove', (e) => this.hover(e));
    canvas.addEventListener('mouseleave', () => { this.hoverBin = null; this.tooltip.hide(); this.draw(); });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  /** @param data { freqs: number[], n, p, interval: {low, high} } */
  update(data) {
    this.data = data;
    const { freqs, n } = data;
    const nb = n <= 40 ? n + 1 : 41; // une barre par valeur k/n possible
    const bins = new Array(nb).fill(0);
    for (const f of freqs) bins[Math.min(nb - 1, Math.round(f * (nb - 1)))]++;
    this.bins = bins;
    this.draw();
  }

  draw() {
    const { g, w, h } = setupCanvas(this.canvas);
    const d = this.data;
    if (!d || !d.freqs.length) {
      g.fillStyle = css('--text-muted');
      g.textAlign = 'center';
      g.fillText('Lancez des séries pour voir leur répartition', w / 2, h / 2);
      return;
    }
    const bins = this.bins, nb = bins.length;
    const maxY = Math.max(...bins);
    const plotW = w - PAD.left - PAD.right;
    const bw = plotW / nb;
    const xScale = (f) => PAD.left + (f * (nb - 1) + 0.5) * bw;
    const yTicks = niceTicks(maxY, 4);
    const top = yTicks[yTicks.length - 1] || 1;
    const yScale = (y) => PAD.top + (1 - y / top) * (h - PAD.top - PAD.bottom);

    if (d.interval) {
      g.fillStyle = css('--band');
      g.fillRect(xScale(d.interval.low), PAD.top, xScale(d.interval.high) - xScale(d.interval.low), h - PAD.top - PAD.bottom);
    }
    drawAxes(g, w, h, xScale, yScale, [0, 0.25, 0.5, 0.75, 1], yTicks,
      (t) => `${t * 100} %`, (t) => t.toLocaleString('fr-FR'), `Fréquence observée sur une série de ${d.n} lancers`);

    const barW = Math.max(1, bw - 2);
    bins.forEach((c, i) => {
      if (!c) return;
      const x = PAD.left + i * bw + (bw - barW) / 2;
      const y = yScale(c);
      const bh = h - PAD.bottom - y;
      g.fillStyle = this.hoverBin === i ? css('--series-1-strong') : css('--series-1');
      g.beginPath();
      g.roundRect(x, y, barW, bh, [Math.min(4, barW / 2), Math.min(4, barW / 2), 0, 0]);
      g.fill();
    });

    if (this.hoverBin != null && bins[this.hoverBin] != null) {
      const i = this.hoverBin;
      const f = i / (nb - 1);
      this.tooltip.show(PAD.left + (i + 0.5) * bw, yScale(bins[i]),
        `<b>Fréquence ≈ ${formatPct(f, 0)}</b><br>${bins[i].toLocaleString('fr-FR')} série(s)`);
    }
  }

  hover(e) {
    if (!this.data?.freqs.length) return;
    const r = this.canvas.getBoundingClientRect();
    const bw = (r.width - PAD.left - PAD.right) / this.bins.length;
    const i = Math.floor((e.clientX - r.left - PAD.left) / bw);
    this.hoverBin = i >= 0 && i < this.bins.length ? i : null;
    if (this.hoverBin == null) this.tooltip.hide();
    this.draw();
  }
}

const ENERGY_SERIES = [
  { key: 'potential', label: 'Énergie potentielle', color: '--series-1' },
  { key: 'translational', label: 'Énergie cinétique de translation', color: '--series-2' },
  { key: 'rotational', label: 'Énergie cinétique de rotation', color: '--series-3' },
  { key: 'total', label: 'Énergie mécanique totale', color: '--text-muted', dash: [5, 4] },
];

/** Énergies de l'objet suivi en fonction du temps (simulé). */
export class EnergyChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.tooltip = new Tooltip(canvas);
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    canvas.addEventListener('mouseleave', () => { this.hoverX = null; this.tooltip.hide(); this.draw(); });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  /** @param samples { t: number[], potential, translational, rotational, total } en J */
  update(samples) {
    this.samples = samples;
    this.draw();
  }

  draw() {
    const { g, w, h } = setupCanvas(this.canvas);
    const S = this.samples;
    if (!S || S.t.length < 2) {
      g.fillStyle = css('--text-muted');
      g.textAlign = 'center';
      g.fillText('Lancez une série pour suivre les énergies', w / 2, h / 2);
      return;
    }
    const n = S.t.length;
    const tMax = Math.max(S.t[n - 1], 0.1);
    let eMax = 0;
    for (const v of S.total) eMax = Math.max(eMax, v);
    for (const v of S.translational) eMax = Math.max(eMax, v);
    for (const v of S.rotational) eMax = Math.max(eMax, v);
    const mJ = eMax * 1000;
    const yTicks = niceTicks(mJ || 1, 4);
    const top = yTicks[yTicks.length - 1];
    const xScale = (t) => PAD.left + (t / tMax) * (w - PAD.left - PAD.right);
    const yScale = (e) => PAD.top + (1 - e / top) * (h - PAD.top - PAD.bottom);
    const xTicks = niceTicks(tMax, 5).filter((t) => t <= tMax);
    const fmt = (v) => v.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
    drawAxes(g, w, h, xScale, yScale, xTicks, yTicks, fmt, (v) => `${fmt(v)} mJ`, 'Temps (s)');

    // au plus ~800 points tracés par courbe
    const stride = Math.max(1, Math.floor(n / 800));
    for (const s of ENERGY_SERIES) {
      g.strokeStyle = css(s.color);
      g.lineWidth = 2;
      g.setLineDash(s.dash ?? []);
      g.beginPath();
      for (let i = 0; i < n; i += stride) {
        const X = xScale(S.t[i]), Y = yScale(S[s.key][i] * 1000);
        i ? g.lineTo(X, Y) : g.moveTo(X, Y);
      }
      g.lineTo(xScale(S.t[n - 1]), yScale(S[s.key][n - 1] * 1000));
      g.stroke();
    }
    g.setLineDash([]);

    if (this.hoverX != null && this.hoverX >= PAD.left) {
      const t = ((this.hoverX - PAD.left) / (w - PAD.left - PAD.right)) * tMax;
      let i = 0;
      while (i < n - 1 && S.t[i + 1] <= t) i++;
      const X = xScale(S.t[i]);
      g.strokeStyle = css('--axis');
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(X + 0.5, PAD.top); g.lineTo(X + 0.5, h - PAD.bottom); g.stroke();
      const rows = ENERGY_SERIES.map((s) => `${s.label} : ${fmt(S[s.key][i] * 1000)} mJ`).join('<br>');
      this.tooltip.show(X, PAD.top + 40, `<b>t = ${fmt(S.t[i])} s</b><br>${rows}`);
    }
  }
}
