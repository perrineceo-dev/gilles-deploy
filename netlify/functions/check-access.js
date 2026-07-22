// netlify/functions/check-access.js
//
// Appelée par l'app (index.html) juste après connexion pour savoir si l'abonnement
// de l'utilisateur est actif. Passe par le service_role côté serveur pour éviter
// tout souci de règles RLS Supabase côté client.
//
// Appel : GET /.netlify/functions/check-access?email=xxx@yyy.com
// Réponse : { "active": true } ou { "active": false }

exports.handler = async (event) => {
  const email = (event.queryStringParameters && event.queryStringParameters.email || '')
    .toLowerCase()
    .trim();

  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email required' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[check-access] Variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes');
    return { statusCode: 500, body: JSON.stringify({ error: 'server misconfigured' }) };
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/abonnements?email=eq.${encodeURIComponent(email)}&select=statut`;
    const res = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[check-access] Erreur Supabase', res.status, errText);
      return { statusCode: 500, body: JSON.stringify({ error: 'supabase error' }) };
    }

    const rows = await res.json();
    const active = Array.isArray(rows) && rows.length > 0 && rows[0].statut === 'actif';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    };
  } catch (e) {
    console.error('[check-access] Exception', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'internal error' }) };
  }
};
