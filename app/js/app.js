import * as db from './db.js';
import { PokeBall, supported as bleSupported } from './ball.js';
import { renderBarChart, renderTable } from './charts.js';

// Types de déchets — extensible : ajouter une entrée + un mapping bouton.
const TYPES = {
  megot: { label: 'Mégot', color: 'var(--series-1)' },
};

const $ = id => document.getElementById(id);

const state = {
  sessionId: null,
  sessionCount: 0,
  lastPointId: null,
  lastFix: null,       // { lat, lon, acc, ts }
  watchId: null,
  wakeLock: null,
  range: 'all',        // today | 7 | 30 | all
  map: null,
  mapLayer: null,
  audioCtx: null,
};

const ball = new PokeBall();

/* ═══ Feedback (visuel + son + vibration du téléphone) ═══ */
function beep() {
  try {
    state.audioCtx ??= new AudioContext();
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, state.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, state.audioCtx.currentTime + 0.12);
    osc.connect(gain).connect(state.audioCtx.destination);
    osc.start();
    osc.stop(state.audioCtx.currentTime + 0.12);
  } catch { /* audio indisponible : pas bloquant */ }
}

function feedback() {
  beep();
  navigator.vibrate?.(80);
  $('session-count').classList.remove('flash');
  requestAnimationFrame(() => $('session-count').classList.add('flash'));
}

/* ═══ Géolocalisation ═══ */
function startGeo() {
  if (!('geolocation' in navigator)) {
    $('geo-status').dataset.state = 'bad';
    $('geo-status').textContent = 'GPS non disponible';
    return;
  }
  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      state.lastFix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        acc: pos.coords.accuracy,
        ts: pos.timestamp,
      };
      $('geo-status').dataset.state = pos.coords.accuracy <= 25 ? 'ok' : 'off';
      $('geo-status').textContent = `GPS ±${Math.round(pos.coords.accuracy)} m`;
    },
    err => {
      $('geo-status').dataset.state = 'bad';
      $('geo-status').textContent = `GPS : ${err.message}`;
    },
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

function stopGeo() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.lastFix = null;
  $('geo-status').dataset.state = 'off';
  $('geo-status').textContent = 'GPS inactif';
}

/* ═══ Wake lock (garder l'écran allumé pendant la session) ═══ */
async function acquireWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* refusé : tolérable */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.sessionId) acquireWakeLock();
});

/* ═══ Session ═══ */
async function toggleSession() {
  if (state.sessionId === null) {
    state.sessionId = await db.createSession();
    state.sessionCount = 0;
    state.lastPointId = null;
    $('session-count').textContent = '0';
    $('btn-session').textContent = 'Terminer la session';
    $('btn-session').classList.add('stop');
    $('btn-mark').disabled = false;
    $('session-log').textContent = 'Session démarrée — bonne chasse !';
    startGeo();
    acquireWakeLock();
    state.audioCtx ??= new AudioContext(); // initialisé sur geste utilisateur
  } else {
    await db.endSession(state.sessionId);
    $('session-log').textContent = `Session terminée : ${state.sessionCount} mégot(s).`;
    state.sessionId = null;
    $('btn-session').textContent = 'Démarrer une session';
    $('btn-session').classList.remove('stop');
    $('btn-mark').disabled = true;
    $('btn-undo').disabled = true;
    stopGeo();
    state.wakeLock?.release().catch(() => {});
  }
}

async function mark(type = 'megot') {
  if (state.sessionId === null) return;
  const fix = state.lastFix;
  const stale = fix && Date.now() - fix.ts > 30_000;
  const point = {
    sessionId: state.sessionId,
    ts: Date.now(),
    type,
    lat: fix && !stale ? fix.lat : null,
    lon: fix && !stale ? fix.lon : null,
    acc: fix && !stale ? fix.acc : null,
  };
  const id = await db.addPoint(point);
  state.lastPointId = id;
  state.sessionCount++;
  $('session-count').textContent = String(state.sessionCount);
  $('btn-undo').disabled = false;
  $('session-log').textContent = point.lat === null
    ? '⏳ Marqué — position GPS en cours…'
    : `Marqué à ±${Math.round(point.acc)} m`;
  feedback();

  // Position absente ou périmée au moment de l'appui : on demande un fix
  // frais et on complète le point a posteriori.
  if (point.lat === null && 'geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      async pos => {
        await db.updatePoint(id, {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          acc: pos.coords.accuracy,
        });
        if (state.lastPointId === id) {
          $('session-log').textContent = `Position rattrapée à ±${Math.round(pos.coords.accuracy)} m`;
        }
      },
      () => {
        if (state.lastPointId === id) {
          $('session-log').textContent = '⚠️ Marqué sans position (GPS indisponible)';
        }
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 10_000 },
    );
  }
}

