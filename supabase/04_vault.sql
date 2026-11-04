-- Ludora: Anmeldungen auf andere Geräte mitnehmen (Ende-zu-Ende-verschlüsselt)
-- Einmal im SQL-Editor ausführen (nach schema.sql, 02_friends.sql, 03_delete_account.sql).
--
-- Pro Ludora-Konto eine Zeile mit einem verschlüsselten Block. Verschlüsselt wird in der App mit einem
-- Schlüssel aus deinem Passwort – der Server (und wer ihn betreibt) kann den Inhalt nicht lesen.
-- Wird das Konto gelöscht, verschwindet die Zeile automatisch mit (on delete cascade).
create table if not exists public.vaults (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  data text not null check (length(data) < 200000),
  updated_at timestamptz not null default now()
);

alter table public.vaults enable row level security;

drop policy if exists "vault: nur eigene Zeile lesen" on public.vaults;
drop policy if exists "vault: nur eigene Zeile anlegen" on public.vaults;
drop policy if exists "vault: nur eigene Zeile ändern" on public.vaults;
drop policy if exists "vault: nur eigene Zeile löschen" on public.vaults;
create policy "vault: nur eigene Zeile lesen" on public.vaults for select to authenticated using (user_id = auth.uid());
create policy "vault: nur eigene Zeile anlegen" on public.vaults for insert to authenticated with check (user_id = auth.uid());
create policy "vault: nur eigene Zeile ändern" on public.vaults for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "vault: nur eigene Zeile löschen" on public.vaults for delete to authenticated using (user_id = auth.uid());

revoke all on public.vaults from anon;
grant select, insert, update, delete on public.vaults to authenticated;
