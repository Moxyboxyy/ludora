-- Ludora-Freundschaften + Ludora-Online-Status
-- Einmal im SQL-Editor ausführen (nach schema.sql). Kann gefahrlos mehrfach ausgeführt werden.

-- Zuletzt online (Ludora meldet sich jede Minute kurz)
alter table public.profiles add column if not exists last_seen timestamptz;

create table if not exists public.friendships (
  requester uuid not null references public.profiles (id) on delete cascade,
  addressee uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);
-- Nur eine Freundschaft pro Paar (egal wer gefragt hat)
create unique index if not exists friendships_pair on public.friendships (least(requester, addressee), greatest(requester, addressee));

alter table public.friendships enable row level security;
drop policy if exists "eigene freundschaften lesen" on public.friendships;
create policy "eigene freundschaften lesen" on public.friendships for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());
drop policy if exists "freundschaft beenden" on public.friendships;
create policy "freundschaft beenden" on public.friendships for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());
-- Anlegen und Annehmen nur über die Funktionen unten

-- Anfrage per Ludora-Name senden. Hat der andere mich schon angefragt -> sofort befreundet.
create or replace function public.friend_request(target_username text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  them uuid;
  existing public.friendships;
begin
  if me is null then raise exception 'Nicht angemeldet'; end if;
  select id into them from public.profiles where username = lower(trim(target_username));
  if them is null then return 'not_found'; end if;
  if them = me then return 'self'; end if;
  select * into existing from public.friendships
    where (requester = me and addressee = them) or (requester = them and addressee = me);
  if found then
    if existing.status = 'accepted' then return 'already_friends'; end if;
    if existing.requester = them then
      update public.friendships set status = 'accepted' where requester = them and addressee = me;
      return 'accepted';
    end if;
    return 'already_requested';
  end if;
  insert into public.friendships (requester, addressee) values (me, them);
  return 'requested';
end;
$$;

-- Anfrage annehmen
create or replace function public.friend_accept(from_username text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  them uuid;
begin
  select id into them from public.profiles where username = lower(trim(from_username));
  update public.friendships set status = 'accepted'
    where requester = them and addressee = me and status = 'pending';
  return found;
end;
$$;

-- Ablehnen / zurückziehen / Freundschaft beenden
create or replace function public.friend_remove(other_username text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  them uuid;
begin
  select id into them from public.profiles where username = lower(trim(other_username));
  delete from public.friendships
    where (requester = me and addressee = them) or (requester = them and addressee = me);
  return found;
end;
$$;

-- "Ich bin online" (jede Minute)
create or replace function public.heartbeat()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set last_seen = now() where id = auth.uid();
$$;

-- Meine Ludora-Freunde + offene Anfragen, mit den verknüpften Konten der Freunde
create or replace function public.my_friends()
returns table (
  username text, display_name text, relation text, last_seen timestamptz, accounts jsonb
)
language sql
security definer
set search_path = public
as $$
  with mine as (
    select f.*, case when f.requester = auth.uid() then f.addressee else f.requester end as other
    from public.friendships f
    where auth.uid() is not null and (f.requester = auth.uid() or f.addressee = auth.uid())
  )
  select p.username, p.display_name,
         case when m.status = 'accepted' then 'friend'
              when m.requester = auth.uid() then 'outgoing'
              else 'incoming' end as relation,
         case when m.status = 'accepted' then p.last_seen end as last_seen,
         case when m.status = 'accepted' then coalesce((
           select jsonb_agg(jsonb_build_object('launcher', la.launcher, 'account_id', la.account_id,
                                               'account_name', la.account_name, 'verified', la.verified)
                            order by la.launcher)
           from public.linked_accounts la where la.user_id = p.id), '[]'::jsonb)
         else '[]'::jsonb end as accounts
  from mine m join public.profiles p on p.id = m.other;
$$;

revoke all on function public.friend_request(text), public.friend_accept(text), public.friend_remove(text),
  public.heartbeat(), public.my_friends() from public, anon;
grant execute on function public.friend_request(text), public.friend_accept(text), public.friend_remove(text),
  public.heartbeat(), public.my_friends() to authenticated;
