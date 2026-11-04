-- Ludora: Sicherheits-Update (zu Version 0.7)
-- Einmal im SQL-Editor ausführen (nach schema.sql, 02–04). Kann gefahrlos mehrfach ausgeführt werden.

-- 1) Profile sind nicht mehr für alle lesbar.
--    Vorher konnte jeder angemeldete Nutzer alle Ludora-Namen und deren Online-Zeiten (last_seen) abrufen.
--    Jetzt liest man nur das eigene Profil; Freunde, Anfragen und das Nachschlagen laufen über die
--    Server-Funktionen (my_friends, friend_request, lookup_accounts), die nur das Nötige herausgeben.
drop policy if exists "profiles lesen" on public.profiles;
drop policy if exists "eigenes profil lesen" on public.profiles;
create policy "eigenes profil lesen" on public.profiles for select to authenticated using (id = auth.uid());

-- 2) Am eigenen Profil darf die App nur Anzeigename und Online-Zeit ändern (nicht den Ludora-Namen,
--    der für Anmeldung und Verschlüsselung gebraucht wird).
revoke insert, update on public.profiles from authenticated;
grant insert (id, username, display_name) on public.profiles to authenticated;
grant update (display_name, last_seen) on public.profiles to authenticated;

-- 3) Nicht angemeldete Besucher (öffentlicher Schlüssel) kommen an keine Tabelle heran.
revoke all on public.profiles, public.linked_accounts, public.friendships from anon;
do $$ begin
  if to_regclass('public.vaults') is not null then execute 'revoke all on public.vaults from anon'; end if;
end $$;

-- 4) Unbestätigte Riot-Verknüpfungen: höchstens eine pro Ludora-Konto
--    (die Prüf-Funktion ersetzt die alte; aufräumen, falls schon mehrere da sind – die neueste bleibt).
delete from public.linked_accounts la
using public.linked_accounts newer
where la.launcher = 'riot' and newer.launcher = 'riot' and not la.verified and not newer.verified
  and la.user_id = newer.user_id and newer.updated_at > la.updated_at;
