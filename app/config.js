// Configuration Supabase (fonctions communautaires : contribuer / carte de ville).
//
// La clé anon est PUBLIQUE par design — elle est protégée par les règles RLS côté
// base, et de toute façon visible dans toute app web. Ne mets JAMAIS ici la clé
// `service_role` (elle contourne RLS).
//
// En production, ces valeurs sont RÉÉCRITES au build par le workflow GitHub Pages
// (injectées depuis les variables de repo, avec ENV = 'prod' ou 'dev').
// En local, config.local.js (gitignoré) surcharge ces valeurs (ENV = 'local').
// Vide = fonctions communautaires désactivées (app 100 % locale).
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
export const ENV = '';
