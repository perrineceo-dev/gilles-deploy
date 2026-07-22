// netlify/functions/link-acces.js
//
// Appelée par l'app juste après une connexion réussie (login ou signup).
// Le webhook Systeme.io (activer-acces.js) crée la ligne "abonnements" AVANT
// que la cliente ait un compte Supabase Auth — il lui donne donc un user_id
// provisoire (aléatoire). Cette fonction recolle les morceaux : elle retrouve
// la ligne par email et met à jour uniquement son user_id pour qu'il
// corresponde au vrai auth.uid() de la cliente connectée.
//
// Sans cette étape, tout ce qui dépend de "abonnements.user_id" côté client
// (crédits restants, crédits bonus, quota mensuel, date de renouvellement)
// ne retrouve jamais la ligne créée au moment du paiement.
//
// Appel : POST /.netlify/functions/link-acces  body: { email, user_id }
// Réponse : { "linked": true } ou { "linked": false, "reason": "..." }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const email = (payload.email || '').toLowerCase().trim();
  const userId = (payload.user_id || '').trim();

  if (!email || !userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email and user_id required' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[link-acces] Variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes');
    return { statusCode: 500, body: JSON.stringify({ error: 'server misconfigured' }) };
  }

  try {
    // --- Sécurité : on vérifie que le user_id fourni correspond bien à un
    // compte Supabase Auth dont l'email est le même que celui fourni, pour
    // éviter qu'un appel malveillant ne détourne l'abonnement d'un autre email.
    const authCheck = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!authCheck.ok) {
      return { statusCode: 403, body: JSON.stringify({ linked: false, reason: 'unknown user_id' }) };
    }
    const authUser = await authCheck.json();
    const authEmail = (authUser && authUser.email || '').toLowerCase().trim();
    if (authEmail !== email) {
      return { statusCode: 403, body: JSON.stringify({ linked: false, reason: 'email mismatch' }) };
    }

    // --- Retrouve la ligne existante par email ---
    const getUrl = `${SUPABASE_URL}/rest/v1/abonnements?email=eq.${encodeURIComponent(email)}&select=user_id`;
    const getRes = await fetch(getUrl, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!getRes.ok) {
      const errText = await getRes.text();
      console.error('[link-acces] Erreur lecture Supabase', getRes.status, errText);
      return { statusCode: 500, body: JSON.stringify({ linked: false, reason: 'supabase read error' }) };
    }
    const rows = await getRes.json();

    if (!rows.length) {
      // Pas de ligne d'abonnement pour cet email : rien à relier.
      return { statusCode: 200, body: JSON.stringify({ linked: false, reason: 'no subscription row' }) };
    }

    if (rows[0].user_id === userId) {
      // Déjà à jour, rien à faire.
      return { statusCode: 200, body: JSON.stringify({ linked: true, alreadyLinked: true }) };
    }

    // --- Met à jour uniquement user_id, sans toucher au statut / crédits ---
    const updRes = await fetch(`${SUPABASE_URL}/rest/v1/abonnements?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ user_id: userId }),
    });

    if (!updRes.ok) {
      const errText = await updRes.text();
      console.error('[link-acces] Erreur écriture Supabase', updRes.status, errText);
      return { statusCode: 500, body: JSON.stringify({ linked: false, reason: 'supabase write error' }) };
    }

    console.log(`[link-acces] OK — ${email} relié à user_id=${userId}`);
    return { statusCode: 200, body: JSON.stringify({ linked: true }) };
  } catch (e) {
    console.error('[link-acces] Exception', e);
    return { statusCode: 500, body: JSON.stringify({ linked: false, reason: 'internal error' }) };
  }
};
