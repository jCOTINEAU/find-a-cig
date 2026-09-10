// Configuration Supabase (fonctions communautaires : contribuer / carte de ville).
//
// La clé anon est PUBLIQUE par design — elle est protégée par les règles RLS côté
// base, et de toute façon visible dans toute app web. Ne mets JAMAIS ici la clé
// `service_role` (elle contourne RLS).
//
// Laisser vide désactive proprement les fonctions communautaires (l'app reste
// 100 % locale). En développement, config.local.js (gitignoré) surcharge ces valeurs.
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
