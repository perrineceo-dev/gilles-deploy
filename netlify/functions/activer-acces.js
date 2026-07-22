// netlify/functions/activer-acces.js
//
// Appelée directement par une automatisation Systeme.io ("Appeler un webhook")
// après une vente. Vérifie un token secret passé en paramètre d'URL, puis lit
// l'email du client dans le payload envoyé par Systeme.io et active l'accès
// dans Supabase.
//
// URL utilisée par Systeme.io :
//   https://chronoinstapro.com/.netlify/functions/activer-acces?token=gs5fzss5dfr3klezxcy42f4s
//
// Variables d'environnement Netlify nécessaires (déjà présentes normalement) :
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ACTIVER_ACCES_TOKEN  (le token attendu — à créer, valeur : gs5fzss5dfr3klezxcy42f4s)

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // --- 1. Vérification du token ---
  const providedToken = (event.queryStringParameters && event.queryStringParameters.token) || '';
  const expectedToken = process.env.ACTIVER_ACCES_TOKEN || '';
  if (!expectedToken || providedToken !== expectedToken) {
    console.warn('[activer-acces] Token invalide ou manquant');
    return { statusCode: 403, body: 'Forbidden' };
  }

  // --- 2. Parsing du payload envoyé par Systeme.io ---
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('[activer-acces] JSON invalide', e);
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  console.log('[activer-acces] Payload reçu:', JSON.stringify(payload));

  // Formats possibles selon la config Systeme.io (New sale / Sale cancelled / structure custom)
  const email =
    payload?.data?.customer?.email ||
    payload?.data?.contact?.email ||
    payload?.customer?.email ||
    payload?.contact?.email ||
    payload?.email ||
    null;

  if (!email) {
    console.error('[activer-acces] Aucun email trouvé dans le payload');
    return { statusCode: 400, body: 'No email found in payload' };
  }

  const type = payload.type || '';
  const isCancellation = type.includes('cancel') || type.includes('refund');
  const statut = isCancellation ? 'inactif' : 'actif';

  // --- 3. Upsert dans Supabase (table abonnements, clé = email) ---
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[activer-acces] Variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes');
    return { statusCode: 500, body: 'Server misconfigured' };
  }

  try {
    // On regarde d'abord si une ligne existe déjà pour cet email, pour ne
    // JAMAIS écraser un user_id déjà relié à un vrai compte Supabase Auth
    // (ce qui arriverait à chaque renouvellement si on faisait un upsert
    // qui renvoie systématiquement un nouveau user_id aléatoire).
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/abonnements?email=eq.${encodeURIComponent(email.toLowerCase().trim())}&select=user_id`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!getRes.ok) {
      const errText = await getRes.text();
      console.error('[activer-acces] Erreur lecture Supabase', getRes.status, errText);
      return { statusCode: 500, body: 'Supabase error: ' + errText };
    }
    const existingRows = await getRes.json();

    let res;
    if (existingRows.length) {
      // Ligne déjà existante : on met à jour uniquement le statut, jamais le user_id
      // (il sera/est déjà relié au vrai compte via link-acces.js au login).
      res = await fetch(
        `${SUPABASE_URL}/rest/v1/abonnements?email=eq.${encodeURIComponent(email.toLowerCase().trim())}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            Prefer: 'return=representation',
          },
          body: JSON.stringify({
            statut,
            updated_at: new Date().toISOString(),
            last_event_type: type || 'systeme_io_automation',
          }),
        }
      );
    } else {
      // Nouvelle ligne (achat avant tout compte créé) : user_id provisoire,
      // relié au vrai compte plus tard par link-acces.js au premier login.
      res = await fetch(`${SUPABASE_URL}/rest/v1/abonnements`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify([
          {
            email: email.toLowerCase().trim(),
            user_id: crypto.randomUUID(),
            statut,
            updated_at: new Date().toISOString(),
            last_event_type: type || 'systeme_io_automation',
          },
        ]),
      });
    }

    if (!res.ok) {
      const errText = await res.text();
      console.error('[activer-acces] Erreur Supabase', res.status, errText);
      return { statusCode: 500, body: 'Supabase error: ' + errText };
    }

    console.log(`[activer-acces] OK — ${email} -> statut = ${statut}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, email, statut }) };
  } catch (e) {
    console.error('[activer-acces] Exception', e);
    return { statusCode: 500, body: 'Internal error' };
  }
};
