-- Indexation géographique (PostGIS) + requêtes par bounding-box (zone visible).
-- Permet à la carte de ville de ne récupérer que les points de la fenêtre
-- affichée, via un index spatial GiST → scalable à l'échelle nationale.

create extension if not exists postgis;

-- Colonne géographique dérivée (immuable) + index spatial GiST.
alter table public.observations
  add column if not exists geog geography(Point, 4326)
  generated always as (st_setsrid(st_makepoint(lon, lat), 4326)::geography) stored;

create index if not exists observations_geog_idx on public.observations using gist (geog);

-- On remplace les fonctions par des versions acceptant une bounding-box.
drop function if exists public.hotspots(int, double precision);
drop function if exists public.hotspot_points(int, double precision);

-- Agrégat par cellule (zoom dézoomé), borné à la zone visible.
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

-- Points précis (zoom rapproché), bornés à la zone visible et aux cellules
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
