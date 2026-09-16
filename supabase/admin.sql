-- Panel /admin: listar y borrar escaneos.
-- La clave viaja como argumento de la función, así que sin ella no se puede listar ni borrar, aunque alguien
-- tenga la anon key. Pegar en el SQL Editor o correr con psql; se puede ejecutar varias veces.

create or replace function public.admin_list_fish(p_key text)
returns table (id bigint, species text, filename text, created_at timestamptz, permanent boolean, active boolean)
language plpgsql security definer set search_path = public as $$
begin
  if p_key is distinct from '***' then
    raise exception 'Clave incorrecta';
  end if;
  return query
    select f.id, f.species, f.filename, f.created_at, f.permanent, f.active
    from public.fish f
    where f.uploaded
    order by f.id desc;
end $$;

-- Borra la fila: el pez desaparece del acuario en la próxima sincronización.
-- El PNG queda en Storage, porque Supabase no permite borrarlo por SQL (haría falta la service key).
create or replace function public.admin_delete_fish(p_id bigint, p_key text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_key is distinct from '***' then
    raise exception 'Clave incorrecta';
  end if;
  delete from public.fish where id = p_id;
  return found;
end $$;

revoke all on function public.admin_list_fish(text) from public;
revoke all on function public.admin_delete_fish(bigint, text) from public;
grant execute on function public.admin_list_fish(text) to anon, authenticated;
grant execute on function public.admin_delete_fish(bigint, text) to anon, authenticated;
