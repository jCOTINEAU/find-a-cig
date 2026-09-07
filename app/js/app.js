import * as db from './db.js';
import { PokeBall, supported as bleSupported } from './ball.js';
import { renderBarChart, renderTable } from './charts.js';

// Types de déchets — extensible : ajouter une entrée + un mapping bouton.
const TYPES = {
  megot: { label: 'Mégot', color: 'var(--series-1)' },
};

// Modes de session : détection (cartographier au sol) vs collecte (ce qu'on retire).
const MODES = {
  detection: { icon: '🔍', label: 'Détection', heroLabel: 'détectés cette session', verb: 'Détecté', color: 'var(--series-1)' },
  collecte:  { icon: '🧤', label: 'Collecte',  heroLabel: 'ramassés cette session', verb: 'Ramassé', color: 'var(--series-2)' },
};
const modeOf = session => MODES[session?.mode] ? session.mode : 'detection';

const $ = id => document.getElementById(id);

// Durée pendant laquelle un point fraîchement marqué accepte un meilleur fix GPS.
// Assez court pour ne pas enregistrer l'endroit où on a marché ensuite.
const REFINE_MS = 6000;

// Trajet : on pose un point dès qu'on s'est déplacé de TRACK_MIN_DIST mètres
// (donc plus dense quand on marche vite), en ignorant les fixes trop imprécis.
const TRACK_MIN_DIST = 8;
const TRACK_MAX_ACC = 50;

const state = {
  sessionId: null,
  sessionCount: 0,
  lastPointId: null,
  lastFix: null,       // { lat, lon, acc, ts }
  watchId: null,
  wakeLock: null,
  range: 'all',        // today | 7 | 30 | all
  mode: 'detection',   // mode de la session en cours / sélectionné
  map: null,
  mapLayer: null,
  audioCtx: null,
  pending: [],         // points en cours d'affinage : { id, until, bestAcc }
  lastTrack: null,     // dernier point de trajet enregistré : { lat, lon }
};

// Distance en mètres entre deux positions (haversine).
function distanceM(a, b) {
  const R = 6_371_000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

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
function updateGeoStatus(acc) {
  const el = $('geo-status');
  if (acc <= 15) {
    el.dataset.state = 'ok';
    el.textContent = `GPS ±${Math.round(acc)} m ✓`;
  } else if (acc <= 35) {
    el.dataset.state = 'off';
    el.textContent = `GPS ±${Math.round(acc)} m — se précise…`;
  } else {
    el.dataset.state = 'bad';
    el.textContent = `GPS ±${Math.round(acc)} m — imprécis, attends un peu`;
  }
}

// Enregistre un point de trajet quand on s'est assez déplacé (échantillonnage
// par distance = adaptatif à la vitesse), en filtrant les fixes trop imprécis.
function maybeRecordTrack(fix) {
  if (state.sessionId === null || fix.acc > TRACK_MAX_ACC) return;
  if (state.lastTrack && distanceM(state.lastTrack, fix) < TRACK_MIN_DIST) return;
  state.lastTrack = { lat: fix.lat, lon: fix.lon };
  db.addTrackPoint({ sessionId: state.sessionId, ts: fix.ts, lat: fix.lat, lon: fix.lon, acc: fix.acc });
}

// À chaque nouveau fix, améliore les points marqués récemment si la précision
// s'est améliorée depuis leur enregistrement.
function refinePending(fix) {
  if (state.pending.length === 0) return;
  const now = Date.now();
  state.pending = state.pending.filter(p => p.until > now);
  for (const p of state.pending) {
    if (fix.acc < p.bestAcc) {
      p.bestAcc = fix.acc;
      db.updatePoint(p.id, { lat: fix.lat, lon: fix.lon, acc: fix.acc });
      if (state.lastPointId === p.id) {
        $('session-log').textContent = `Position affinée à ±${Math.round(fix.acc)} m`;
      }
    }
  }
}

function startGeo() {
  state.lastTrack = null;
  if (!('geolocation' in navigator)) {
    $('geo-status').dataset.state = 'bad';
    $('geo-status').textContent = 'GPS non disponible';
    return;
  }
  state.watchId = navigator.geolocation.watchPosition(
    pos => {
      const fix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        acc: pos.coords.accuracy,
        ts: pos.timestamp,
      };
      state.lastFix = fix;
      updateGeoStatus(fix.acc);
      refinePending(fix);
      maybeRecordTrack(fix);
    },
    err => {
      $('geo-status').dataset.state = 'bad';
      $('geo-status').textContent = `GPS : ${err.message}`;
    },
    { enableHighAccuracy: true, maximumAge: 0 }, // jamais de position en cache
  );
}

