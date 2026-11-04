-- Ludora: Test-Profile anlegen (im Supabase SQL Editor ausführen)
--
--   testdummy   -> mit dir befreundet, "online in Ludora", 4 erfundene verknüpfte Konten
--   testanfrage -> schickt dir eine Freundschaftsanfrage
-- Beide können sich auch anmelden: Passwort test1234
--
-- Dein Ludora-Name steht unten bei "owner" – bei Bedarf anpassen.

do $$
declare
  me uuid;
  d1 uuid;
  d2 uuid;
  owner text := 'dein-name';   -- <<< DEIN Ludora-Name (klein geschrieben)
begin
  select id into me from public.profiles where username = owner;
  if me is null then raise exception 'Ludora-Konto "%" nicht gefunden – Namen oben anpassen', owner; end if;

  -- Alte Test-Profile vorher entfernen (falls das Skript schon einmal lief)
  delete from auth.users where email in ('testdummy@gamehub.local', 'testanfrage@gamehub.local');

  -- Anmelde-Konten (Supabase Auth) mit Passwort test1234
  d1 := gen_random_uuid();
  d2 := gen_random_uuid();
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values
    ('00000000-0000-0000-0000-000000000000', d1, 'authenticated', 'authenticated', 'testdummy@gamehub.local',
     extensions.crypt('test1234', extensions.gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{}', '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', d2, 'authenticated', 'authenticated', 'testanfrage@gamehub.local',
     extensions.crypt('test1234', extensions.gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{}', '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
  values
    (gen_random_uuid(), d1, d1::text, jsonb_build_object('sub', d1::text, 'email', 'testdummy@gamehub.local'), 'email', now(), now(), now()),
    (gen_random_uuid(), d2, d2::text, jsonb_build_object('sub', d2::text, 'email', 'testanfrage@gamehub.local'), 'email', now(), now(), now());

  -- Ludora-Profile; TestDummy gilt einen Tag lang als "online"
  insert into public.profiles (id, username, display_name, last_seen) values
    (d1, 'testdummy', 'TestDummy', now() + interval '1 day'),
    (d2, 'testanfrage', 'TestAnfrage', null);

  -- Erfundene verknüpfte Konten von TestDummy
  insert into public.linked_accounts (launcher, account_id, user_id, account_name, verified) values
    ('steam', '76561190000000001', d1, 'TestDummy', true),
    ('riot', '00000000-test-dumm-y000-000000000001', d1, 'TestDummy#EUW', false),
    ('epic', 'testdummy-epic-0001', d1, 'TestDummyTTV', true),
    ('gog', '40000000000000001', d1, 'testdummy_gog', true);

  -- Freundschaften: TestDummy = befreundet, TestAnfrage = offene Anfrage an dich
  insert into public.friendships (requester, addressee, status) values
    (d1, me, 'accepted'),
    (d2, me, 'pending');
end $$;

-- Wieder entfernen (alles, was dazugehört, verschwindet automatisch mit):
-- delete from auth.users where email in ('testdummy@gamehub.local', 'testanfrage@gamehub.local');
