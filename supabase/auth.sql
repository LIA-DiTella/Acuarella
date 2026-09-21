-- Sesión del operador y cierre de la base.
-- Antes cualquiera que leyera config.js podía crear filas y subir PNG con la publishable key, y la clave del
-- panel estaba escrita en el JS. Ahora escribir exige un token de Supabase Auth, que solo se consigue con la
-- contraseña del equipo. El acuario sigue siendo anónimo: es la pantalla pública.
-- Se puede ejecutar varias veces (psql o SQL Editor) sin romper nada.

-- 1. Escribir deja de estar permitido para anónimos ---------------------------
revoke execute on function public.create_fish(text) from anon;
revoke execute on function public.mark_uploaded(bigint) from anon;
revoke execute on function public.fish_pending(text) from anon;
grant execute on function public.create_fish(text) to authenticated;
grant execute on function public.mark_uploaded(bigint) to authenticated;
grant execute on function public.fish_pending(text) to authenticated;

-- Subir a Storage también exige sesión (antes era `to anon, authenticated`).
drop policy if exists "fish: subir escaneos" on storage.objects;
create policy "fish: subir escaneos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'fish' and public.fish_pending(name));

-- 2. Panel: sin clave como argumento, con sesión obligatoria -------------------
-- La versión vieja recibía la clave en texto y la comparaba adentro; se reemplaza por completo.
drop function if exists public.admin_list_fish(text);
drop function if exists public.admin_delete_fish(bigint, text);

create or replace function public.admin_list_fish()
returns table (id bigint, species text, filename text, created_at timestamptz, permanent boolean, active boolean)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'authenticated' then
    raise exception 'Hace falta iniciar sesión';
  end if;
  return query
    select f.id, f.species, f.filename, f.created_at, f.permanent, f.active
    from public.fish f
    where f.uploaded
    order by f.id desc;
end $$;

-- Borra la fila: el pez desaparece del acuario en la próxima sincronización.
-- El PNG queda en Storage, porque Supabase no permite borrarlo por SQL (haría falta la service key).
create or replace function public.admin_delete_fish(p_id bigint)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'authenticated' then
    raise exception 'Hace falta iniciar sesión';
  end if;
  delete from public.fish where id = p_id;
  return found;
end $$;

revoke all on function public.admin_list_fish() from public, anon;
revoke all on function public.admin_delete_fish(bigint) from public, anon;
grant execute on function public.admin_list_fish() to authenticated;
grant execute on function public.admin_delete_fish(bigint) to authenticated;

-- 3. La cuenta del operador ---------------------------------------------------
-- Se crea una sola vez con este bloque. La contraseña se guarda hasheada con bcrypt: no queda en claro ni
-- en la base ni en el repo. Para cambiarla:
--   update auth.users set encrypted_password = extensions.crypt('la-nueva', extensions.gen_salt('bf'))
--   where email = 'labo@acuarella.app';
--
-- insert into auth.users (
--   instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
--   created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
--   confirmation_token, recovery_token, email_change_token_new, email_change_token_current,
--   email_change, phone_change, phone_change_token, reauthentication_token
-- ) values (
--   '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
--   'labo@acuarella.app', extensions.crypt('la-clave', extensions.gen_salt('bf')), now(),
--   now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
--   '', '', '', '', '', '', '', ''
-- );
-- Las ocho columnas de token van en '' y no en null: GoTrue las lee como texto y con null falla el login.
