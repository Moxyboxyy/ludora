-- Ludora-Server (Supabase) – einmal im SQL-Editor des Projekts ausführen.
--
-- profiles         Ludora-Konten (Name wie "alex")
-- linked_accounts  Welche Launcher-Konten zu welchem Ludora-Konto gehören
--                  (geschrieben nur von der Prüf-Funktion "link" – nie direkt von der App)
-- lookup_accounts  Nachschlagen: "Zu welchem Ludora-Konto gehören diese Steam-/Riot-/…-Konten?"
--                  Man bekommt nur Antworten zu Konten, nach denen man konkret fragt.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_.-]{3,24}$'),
  display_name text not null check (char_length(display_name) between 3 and 24),
  created_at timestamptz not null default now()
);

create table if not exists public.linked_accounts (
  launcher text not null check (launcher in ('steam', 'riot', 'epic', 'gog')),
  account_id text not null check (char_length(account_id) between 1 and 120),
  user_id uuid not null references public.profiles (id) on delete cascade,
  account_name text,
  verified boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (launcher, account_id)
);
create index if not exists linked_accounts_user on public.linked_accounts (user_id);

alter table public.profiles enable row level security;
alter table public.linked_accounts enable row level security;

-- Profile: eigenes anlegen/ändern, angemeldete Nutzer dürfen Namen lesen
drop policy if exists "profiles lesen" on public.profiles;
create policy "profiles lesen" on public.profiles for select to authenticated using (true);
drop policy if exists "eigenes profil anlegen" on public.profiles;
create policy "eigenes profil anlegen" on public.profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists "eigenes profil ändern" on public.profiles;
create policy "eigenes profil ändern" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Verknüpfte Konten: nur die eigenen sehen und löschen; schreiben nur über die Prüf-Funktion
drop policy if exists "eigene verknüpfungen lesen" on public.linked_accounts;
create policy "eigene verknüpfungen lesen" on public.linked_accounts for select to authenticated using (user_id = auth.uid());
drop policy if exists "eigene verknüpfungen löschen" on public.linked_accounts;
create policy "eigene verknüpfungen löschen" on public.linked_accounts for delete to authenticated using (user_id = auth.uid());

-- Nachschlagen für die Freundesliste: höchstens 1000 Konten pro Anfrage
create or replace function public.lookup_accounts(items jsonb)
returns table (launcher text, account_id text, username text, display_name text, verified boolean)
language sql
security definer
set search_path = public
as $$
  select la.launcher, la.account_id, p.username, p.display_name, la.verified
  from jsonb_to_recordset(case when jsonb_array_length(items) <= 1000 then items else '[]'::jsonb end)
       as q(launcher text, account_id text)
  join public.linked_accounts la on la.launcher = q.launcher and la.account_id = q.account_id
  join public.profiles p on p.id = la.user_id
  where auth.uid() is not null;
$$;
revoke all on function public.lookup_accounts(jsonb) from public, anon;
grant execute on function public.lookup_accounts(jsonb) to authenticated;