async function undo() {
  if (state.lastPointId === null) return;
  await db.deletePoint(state.lastPointId);
  state.lastPointId = null;
  state.sessionCount = Math.max(0, state.sessionCount - 1);
  $('session-count').textContent = String(state.sessionCount);
  $('btn-undo').disabled = true;
  $('session-log').textContent = 'Dernier point annulé.';
}

/* ═══ Ball ═══ */
function setBallStatus(stateName, text) {
  $('ball-status').dataset.state = stateName;
  $('ball-status').textContent = text;
}

async function connectBall() {
  if (!bleSupported) {
    setBallStatus('lost', 'Web Bluetooth non supporté (utilise Chrome/Edge)');
    return;
  }
  try {
    $('btn-ball').disabled = true;
    setBallStatus('off', 'Connexion…');
    await ball.connect();
  } catch (err) {
    setBallStatus('lost', err.name === 'NotFoundError' ? 'Aucune ball choisie' : `Erreur : ${err.message}`);
  } finally {
    $('btn-ball').disabled = false;
  }
}

ball.addEventListener('connected', e => {
  const bat = e.detail.battery;
  setBallStatus('on', `Ball connectée${bat !== null ? ` · 🔋 ${bat} %` : ''}`);
  $('btn-ball').textContent = 'Reconnecter';
});
ball.addEventListener('disconnected', () => setBallStatus('lost', 'Ball déconnectée'));
ball.addEventListener('top', () => mark('megot'));
// Le clic du stick est réservé aux futurs types de déchets.

