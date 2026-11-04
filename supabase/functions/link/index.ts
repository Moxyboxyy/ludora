// Ludora – Prüf-Funktion "link" (Supabase Edge Function)
//
// Verknüpft ein Launcher-Konto mit dem angemeldeten Ludora-Konto. Damit sich niemand als
// jemand anderes ausgeben kann, schickt Ludora das Anmelde-Token des Launchers mit; diese
// Funktion fragt damit beim Anbieter nach, wem das Konto gehört:
//   Steam  -> Token gültig? (Steam-Web-API), Konto = "sub" im Token
//   Epic   -> account-public-service .../oauth/verify
//   GOG    -> embed.gog.com/userData.json
//   Riot   -> nicht prüfbar (Riot gibt Ludora nur lokale Daten) -> "nicht bestätigt"
// Das Token wird nur für diese Prüfung benutzt und nirgends gespeichert.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

function jwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
  } catch {
    return {};
  }
}

type Proof = { account_id: string; account_name: string | null; verified: boolean };

async function verify(launcher: string, token: string, claim: Record<string, unknown>): Promise<Proof> {
  if (launcher === 'steam') {
    const sub = String(jwtPayload(token).sub || '');
    if (!/^\d{17}$/.test(sub)) throw new Error('Steam-Token ungültig');
    const r = await fetch(`https://api.steampowered.com/IFriendsListService/GetFriendsList/v1/?access_token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`Steam lehnt das Token ab (${r.status})`);
    return { account_id: sub, account_name: claim?.name ? String(claim.name).slice(0, 64) : null, verified: true };
  }
  if (launcher === 'epic') {
    const r = await fetch('https://account-public-service-prod.ol.epicgames.com/account/api/oauth/verify', {
      headers: { authorization: `bearer ${token}` }
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.account_id) throw new Error('Epic lehnt das Token ab');
    return { account_id: String(j.account_id), account_name: j.displayName || null, verified: true };
  }
  if (launcher === 'gog') {
    const r = await fetch('https://embed.gog.com/userData.json', { headers: { authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.userId) throw new Error('GOG lehnt das Token ab');
    return { account_id: String(j.userId), account_name: j.username || null, verified: true };
  }
  if (launcher === 'riot') {
    const puuid = String(claim?.puuid || '');
    if (!/^[0-9a-f-]{20,80}$/i.test(puuid)) throw new Error('Riot-Konto fehlt');
    const name = claim?.game_name ? `${claim.game_name}${claim.game_tag ? '#' + claim.game_tag : ''}` : null;
    return { account_id: puuid, account_name: name ? String(name).slice(0, 64) : null, verified: false };
  }
  throw new Error('Unbekannter Launcher');
}

/** Schlüssel aus den Umgebungsvariablen – alte (anon/service_role) und neue (publishable/secret) Projekte */
function envKey(legacy: string, modernList: string): string | undefined {
  const v = Deno.env.get(legacy);
  if (v) return v;
  const raw = Deno.env.get(modernList);
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw);
    if (typeof j === 'string') return j;
    if (Array.isArray(j)) return j[0];
    return (j.default as string) || (Object.values(j)[0] as string);
  } catch {
    return raw;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Nur POST' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const publicKey = req.headers.get('apikey') || envKey('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS') || '';
  const service = envKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');
  if (!service) return json({ error: 'Server: Kein Secret-/Service-Schlüssel in der Funktion verfügbar' }, 500);

  // Wer fragt? Ludora-Anmeldung direkt beim Auth-Dienst prüfen
  // (funktioniert mit alten und neuen JWT-Signaturschlüsseln; "Verify JWT" der Funktion kann aus sein)
  const authHeader = req.headers.get('Authorization') || '';
  const who = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: publicKey } });
  const user = who.ok ? await who.json().catch(() => null) : null;
  if (!user?.id) return json({ error: `Nicht bei Ludora angemeldet (${who.status})` }, 401);

  let body: { launcher?: string; token?: string; claim?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: 'Ungültige Anfrage' }, 400); }
  const launcher = String(body.launcher || '');

  let proof: Proof;
  try {
    proof = await verify(launcher, String(body.token || ''), body.claim || {});
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: profile, error: pErr } = await admin.from('profiles').select('id').eq('id', user.id).maybeSingle();
  if (pErr) return json({ error: `Server: ${pErr.message}` }, 500);
  if (!profile) return json({ error: 'Ludora-Profil fehlt' }, 400);

  // Gehört das Konto schon jemand anderem? Bestätigte Verknüpfungen werden nur durch einen
  // neuen Nachweis ersetzt (das Token beweist ja, wem das Konto jetzt gehört).
  const { data: existing } = await admin.from('linked_accounts')
    .select('user_id, verified').eq('launcher', launcher).eq('account_id', proof.account_id).maybeSingle();
  if (existing && existing.user_id !== user.id && existing.verified && !proof.verified) {
    return json({ error: 'Dieses Konto ist bereits mit einem anderen Ludora-Konto bestätigt verknüpft.' }, 409);
  }

  const { error } = await admin.from('linked_accounts').upsert({
    launcher,
    account_id: proof.account_id,
    user_id: user.id,
    account_name: proof.account_name,
    verified: proof.verified,
    updated_at: new Date().toISOString()
  });
  if (error) return json({ error: `Server: ${error.message}` }, 500);
  return json({ ok: true, launcher, account_id: proof.account_id, account_name: proof.account_name, verified: proof.verified });
});