function stopGeo() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.lastFix = null;
  state.pending = [];
  state.lastTrack = null;
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
    state.sessionId = await db.createSession(state.mode);
    state.sessionCount = 0;
    state.lastPointId = null;
    $('session-count').textContent = '0';
    $('hero-label').textContent = MODES[state.mode].heroLabel;
    $('mode-select').hidden = true;
    $('btn-session').textContent = 'Terminer la session';
    $('btn-session').classList.add('stop');
    $('btn-mark').disabled = false;
    $('session-log').textContent = `${MODES[state.mode].icon} ${MODES[state.mode].label} démarrée — bonne chasse !`;
    $('bg-hint').hidden = false;
    startGeo();
    acquireWakeLock();
    state.audioCtx ??= new AudioContext(); // initialisé sur geste utilisateur
  } else {
    await db.endSession(state.sessionId);
    $('session-log').textContent = `Session terminée : ${state.sessionCount} mégot(s).`;
    state.sessionId = null;
    $('btn-session').textContent = 'Démarrer une session';
    $('btn-session').classList.remove('stop');
    $('mode-select').hidden = false;
    $('hero-label').textContent = 'mégots cette session';
    $('btn-mark').disabled = true;
    $('btn-undo').disabled = true;
    $('bg-hint').hidden = true;
    stopGeo();
    state.wakeLock?.release().catch(() => {});
    state.wakeLock = null;
  }
}

async function mark(type = 'megot') {
  if (state.sessionId === null) return;
  const fix = state.lastFix;
  const usable = fix && Date.now() - fix.ts < 15_000;
  const point = {
    sessionId: state.sessionId,
    ts: Date.now(),
    type,
    lat: usable ? fix.lat : null,
    lon: usable ? fix.lon : null,
    acc: usable ? fix.acc : null,
  };
  const id = await db.addPoint(point);
  state.lastPointId = id;
  state.sessionCount++;
  $('session-count').textContent = String(state.sessionCount);
  $('btn-undo').disabled = false;
  feedback();

  if (usable) {
    $('session-log').textContent = `${MODES[state.mode].verb} à ±${Math.round(fix.acc)} m`;
    // Affine ce point si un meilleur fix arrive dans les secondes qui suivent.
    state.pending.push({ id, until: Date.now() + REFINE_MS, bestAcc: fix.acc });
  } else if ('geolocation' in navigator) {
    // Aucun fix récent : one-shot pour compléter le point a posteriori.
    $('session-log').textContent = '⏳ Marqué — position GPS en cours…';
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
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }
}

