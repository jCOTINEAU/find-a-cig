-- Find a Cig — schéma communautaire (carte de ville participative).
--
-- Vie privée : on stocke des points PRÉCIS mais SANS le trajet. Chaque
-- observation porte un identifiant de SESSION anonyme (non reliable à une
-- personne ni entre sessions) et une date GROSSIÈRE (jour, pas l'heure). Rien
-- de brut n'est lisible publiquement : seules des fonctions agrégées et
-- k-anonymisées (≥ 2 passages distincts par zone) sont exposées, bornées à la
-- zone visible via un index spatial PostGIS GiST.

create extension if not exists postgis;

create table if not exists public.observations (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid        not null,               -- identifiant de session anonyme (device)
  observed_on date        not null,               -- date grossière (pas d'heure)
  lat         double precision not null,
  lon         double precision not null,
  waste_type  text        not null default 'megot',
  mode        text        not null default 'detection',
  created_at  timestamptz not null default now(),
  geog        geography(Point, 4326)
                generated always as (st_setsrid(st_makepoint(lon, lat), 4326)::geography) stored,
  constraint lat_range  check (lat between -90 and 90),
  constraint lon_range  check (lon between -180 and 180),
  constraint mode_valid check (mode in ('detection', 'collecte'))
);

create index if not exists observations_observed_on_idx on public.observations (observed_on);
create index if not exists observations_geog_idx on public.observations using gist (geog);

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

-- ── Agrégat public par zone (zoom dézoomé), borné à la bounding-box visible.
-- Une cellule (~grid_deg°) n'est renvoyée qu'à partir de 2 passages (sessions)
-- distincts → k-anonymat + confiance statistique + filtrage du bruit. Les
-- comptes sont des PLANCHERS (sous-comptage humain) : max_per_pass = « au moins X ».
create or replace function public.hotspots(
  window_days int default 30,
  grid_deg double precision default 0.001,
  west double precision default -180,
  south double precision default -90,
  east double precision default 180,
  north double precision default 90
)
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
      and geog && ST_MakeEnvelope(west, south, east, north, 4326)::geography
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

grant execute on function public.hotspots(int, double precision, double precision, double precision, double precision, double precision) to anon, authenticated;

-- ── Points précis (zoom rapproché), bornés à la zone visible et aux cellules
-- ayant ≥ 2 contributeurs. Plafonné pour éviter les téléchargements massifs.
create or replace function public.hotspot_points(
  window_days int default 30,
  grid_deg double precision default 0.001,
  west double precision default -180,
  south double precision default -90,
  east double precision default 180,
  north double precision default 90,
  max_rows int default 3000
)
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
  with in_view as (
    select *
    from public.observations o
    where o.observed_on >= current_date - greatest(window_days, 0)
      and o.geog && ST_MakeEnvelope(west, south, east, north, 4326)::geography
  ),
  ok_cells as (
    select
      round((lat / grid_deg))::double precision * grid_deg as clat,
      round((lon / grid_deg))::double precision * grid_deg as clon,
      waste_type as wt
    from in_view
    group by 1, 2, 3
    having count(distinct session_id) >= 2
  )
  select v.lat, v.lon, v.waste_type, v.mode, v.observed_on
  from in_view v
  join ok_cells c
    on round((v.lat / grid_deg))::double precision * grid_deg = c.clat
   and round((v.lon / grid_deg))::double precision * grid_deg = c.clon
   and v.waste_type = c.wt
  limit greatest(max_rows, 0);
$$;

grant execute on function public.hotspot_points(int, double precision, double precision, double precision, double precision, double precision, int) to anon, authenticated;

-- ── Points ÉCHANTILLONNÉS (« martingale ») ─────────────────────────────────
-- Afficher TOUS les points sur-représente les rues très fréquentées : une rue
-- parcourue par 10 personnes paraîtrait 10× plus sale. À la place, on affiche,
-- par cellule, le nombre MOYEN de points par passage (moyenne sur la fenêtre
-- récente), tiré aléatoirement parmi les points réels de tous les contributeurs.
-- Résultat : la densité affichée ≈ ce qu'un passage typique voit, dé-biaisée.
create or replace function public.hotspot_sampled_points(
  window_days int default 30,
  grid_deg double precision default 0.001,
  west double precision default -180,
  south double precision default -90,
  east double precision default 180,
  north double precision default 90,
  max_rows int default 3000
)
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
  with in_view as (
    select
      o.lat, o.lon, o.waste_type, o.mode, o.observed_on, o.session_id,
      round((o.lat / grid_deg))::double precision * grid_deg as clat,
      round((o.lon / grid_deg))::double precision * grid_deg as clon
    from public.observations o
    where o.observed_on >= current_date - greatest(window_days, 0)
      and o.geog && ST_MakeEnvelope(west, south, east, north, 4326)::geography
  ),
  cell_target as (
    -- passes = nb de contributeurs (sessions) ; target = moyenne points/passage.
    select clat, clon, waste_type,
      count(distinct session_id) as passes,
      greatest(1, round(count(*)::numeric / count(distinct session_id)))::int as target
    from in_view
    group by clat, clon, waste_type
    having count(distinct session_id) >= 2   -- k-anonymat
  ),
  ranked as (
    select v.lat, v.lon, v.waste_type, v.mode, v.observed_on, v.clat, v.clon,
      row_number() over (
        partition by v.clat, v.clon, v.waste_type order by random()
      ) as rn
    from in_view v
    join cell_target t
      on t.clat = v.clat and t.clon = v.clon and t.waste_type = v.waste_type
  )
  select r.lat, r.lon, r.waste_type, r.mode, r.observed_on
  from ranked r
  join cell_target t
    on t.clat = r.clat and t.clon = r.clon and t.waste_type = r.waste_type
  where r.rn <= t.target
  limit greatest(max_rows, 0);
$$;

grant execute on function public.hotspot_sampled_points(int, double precision, double precision, double precision, double precision, double precision, int) to anon, authenticated;
