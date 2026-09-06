// Histogramme SVG single-série (specs dataviz : barres ≤24px, bout arrondi 4px
// côté données / carré à la baseline, grille hairline, label direct sur l'extrême,
// tooltip au survol et au focus clavier).
const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function niceMax(max) {
  if (max <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (max <= m * pow) return m * pow;
  return 10 * pow;
}

// Barre : coins arrondis en haut (r=4), carrée à la baseline.
function barPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} v${-(h - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} z`;
}

export function renderBarChart(container, { labels, values, xTickEvery = 1, unit = 'mégots' }) {
  container.replaceChildren();
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Aucune donnée sur la période.';
    container.append(empty);
    return;
  }

  const W = 600, H = 220;
  const pad = { top: 18, right: 8, bottom: 24, left: 30 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const yMax = niceMax(Math.max(...values));
  const band = plotW / values.length;
  const barW = Math.min(24, Math.max(2, band - 2)); // gap ≥2px entre barres
  const maxIdx = values.indexOf(Math.max(...values));

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  // Grille horizontale + ticks Y (nombres ronds)
  const ticks = yMax <= 5 ? yMax : 5;
  for (let i = 1; i <= ticks; i++) {
    const value = (yMax / ticks) * i;
    const y = pad.top + plotH - (value / yMax) * plotH;
    svg.append(el('line', { x1: pad.left, x2: W - pad.right, y1: y, y2: y, stroke: 'var(--grid)', 'stroke-width': 1 }));
    const label = el('text', { x: pad.left - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--text-muted)' });
    label.textContent = String(Math.round(value));
    svg.append(label);
  }
  // Baseline
  svg.append(el('line', { x1: pad.left, x2: W - pad.right, y1: pad.top + plotH, y2: pad.top + plotH, stroke: 'var(--baseline)', 'stroke-width': 1 }));

  const tooltip = document.getElementById('tooltip');

  values.forEach((v, i) => {
    const cx = pad.left + band * i + band / 2;
    const h = (v / yMax) * plotH;
    const y = pad.top + plotH - h;

    let bar = null;
    if (v > 0) {
      bar = el('path', { d: barPath(cx - barW / 2, y, barW, h, 4), class: 'bar' });
      svg.append(bar);
      // Label direct : uniquement l'extrême
      if (i === maxIdx) {
        const lbl = el('text', { x: cx, y: y - 5, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: 'var(--text-secondary)' });
        lbl.textContent = String(v);
        svg.append(lbl);
      }
    }

    // Label X (échantillonné pour éviter la collision)
    if (i % xTickEvery === 0) {
      const xl = el('text', { x: cx, y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--text-muted)' });
      xl.textContent = labels[i];
      svg.append(xl);
    }

    // Hit target pleine hauteur (plus grand que la marque) + focus clavier
    const hit = el('rect', {
      x: pad.left + band * i, y: pad.top, width: band, height: plotH,
      class: 'hit', tabindex: 0, 'aria-label': `${labels[i]} : ${v} ${unit}`,
    });
    const show = () => {
      tooltip.replaceChildren();
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = `${v} ${unit}`;
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = labels[i];
      tooltip.append(val, lbl);
      tooltip.hidden = false;
      const rect = hit.getBoundingClientRect();
      const tw = tooltip.offsetWidth;
      tooltip.style.left = `${Math.min(Math.max(4, rect.left + rect.width / 2 - tw / 2), window.innerWidth - tw - 4)}px`;
      tooltip.style.top = `${rect.top - tooltip.offsetHeight - 6}px`;
      if (bar) bar.classList.add('hover');
    };
    const hide = () => {
      tooltip.hidden = true;
      if (bar) bar.classList.remove('hover');
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
    svg.append(hit);
  });

  container.append(svg);
}

// Vue tableau (accessibilité : chaque valeur reste lisible sans survol)
export function renderTable(container, { labels, values, colLabel, unit = 'Mégots' }) {
  container.replaceChildren();
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const text of [colLabel, unit]) {
    const th = document.createElement('th');
    th.textContent = text;
    head.append(th);
  }
  const body = table.createTBody();
  labels.forEach((label, i) => {
    if (values[i] === 0) return;
    const row = body.insertRow();
    row.insertCell().textContent = label;
    row.insertCell().textContent = String(values[i]);
  });
  container.append(table);
}