async function undo() {
  if (state.lastPointId === null) return;
  state.pending = state.pending.filter(p => p.id !== state.lastPointId);
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

// Map sessionId → mode ('detection' par défaut pour les anciennes sessions).
async function sessionModeMap() {
  const map = new Map();
  for (const s of await db.getAllSessions()) map.set(s.id, modeOf(s));
  return map;
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
  const sessionMode = await sessionModeMap();
  const points = all.filter(p => p.lat !== null);
  const missing = all.length - points.length;

  const banner = $('map-banner');
  banner.hidden = missing === 0;
  banner.textContent = `⚠️ ${missing} point(s) sans position GPS (non affichés)`;

  // Légende visible seulement si les deux modes sont présents.
  const modesPresent = new Set(points.map(p => sessionMode.get(p.sessionId) ?? 'detection'));
  $('map-legend').hidden = modesPresent.size < 2;

  const css = getComputedStyle(document.documentElement);
  const colorFor = mode => css.getPropertyValue(MODES[mode].color.replace('var(', '').replace(')', '')).trim();

  const bounds = [];

  // Trajets d'abord (sous les points) : une polyligne par session, colorée par mode.
  const start = rangeStart();
  const track = (await db.getAllTrack()).filter(t => t.ts >= start).sort((a, b) => a.ts - b.ts);
  const trackBySession = new Map();
  for (const t of track) {
    if (!trackBySession.has(t.sessionId)) trackBySession.set(t.sessionId, []);
    trackBySession.get(t.sessionId).push([t.lat, t.lon]);
  }
  for (const [sid, latlngs] of trackBySession) {
    bounds.push(...latlngs);
    if (latlngs.length < 2) continue;
    const mode = sessionMode.get(sid) ?? 'detection';
    L.polyline(latlngs, { color: colorFor(mode), weight: 3, opacity: 0.5 }).addTo(state.mapLayer);
  }

  // Puis les mégots par-dessus.
  for (const p of points) {
    const mode = sessionMode.get(p.sessionId) ?? 'detection';
    bounds.push([p.lat, p.lon]);
    L.circleMarker([p.lat, p.lon], {
      radius: 6, color: '#fcfcfb', weight: 2, fillColor: colorFor(mode), fillOpacity: 0.9,
    })
      .bindPopup(`${MODES[mode].icon} ${MODES[mode].label} — ${TYPES[p.type]?.label ?? p.type}`
        + ` · ${new Date(p.ts).toLocaleString('fr-FR')}`
        + (p.acc != null ? ` · ±${Math.round(p.acc)} m` : ' · sans position'))
      .addTo(state.mapLayer);
  }

  if (bounds.length > 0) {
    state.map.fitBounds(L.latLngBounds(bounds).pad(0.2));
  } else {
    centerOnUser(); // rien à afficher : on centre sur l'utilisateur
  }
}

/* ═══ Stats ═══ */
function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtSeconds(s) {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s % 60)).padStart(2, '0')}`;
}

// Écarts de temps entre mégots consécutifs, calculés PAR session (l'écart entre
// deux sessions n'a pas de sens). Retourne moyenne / médiane / max, ou null.
function gapStats(points) {
  const bySession = new Map();
  for (const p of points) {
    if (!bySession.has(p.sessionId)) bySession.set(p.sessionId, []);
    bySession.get(p.sessionId).push(p.ts);
  }
  const gaps = [];
  for (const timestamps of bySession.values()) {
    timestamps.sort((a, b) => a - b);
    for (let i = 1; i < timestamps.length; i++) gaps.push((timestamps[i] - timestamps[i - 1]) / 1000);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return {
    avg: gaps.reduce((a, b) => a + b, 0) / gaps.length,
    median: gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2,
    max: gaps[gaps.length - 1],
    count: gaps.length,
  };
}

async function renderStats() {
  const points = await filteredPoints();
  const sessions = await db.getAllSessions();
  const sessionMode = await sessionModeMap();
  const start = rangeStart();

  // Tuiles : séparation détectés / ramassés selon le mode de leur session.
  let detected = 0;
  let collected = 0;
  for (const p of points) {
    if ((sessionMode.get(p.sessionId) ?? 'detection') === 'collecte') collected++;
    else detected++;
  }
  $('tile-detected').textContent = String(detected);
  $('tile-collected').textContent = String(collected);
  $('tile-sessions').textContent = String(sessions.filter(s => s.start >= start).length);

  // Temps entre deux mégots
  const gaps = gapStats(points);
  $('gap-avg').textContent = gaps ? fmtSeconds(gaps.avg) : '—';
  $('gap-median').textContent = gaps ? fmtSeconds(gaps.median) : '—';
  $('gap-max').textContent = gaps ? fmtSeconds(gaps.max) : '—';
  $('gap-hint').textContent = gaps
    ? `sur ${gaps.count} intervalle${gaps.count > 1 ? 's' : ''}`
    : 'Marque au moins 2 mégots dans une session pour ce calcul.';

  // Par heure de la journée (0–23)
  const hours = Array(24).fill(0);
  for (const p of points) hours[new Date(p.ts).getHours()]++;
  const hourLabels = hours.map((_, h) => `${h} h`);
  renderBarChart($('chart-hours'), { labels: hourLabels, values: hours, xTickEvery: 3 });
  renderTable($('table-hours'), { labels: hourLabels, values: hours, colLabel: 'Heure' });

  // Par jour (14 derniers jours de la période)
  const byDay = new Map();
  for (const p of points) byDay.set(localDay(p.ts), (byDay.get(localDay(p.ts)) ?? 0) + 1);
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

/* ═══ Historique des sessions ═══ */
function fmtDateTime(ts) {
  return new Date(ts).toLocaleString('fr-FR', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDuration(session) {
  if (!session.end) return 'en cours';
  const min = Math.round((session.end - session.start) / 60_000);
  if (min < 1) return '< 1 min';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

function defaultName(session) {
  return `${MODES[modeOf(session)].label} du ${fmtDateTime(session.start)}`;
}

function sessionCard(session, count) {
  const mode = modeOf(session);
  const card = document.createElement('div');
  card.className = 'session-card';

  const badge = document.createElement('div');
  badge.className = 'session-mode';
  badge.dataset.mode = mode;
  badge.textContent = `${MODES[mode].icon} ${MODES[mode].label}`;

  const name = document.createElement('input');
  name.className = 'session-name';
  name.value = session.name || defaultName(session);
  name.setAttribute('aria-label', 'Nom de la session');
  name.addEventListener('change', () => {
    db.renameSession(session.id, name.value.trim() || defaultName(session));
  });

  const verb = mode === 'collecte' ? 'ramassé' : 'détecté';
  const meta = document.createElement('div');
  meta.className = 'session-meta';
  meta.textContent = `${count} ${verb}${count > 1 ? 's' : ''} · ${fmtDateTime(session.start)} · ${fmtDuration(session)}`;

  const del = document.createElement('button');
  del.className = 'btn btn-ghost session-del';
  del.textContent = '🗑 Supprimer';
  // Suppression en deux temps (pas de dialogue bloquant).
  let armed = false;
  let timer = null;
  del.addEventListener('click', async () => {
    if (session.id === state.sessionId) {
      del.textContent = 'Session en cours — termine-la d\'abord';
      setTimeout(() => { del.textContent = '🗑 Supprimer'; }, 2500);
      return;
    }
    if (!armed) {
      armed = true;
      del.textContent = 'Confirmer la suppression ?';
      del.classList.add('danger');
      timer = setTimeout(() => {
        armed = false;
        del.textContent = '🗑 Supprimer';
        del.classList.remove('danger');
      }, 3000);
      return;
    }
    clearTimeout(timer);
    await db.deleteSession(session.id);
    renderSessions();
  });

  card.append(badge, name, meta, del);
  return card;
}

async function renderSessions() {
  const container = $('sessions-list');
  container.replaceChildren();
  const [sessions, points] = await Promise.all([db.getAllSessions(), db.getAllPoints()]);

  if (sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Aucune session enregistrée.';
    container.append(empty);
    return;
  }

  const counts = new Map();
  for (const p of points) counts.set(p.sessionId, (counts.get(p.sessionId) ?? 0) + 1);

  sessions.sort((a, b) => b.start - a.start);
  for (const session of sessions) {
    container.append(sessionCard(session, counts.get(session.id) ?? 0));
  }
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
  const sessionMode = await sessionModeMap();
  const points = (await filteredPoints()).filter(p => p.lat !== null);
  const geojson = {
    type: 'FeatureCollection',
    features: points.map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: {
        type: p.type,
        mode: sessionMode.get(p.sessionId) ?? 'detection',
        ts: new Date(p.ts).toISOString(),
        accuracy_m: p.acc,
        sessionId: p.sessionId,
      },
    })),
  };
  download('find-a-cig.geojson', 'application/geo+json', JSON.stringify(geojson, null, 2));
}

async function exportCSV() {
  const sessionMode = await sessionModeMap();
  const points = await filteredPoints();
  const rows = [['ts_iso', 'mode', 'type', 'lat', 'lon', 'accuracy_m', 'session_id']];
  for (const p of points) {
    rows.push([
      new Date(p.ts).toISOString(),
      sessionMode.get(p.sessionId) ?? 'detection',
      p.type, p.lat ?? '', p.lon ?? '', p.acc ?? '', p.sessionId,
    ]);
  }
  download('find-a-cig.csv', 'text/csv', rows.map(r => r.join(',')).join('\n'));
}

/* ═══ Onglets ═══ */
function showPanel(name) {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.panel === name);
  for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('active', panel.id === `panel-${name}`);
  $('filter-row').hidden = name === 'session' || name === 'sessions';
  if (name === 'map') renderMap();
  if (name === 'stats') renderStats();
  if (name === 'sessions') renderSessions();
}

/* ═══ Déclencheur clavier / télécommande Bluetooth ═══ */
// Permet de marquer sans la ball : télécommande photo BT (souvent reconnue comme
// clavier envoyant Entrée / flèches / volume) ou clavier. Voir la limite des
// boutons de volume physiques expliquée à l'utilisateur.
const MARK_CODES = new Set([
  'AudioVolumeUp', 'ArrowUp', 'Enter', 'NumpadEnter', 'Space', 'NumpadAdd',
]);
document.addEventListener('keydown', e => {
  if (state.sessionId === null || e.repeat) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || tag === 'SELECT') return;
  if (MARK_CODES.has(e.code) || e.key === '+' || e.key === 'VolumeUp') {
    e.preventDefault();
    mark('megot');
  }
});

/* ═══ Init ═══ */
$('btn-session').addEventListener('click', toggleSession);
$('btn-mark').addEventListener('click', () => mark('megot'));
$('btn-undo').addEventListener('click', undo);
$('btn-ball').addEventListener('click', connectBall);
$('btn-export-geojson').addEventListener('click', exportGeoJSON);
$('btn-export-csv').addEventListener('click', exportCSV);
for (const opt of document.querySelectorAll('.mode-opt')) {
  opt.addEventListener('click', () => {
    if (state.sessionId !== null) return; // pas de changement de mode en cours de session
    document.querySelector('.mode-opt.selected')?.classList.remove('selected');
    opt.classList.add('selected');
    state.mode = opt.dataset.mode;
  });
}
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

// Easter egg : 5 taps sur le titre → page cachée de debug BLE.
let titleTaps = 0;
let titleTapTimer = null;
$('app-title').addEventListener('click', () => {
  titleTaps++;
  clearTimeout(titleTapTimer);
  titleTapTimer = setTimeout(() => { titleTaps = 0; }, 2000);
  if (titleTaps >= 5) { titleTaps = 0; location.href = 'debug.html'; }
});
