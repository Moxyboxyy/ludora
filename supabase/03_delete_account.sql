-- Ludora: eigenes Konto löschen (Knopf in der App)
-- Einmal im SQL-Editor ausführen (nach schema.sql und 02_friends.sql).
-- Löscht das Anmelde-Konto; Profil, verknüpfte Konten und Freundschaften verschwinden automatisch mit
-- (on delete cascade).
create or replace function public.delete_my_account()
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Nicht angemeldet'; end if;
  delete from auth.users where id = me;
  return found;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
