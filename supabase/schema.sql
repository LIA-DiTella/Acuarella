-- DiTella Scanner · esquema de Supabase.
-- Se puede ejecutar varias veces (psql o SQL Editor) sin romper nada.

-- Especies --------------------------------------------------------------------
create table if not exists public.species (
  id      text primary key,  -- coincide con templates/<id>.json
  name    text not null,
  enabled boolean not null default true
);
insert into public.species (id, name) values
  ('pirana',  'Piraña roja'),
  ('tiburon', 'Tiburón azul'),
  ('bonito',  'Bonito del Atlántico'),
  ('piloto',  'Pez piloto'),
  ('test',    'Pruebas (no aparece en el acuario)')
on conflict (id) do nothing;

-- Peces -----------------------------------------------------------------------
create table if not exists public.fish (
  id           bigint generated always as identity primary key,
  species      text not null references public.species (id),
  filename     text unique,                     -- <especie>-<id>.png (lo completa el trigger)
  created_at   timestamptz not null default now(),
  permanent    boolean not null default false,  -- peces del equipo: siempre visibles
  active       boolean not null default false,  -- visitantes: lo maneja la rotación
  uploaded     boolean not null default false,  -- el PNG ya está en Storage
  activated_at timestamptz,
  times_shown  integer not null default 0
);
create index if not exists fish_active_idx on public.fish (active, permanent);

create or replace function public.fish_set_filename() returns trigger
language plpgsql as $$
begin
  new.filename := new.species || '-' || new.id || '.png';
  return new;
end $$;

drop trigger if exists fish_filename on public.fish;
create trigger fish_filename before insert on public.fish
  for each row execute function public.fish_set_filename();

-- Configuración del acuario (una sola fila) -----------------------------------
create table if not exists public.aquarium_config (
  id               boolean primary key default true check (id),
  max_visitors     integer not null default 12,   -- visitantes activos a la vez
  rotate_count     integer not null default 2,    -- cuántos salen en cada rotación
  visitors_enabled boolean not null default true  -- false = solo peces permanentes
);
insert into public.aquarium_config default values on conflict (id) do nothing;

-- El cliente no toca las tablas: solo la vista y las funciones de abajo.
alter table public.species enable row level security;
alter table public.fish enable row level security;
alter table public.aquarium_config enable row level security;

-- Lo que muestra el acuario ---------------------------------------------------
-- La vista corre con los permisos de su dueño, así expone solo estas columnas y filas.
create or replace view public.aquarium_fish as
  select f.id, f.species, f.filename, f.created_at, f.permanent, f.activated_at
  from public.fish f
  cross join public.aquarium_config c
  where f.uploaded
    and f.species <> 'test'
    and (f.permanent or (f.active and c.visitors_enabled));

-- Funciones -------------------------------------------------------------------

-- Crea la fila de un escaneo nuevo; devuelve id y filename para subir el PNG.
create or replace function public.create_fish(p_species text) returns public.fish
language plpgsql security definer set search_path = public as $$
declare
  r public.fish;
begin
  if not exists (select 1 from public.species where id = p_species and enabled) then
    raise exception 'Especie desconocida: %', p_species;
  end if;
  insert into public.fish (species) values (p_species) returning * into r;
  return r;
end $$;

-- ¿Hay una fila esperando este archivo? (la usa la política de Storage)
create or replace function public.fish_pending(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.fish where filename = p_name and not uploaded)
$$;

-- Marca el PNG como subido y lo activa al instante; si se pasa el cupo, salen los visitantes más antiguos.
create or replace function public.mark_uploaded(p_id bigint) returns public.fish
language plpgsql security definer set search_path = public as $$
declare
  r public.fish;
  c public.aquarium_config;
  v_show boolean;
begin
  select * into r from public.fish where id = p_id;
  if r.id is null then
    raise exception 'No existe el pez %', p_id;
  end if;
  if r.uploaded then
    return r;
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'fish' and name = r.filename) then
    raise exception 'Falta subir % a Storage', r.filename;
  end if;

  select * into c from public.aquarium_config;
  v_show := c.visitors_enabled and r.species <> 'test';

  update public.fish set
    uploaded = true,
    active = v_show,
    activated_at = case when v_show then now() end,
    times_shown = times_shown + v_show::int
  where id = p_id
  returning * into r;

  if v_show then
    update public.fish set active = false
    where id in (
      select id from public.fish
      where active and not permanent
      order by activated_at desc nulls last, id desc
      offset c.max_visitors
    );
  end if;
  return r;
end $$;

-- Rotación (pg_cron cada 2 h): salen rotate_count visitantes y entran los menos vistos hasta llenar el cupo.
create or replace function public.rotate_fish() returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.aquarium_config;
  v_off bigint[];
  v_active integer;
begin
  select * into c from public.aquarium_config;
  if not c.visitors_enabled then
    update public.fish set active = false where active and not permanent;
    return;
  end if;

  with off as (
    update public.fish set active = false
    where id in (
      select id from public.fish
      where active and not permanent
      order by activated_at nulls first, id
      limit c.rotate_count
    )
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_off from off;

  select count(*) into v_active from public.fish where active and not permanent;

  -- Los que acaban de salir quedan últimos en la fila, así no vuelven enseguida.
  update public.fish set active = true, activated_at = now(), times_shown = times_shown + 1
  where id in (
    select id from public.fish
    where not active and not permanent and uploaded and species <> 'test'
    order by id = any (v_off), times_shown, random()
    limit greatest(c.max_visitors - v_active, 0)
  );
end $$;

-- Permisos del cliente (anon) -------------------------------------------------
revoke all on public.aquarium_fish from anon, authenticated;
grant select on public.aquarium_fish to anon, authenticated;

revoke all on function public.rotate_fish() from public, anon, authenticated;
revoke all on function public.fish_set_filename() from public, anon, authenticated;
-- Escribir exige sesión del operador (supabase/auth.sql): anon solo lee el acuario.
revoke all on function public.create_fish(text) from public, anon;
revoke all on function public.mark_uploaded(bigint) from public, anon;
revoke all on function public.fish_pending(text) from public, anon;
grant execute on function public.create_fish(text) to authenticated;
grant execute on function public.mark_uploaded(bigint) to authenticated;
grant execute on function public.fish_pending(text) to authenticated;

-- Storage: bucket público para leer; subir exige sesión y una fila esperando ese archivo --
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fish', 'fish', true, 5242880, array['image/png'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "fish: subir escaneos" on storage.objects;
create policy "fish: subir escaneos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'fish' and public.fish_pending(name));

-- Rotación cada 2 h (horas pares UTC = impares en Argentina) -------------------
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('rotate-fish', '0 */2 * * *', $$select public.rotate_fish()$$);

-- Útil:
--   update aquarium_config set max_visitors = 20;          -- cambiar el cupo
--   update aquarium_config set visitors_enabled = false;   -- dejar solo los peces permanentes
--   update fish set permanent = true where id in (1, 2);   -- marcar peces del equipo
--   select rotate_fish();                                   -- rotar ahora
--   select * from cron.job_run_details order by start_time desc limit 5;
