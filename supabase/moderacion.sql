-- Moderación de los escaneos públicos: cada dibujo pasa por supabase/functions/subir-pez antes de mostrarse.
-- Se puede ejecutar varias veces (psql o SQL Editor) sin romper nada.

-- Temas y personas de la actualidad a evitar. Los de 'noticias' los carga todos los días
-- supabase/functions/actualizar-temas a partir de los titulares; los 'manual' se agregan a mano.
create table if not exists public.temas_sensibles (
  tema    text primary key,
  detalle text,
  fuente  text not null default 'manual' check (fuente in ('manual', 'noticias')),
  visto   timestamptz not null default now()  -- última vez que apareció en las noticias
);

-- Personas de la universidad (docentes, autoridades, personal): un dibujo que las nombre va a revisión.
create table if not exists public.personas_de_la_casa (
  nombre text primary key,
  rol    text
);

-- Subidas recientes por IP, para limitar cuántos peces puede mandar un mismo teléfono.
create table if not exists public.subidas (
  ip     text not null,
  creado timestamptz not null default now()
);
create index if not exists subidas_ip_idx on public.subidas (ip, creado);

-- Sin políticas: solo las funciones del servidor (con la service key) leen y escriben estas tablas.
alter table public.temas_sensibles enable row level security;
alter table public.personas_de_la_casa enable row level security;
alter table public.subidas enable row level security;

-- Tareas diarias ---------------------------------------------------------------
-- Temas de actualidad, todos los días a las 9 de Argentina (12 UTC). El secreto vive en Vault, no en el repo:
--   select vault.create_secret('<secreto>', 'cron_temas');   -- y el mismo valor como CRON_SECRET de la función
create extension if not exists pg_net;
select cron.schedule('actualizar-temas', '0 12 * * *', $$
  select net.http_post(
    url := 'https://wbttxomiprissilzcihz.supabase.co/functions/v1/actualizar-temas',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_temas')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000)
$$);

-- El registro de subidas solo sirve para el límite: se limpia a diario.
select cron.schedule('limpiar-subidas', '30 12 * * *', $$
  delete from public.subidas where creado < now() - interval '1 day'
$$);

-- Interruptor del escáner público ----------------------------------------------
-- Apagado: el escáner pide la clave del equipo y la función subir-pez solo acepta operadores.
-- Encendido: cualquiera escanea con su teléfono (todo pasa igual por la moderación con IA).
alter table public.aquarium_config add column if not exists escaner_publico boolean not null default false;

create or replace function public.escaner_publico() returns boolean
language sql stable security definer set search_path = public as $$
  select escaner_publico from public.aquarium_config
$$;
grant execute on function public.escaner_publico() to anon, authenticated;

create or replace function public.admin_set_escaner_publico(p_publico boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_operator('admin') then
    raise exception 'Sin permiso';
  end if;
  update public.aquarium_config set escaner_publico = p_publico where id;  -- la API rechaza UPDATE sin WHERE
  return p_publico;
end $$;
revoke all on function public.admin_set_escaner_publico(boolean) from public, anon;
grant execute on function public.admin_set_escaner_publico(boolean) to authenticated;
