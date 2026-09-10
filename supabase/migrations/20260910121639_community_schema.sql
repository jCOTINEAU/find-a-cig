-- Find a Cig — schéma communautaire (carte de ville participative).
--
-- Principe vie privée : on stocke des points PRÉCIS mais SANS le trajet (chemin
-- ordonné). Chaque observation porte un identifiant de SESSION anonyme (non
-- reliable à une personne ni entre sessions) et une date GROSSIÈRE (jour, pas
-- l'heure). Rien de brut n'est lisible publiquement : seules des vues agrégées
-- et k-anonymisées (≥ 2 passages indépendants par zone) sont exposées.

create table if not exists public.observations (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid        not null,               -- identifiant de session anonyme (device)
  observed_on date        not null,               -- date grossière (pas d'heure)
  lat         double precision not null,
  lon         double precision not null,
  waste_type  text        not null default 'megot',
  mode        text        not null default 'detection',
  created_at  timestamptz not null default now(),
  constraint lat_range   check (lat between -90 and 90),
  constraint lon_range   check (lon between -180 and 180),
  constraint mode_valid  check (mode in ('detection', 'collecte')),
  constraint not_future  check (observed_on <= current_date)
);

create index if not exists observations_observed_on_idx on public.observations (observed_on);
create index if not exists observations_cell_idx on public.observations (round(lat::numeric, 3), round(lon::numeric, 3));

-- ── RLS : insertion seule pour les utilisateurs (anonymes) connectés, aucune
--    lecture de la table brute. ────────────────────────────────────────────
alter table public.observations enable row level security;

drop policy if exists "anon insert observations" on public.observations;
create policy "anon insert observations"
  on public.observations
  for insert
  to authenticated
  with check (
    lat between -90 and 90
    and lon between -180 and 180
    and observed_on <= current_date
    and observed_on >= current_date - 3650   -- pas de date absurde dans le passé
    and mode in ('detection', 'collecte')
  );

grant insert on public.observations to authenticated;

-- ── Agrégat public : points chauds par zone, sur une fenêtre glissante. ──────
-- Chaque cellule (~grid_deg°) n'est renvoyée qu'à partir de 2 passages (sessions)
-- distincts → k-anonymat + confiance statistique + filtrage du bruit.
-- Les comptes sont des PLANCHERS (sous-comptage humain) : max_per_pass = « au
-- moins X » (le passage le plus exhaustif observé dans la zone).
create or replace function public.hotspots(window_days int default 30, grid_deg double precision default 0.001)
returns table (
  cell_lat double precision,
  cell_lon double precision,
  waste_type text,
  passes int,
  min_per_pass int,
  median_per_pass double precision,
  max_per_pass int,
  total int
)
language sql
security definer
set search_path = public
as $$
  with per_session as (
    select
      round((lat / grid_deg))::double precision * grid_deg as clat,
      round((lon / grid_deg))::double precision * grid_deg as clon,
      waste_type as wt,
      session_id,
      count(*)::int as n
    from public.observations
    where observed_on >= current_date - greatest(window_days, 0)
    group by 1, 2, 3, 4
  )
  select
    clat, clon, wt,
    count(*)::int as passes,
    min(n) as min_per_pass,
    percentile_cont(0.5) within group (order by n) as median_per_pass,
    max(n) as max_per_pass,
    sum(n)::int as total
  from per_session
  group by clat, clon, wt
  having count(*) >= 2;
$$;

grant execute on function public.hotspots(int, double precision) to anon, authenticated;

-- ── Points précis, mais UNIQUEMENT dans les zones ayant passé le seuil k-anon.
-- Permet l'affichage précis au zoom rapproché sans jamais exposer le parcours
-- unique d'une seule personne.
create or replace function public.hotspot_points(window_days int default 30, grid_deg double precision default 0.001)
returns table (
  lat double precision,
  lon double precision,
  waste_type text,
  mode text,
  observed_on date
)
language sql
security definer
set search_path = public
as $$
  with per_cell as (
    select
      round((lat / grid_deg))::double precision * grid_deg as clat,
      round((lon / grid_deg))::double precision * grid_deg as clon,
      waste_type as wt
    from public.observations
    where observed_on >= current_date - greatest(window_days, 0)
    group by 1, 2, 3
    having count(distinct session_id) >= 2
  )
  select o.lat, o.lon, o.waste_type, o.mode, o.observed_on
  from public.observations o
  join per_cell c
    on round((o.lat / grid_deg))::double precision * grid_deg = c.clat
   and round((o.lon / grid_deg))::double precision * grid_deg = c.clon
   and o.waste_type = c.wt
  where o.observed_on >= current_date - greatest(window_days, 0);
$$;

grant execute on function public.hotspot_points(int, double precision) to anon, authenticated;
