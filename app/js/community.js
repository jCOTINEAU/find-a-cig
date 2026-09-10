// Fonctions communautaires : contribuer ses données à la carte de ville, et lire
// les points chauds agrégés. Tout passe par Supabase avec sign-in anonyme.
// Se désactive proprement si Supabase n'est pas configuré (app reste 100 % locale).
import { createClient } from '../vendor/supabase/supabase.js';

let client = null;
let clientPromise = null;

async function loadConfig() {
  // config.local.js (dev, gitignoré) surcharge config.js (prod, committé).
  for (const path of ['../config.local.js', '../config.js']) {
    try {
      const cfg = await import(path);
      if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
        return { url: cfg.SUPABASE_URL, key: cfg.SUPABASE_ANON_KEY };
      }
    } catch { /* fichier absent : on passe au suivant */ }
  }
  return null;
}

async function getClient() {
  if (client) return client;
  if (!clientPromise) {
    clientPromise = (async () => {
      const cfg = await loadConfig();
      if (!cfg) return null;
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

export async function fetchHotspots(windowDays = 30, gridDeg = 0.001) {
  const c = await getClient();
  if (!c) return [];
  const { data, error } = await c.rpc('hotspots', { window_days: windowDays, grid_deg: gridDeg });
  if (error) throw error;
  return data || [];
}

export async function fetchHotspotPoints(windowDays = 30, gridDeg = 0.001) {
  const c = await getClient();
  if (!c) return [];
  const { data, error } = await c.rpc('hotspot_points', { window_days: windowDays, grid_deg: gridDeg });
  if (error) throw error;
  return data || [];
}