/* ═══ Filtre de période ═══ */
function rangeStart() {
  const now = new Date();
  if (state.range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (state.range === '7') return now.getTime() - 7 * 86_400_000;
  if (state.range === '30') return now.getTime() - 30 * 86_400_000;
  return 0;
}

async function filteredPoints() {
  const start = rangeStart();
  return (await db.getAllPoints()).filter(p => p.ts >= start);
}

/* ═══ Carte ═══ */
function centerOnUser(zoom = 17) {
  const place = (lat, lon) => {
    state.map.setView([lat, lon], zoom);
    state.meMarker?.remove();
    state.meMarker = L.circleMarker([lat, lon], {
      radius: 8, color: '#fcfcfb', weight: 2, fillColor: '#0ca30c', fillOpacity: 1,
    }).bindPopup('Ma position').addTo(state.map);
  };
  if (state.lastFix && Date.now() - state.lastFix.ts < 30_000) {
    place(state.lastFix.lat, state.lastFix.lon);
  } else {
    navigator.geolocation?.getCurrentPosition(
      pos => place(pos.coords.latitude, pos.coords.longitude),
      () => {}, // refus/échec : on garde la vue courante
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }
}

async function renderMap() {
  if (!state.map) {
    state.map = L.map('map', { zoomControl: true }).setView([46.6, 2.4], 5); // France en attendant le fix
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(state.map);
    state.mapLayer = L.layerGroup().addTo(state.map);
    L.Control.Locate = L.Control.extend({
      onAdd() {
        const btn = L.DomUtil.create('button', 'leaflet-bar locate-btn');
        btn.textContent = '📍';
        btn.title = 'Centrer sur ma position';
        L.DomEvent.on(btn, 'click', e => { L.DomEvent.stop(e); centerOnUser(); });
        return btn;
      },
    });
    new L.Control.Locate({ position: 'topleft' }).addTo(state.map);
  }
  state.map.invalidateSize();

  state.mapLayer.clearLayers();
  const all = await filteredPoints();
  const points = all.filter(p => p.lat !== null);
  const missing = all.length - points.length;

  const banner = $('map-banner');
  banner.hidden = missing === 0;
  banner.textContent = `⚠️ ${missing} point(s) sans position GPS (non affichés)`;

  const seriesBlue = getComputedStyle(document.documentElement).getPropertyValue('--series-1').trim();
  for (const p of points) {
    L.circleMarker([p.lat, p.lon], {
      radius: 6, color: '#fcfcfb', weight: 2, fillColor: seriesBlue, fillOpacity: 0.9,
    })
      .bindPopup(`${TYPES[p.type]?.label ?? p.type} — ${new Date(p.ts).toLocaleString('fr-FR')}`)
      .addTo(state.mapLayer);
  }

  if (points.length > 0) {
    state.map.fitBounds(L.latLngBounds(points.map(p => [p.lat, p.lon])).pad(0.2));
  } else {
    centerOnUser(); // pas de points : on centre sur l'utilisateur
  }
}

/* ═══ Stats ═══ */
function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function renderStats() {
  const points = await filteredPoints();
  const sessions = await db.getAllSessions();
  const start = rangeStart();

  // Tuiles
  const byDay = new Map();
  for (const p of points) byDay.set(localDay(p.ts), (byDay.get(localDay(p.ts)) ?? 0) + 1);
  $('tile-total').textContent = String(points.length);
  $('tile-sessions').textContent = String(sessions.filter(s => s.start >= start).length);
  $('tile-best').textContent = String(Math.max(0, ...byDay.values()));

  // Par heure de la journée (0–23)
  const hours = Array(24).fill(0);
  for (const p of points) hours[new Date(p.ts).getHours()]++;
  const hourLabels = hours.map((_, h) => `${h} h`);
  renderBarChart($('chart-hours'), { labels: hourLabels, values: hours, xTickEvery: 3 });
  renderTable($('table-hours'), { labels: hourLabels, values: hours, colLabel: 'Heure' });

  // Par jour (14 derniers jours de la période)
  const days = [];
  const dayValues = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = localDay(d.getTime());
    days.push(d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }));
    dayValues.push(d.getTime() >= start || localDay(d.getTime()) === localDay(start) ? (byDay.get(key) ?? 0) : 0);
  }
  renderBarChart($('chart-days'), { labels: days, values: dayValues, xTickEvery: 2 });
  renderTable($('table-days'), { labels: days, values: dayValues, colLabel: 'Jour' });
}

/* ═══ Exports ═══ */
function download(filename, mime, content) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportGeoJSON() {
  const points = (await filteredPoints()).filter(p => p.lat !== null);
  const geojson = {
    type: 'FeatureCollection',
    features: points.map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { type: p.type, ts: new Date(p.ts).toISOString(), accuracy_m: p.acc, sessionId: p.sessionId },
    })),
  };
  download('find-a-cig.geojson', 'application/geo+json', JSON.stringify(geojson, null, 2));
}

async function exportCSV() {
  const points = await filteredPoints();
  const rows = [['ts_iso', 'type', 'lat', 'lon', 'accuracy_m', 'session_id']];
  for (const p of points) {
    rows.push([new Date(p.ts).toISOString(), p.type, p.lat ?? '', p.lon ?? '', p.acc ?? '', p.sessionId]);
  }
  download('find-a-cig.csv', 'text/csv', rows.map(r => r.join(',')).join('\n'));
}

/* ═══ Onglets ═══ */
function showPanel(name) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.panel === name);
  for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('active', panel.id === `panel-${name}`);
  $('filter-row').hidden = name === 'session';
  if (name === 'map') renderMap();
  if (name === 'stats') renderStats();
}

/* ═══ Init ═══ */
$('btn-session').addEventListener('click', toggleSession);
$('btn-mark').addEventListener('click', () => mark('megot'));
$('btn-undo').addEventListener('click', undo);
$('btn-ball').addEventListener('click', connectBall);
$('btn-export-geojson').addEventListener('click', exportGeoJSON);
$('btn-export-csv').addEventListener('click', exportCSV);
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
}
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    document.querySelector('.chip.selected')?.classList.remove('selected');
    chip.classList.add('selected');
    state.range = chip.dataset.range;
    if ($('panel-map').classList.contains('active')) renderMap();
    if ($('panel-stats').classList.contains('active')) renderStats();
  });
}

if (!bleSupported) setBallStatus('off', 'Web Bluetooth indisponible (Chrome/Edge requis)');
