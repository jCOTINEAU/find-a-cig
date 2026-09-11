// Fonctions communautaires : contribuer ses données à la carte de ville, et lire
// les points chauds agrégés. Tout passe par Supabase avec sign-in anonyme.
// Se désactive proprement si Supabase n'est pas configuré (app reste 100 % locale).
import { createClient } from '../vendor/supabase/supabase.js';

let client = null;
let clientPromise = null;
let configPromise = null;

async function loadConfig() {
  if (configPromise) return configPromise;
  configPromise = (async () => {
    // config.local.js (dev, gitignoré) surcharge config.js (prod, committé).
    for (const path of ['../config.local.js', '../config.js']) {
      try {
        const cfg = await import(path);
        return { url: cfg.SUPABASE_URL || '', key: cfg.SUPABASE_ANON_KEY || '', env: cfg.ENV || '' };
      } catch { /* fichier absent : on passe au suivant */ }
    }
    return { url: '', key: '', env: '' };
  })();
  return configPromise;
}

async function getClient() {
  if (client) return client;
  if (!clientPromise) {
    clientPromise = (async () => {
      const cfg = await loadConfig();
      if (!cfg.url || !cfg.key) return null;
      client = createClient(cfg.url, cfg.key, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
      return client;
    })();
  }
  return clientPromise;
}

export async function isConfigured() {
  return !!(await getClient());
}

// Environnement de déploiement : 'prod' | 'dev' | 'local' | '' (non configuré).
export async function getEnv() {
  return (await loadConfig()).env;
}

async function ensureAuth(c) {
  const { data: { session } } = await c.auth.getSession();
  if (session) return session;
  const { data, error } = await c.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Transforme les points locaux en lignes minimisées :
// - date grossière (jour, pas l'heure),
// - identifiant de session anonyme aléatoire (non reliable à une personne),
// - on jette le 1er et le dernier point de chaque session (extrémités = domicile),
// - jamais le trajet.
export function buildRows(points) {
  const bySession = new Map();
  for (const p of points) {
    if (p.lat == null || p.lon == null) continue;
    if (!bySession.has(p.sessionId)) bySession.set(p.sessionId, []);
    bySession.get(p.sessionId).push(p);
  }
  const rows = [];
  for (const pts of bySession.values()) {
    pts.sort((a, b) => a.ts - b.ts);
    const usable = pts.length >= 3 ? pts.slice(1, -1) : pts;
    const sessionUuid = crypto.randomUUID();
    for (const p of usable) {
      rows.push({
        session_id: sessionUuid,
        observed_on: localDay(p.ts),
        lat: p.lat,
        lon: p.lon,
        waste_type: p.type || 'megot',
        mode: p.mode || 'detection',
      });
    }
  }
  return rows;
}

export async function contribute(points) {
  const c = await getClient();
  if (!c) throw new Error('Supabase non configuré');
  await ensureAuth(c);
  const rows = buildRows(points);
  if (rows.length === 0) return { inserted: 0 };
  const { error } = await c.from('observations').insert(rows);
  if (error) throw error;
  return { inserted: rows.length };
}

// bounds : { west, south, east, north } = zone visible de la carte (optionnel).
function withBounds(params, bounds) {
  if (bounds) {
    params.west = bounds.west; params.south = bounds.south;
    params.east = bounds.east; params.north = bounds.north;
  }
  return params;
}

export async function fetchHotspots(windowDays = 30, bounds = null, gridDeg = 0.001) {
  const c = await getClient();
  if (!c) return [];
  const { data, error } = await c.rpc('hotspots', withBounds({ window_days: windowDays, grid_deg: gridDeg }, bounds));
  if (error) throw error;
  return data || [];
}

export async function fetchHotspotPoints(windowDays = 30, bounds = null, gridDeg = 0.001) {
  const c = await getClient();
  if (!c) return [];
  const { data, error } = await c.rpc('hotspot_points', withBounds({ window_days: windowDays, grid_deg: gridDeg }, bounds));
  if (error) throw error;
  return data || [];
}

// « Martingale » : par cellule, la moyenne de points/passage tirée aléatoirement
// parmi les points réels — dé-biaise les rues sur-fréquentées.
export async function fetchSampledPoints(windowDays = 30, bounds = null, gridDeg = 0.001) {
  const c = await getClient();
  if (!c) return [];
  const { data, error } = await c.rpc('hotspot_sampled_points', withBounds({ window_days: windowDays, grid_deg: gridDeg }, bounds));
  if (error) throw error;
  return data || [];
}
