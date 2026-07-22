// netlify/functions/ai.mjs
//
// Routeur IA de Chrono Insta Pro — VERSION STREAMING (Netlify Functions v2).
//
// POURQUOI CE CHANGEMENT : les fonctions Netlify classiques sont coupées par la
// passerelle vers ~26-30 s, quelle que soit la config. Toutes les générations un
// peu longues finissaient en 504. En STREAMING, la réponse commence à partir dès
// les premières secondes → la passerelle est satisfaite, et la génération peut
// durer aussi longtemps que nécessaire. C'est le correctif structurel définitif.
//
// L'app appelle : POST /.netlify/functions/ai
//   body : { task:'premium'|'eco', max_tokens, web_search, messages:[{role, content}] }
//   header : Authorization: Bearer <jeton de session Supabase>  (obligatoire)
//
// Réponse : texte brut streamé (Content-Type: text/plain).
//   Le client accumule les morceaux et reconstruit le texte complet.

const PREMIUM_MODEL = 'claude-haiku-4-5-20251001'; // rapide + économique
const ECO_MODEL     = 'mistral-small-latest';

const MAX_TOKENS_CAP = 6000;
// Tant que tous les comptes réels n'ont pas leur ligne "abonnements",
// on tolère les comptes connectés sans ligne (loggé). Passer à false
// une fois la base propre pour un verrouillage complet.
const ALLOW_NO_SUBSCRIPTION_ROW = true;

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  // ── SÉCURITÉ : jeton de session Supabase obligatoire ──
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authHeader = req.headers.get('authorization') || '';
  const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!userToken) return json({ error: 'auth required' }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[ai] Variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes');
    return json({ error: 'server misconfigured' }, 500);
  }
  try {
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${userToken}` },
    });
    if (!uRes.ok) return json({ error: 'invalid session' }, 401);
    const u = await uRes.json();
    const userEmail = ((u && u.email) || '').toLowerCase().trim();
    if (!userEmail) return json({ error: 'invalid session' }, 401);

    const aRes = await fetch(`${SUPABASE_URL}/rest/v1/abonnements?email=eq.${encodeURIComponent(userEmail)}&select=statut`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (aRes.ok) {
      const rows = await aRes.json();
      if (Array.isArray(rows) && rows.length) {
        if (rows[0].statut !== 'actif') return json({ error: 'subscription inactive' }, 403);
      } else if (!ALLOW_NO_SUBSCRIPTION_ROW) {
        return json({ error: 'no subscription' }, 403);
      } else {
        console.warn('[ai] Compte connecté sans ligne abonnements (toléré) :', userEmail);
      }
    }
  } catch (authErr) {
    console.error('[ai] Erreur vérification auth', authErr);
    return json({ error: 'auth check failed' }, 401);
  }

  let payload;
  try { payload = await req.json(); }
  catch (e) { return json({ error: 'invalid json' }, 400); }

  const task = payload.task === 'eco' ? 'eco' : 'premium';
  const maxTokens = Math.min(
    (typeof payload.max_tokens === 'number' && payload.max_tokens > 0) ? payload.max_tokens : 4000,
    MAX_TOKENS_CAP
  );
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const useWebSearch = payload.web_search === true;
  if (!messages.length) return json({ error: 'messages required' }, 400);

  try {
    if (task === 'eco') return await callMistral(messages, maxTokens);
    return await streamAnthropic(messages, maxTokens, useWebSearch);
  } catch (e) {
    console.error('[ai] Exception', e);
    return json({ error: 'internal error' }, 500);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────
// PREMIUM — Claude en STREAMING (plus aucun timeout possible)
// ─────────────────────────────────────────────────────────────
async function streamAnthropic(messages, maxTokens, useWebSearch) {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    console.error('[ai] ANTHROPIC_API_KEY manquante');
    return json({ error: 'server misconfigured (anthropic)' }, 500);
  }

  // Prompt caching : le début stable du 1er message (profil/voix) est marqué
  // en cache pour réduire fortement le coût des générations répétées.
  const anthMessages = messages.map((m, idx) => {
    const content = typeof m.content === 'string' ? m.content : '';
    if (idx === 0 && content.length > 1500) {
      const cut = Math.max(0, content.length - 1200);
      const stable = content.slice(0, cut);
      const variable = content.slice(cut);
      const blocks = [];
      if (stable) blocks.push({ type: 'text', text: stable, cache_control: { type: 'ephemeral' } });
      blocks.push({ type: 'text', text: variable });
      return { role: m.role || 'user', content: blocks };
    }
    return { role: m.role || 'user', content: content };
  });

  const body = {
    model: PREMIUM_MODEL,
    max_tokens: maxTokens,
    stream: true,
    messages: anthMessages,
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }];
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[ai/anthropic] Erreur', res.status, errText);
    return json({ error: 'anthropic error', detail: errText.slice(0, 300) }, res.status);
  }

  // On transforme le flux SSE d'Anthropic en texte brut : seuls les morceaux
  // de texte (content_block_delta / text_delta) sont transmis au client.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = '';

  const textStream = new TransformStream({
    transform(chunk, controller) {
      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop(); // dernière ligne possiblement incomplète
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const ev = JSON.parse(raw);
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
            controller.enqueue(encoder.encode(ev.delta.text));
          }
        } catch (e) { /* fragment non-JSON : ignoré */ }
      }
    },
  });

  res.body.pipeTo(textStream.writable).catch((e) => {
    console.error('[ai/anthropic] Erreur de flux', e);
  });

  return new Response(textStream.readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Ai-Stream': '1',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// ECO — Mistral Small (réponses rapides, pas besoin de streaming)
// ─────────────────────────────────────────────────────────────
async function callMistral(messages, maxTokens) {
  const API_KEY = process.env.MISTRAL_API_KEY;
  if (!API_KEY) {
    console.warn('[ai] MISTRAL_API_KEY absente → fallback premium (Claude, streaming)');
    return await streamAnthropic(messages, maxTokens, false);
  }

  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: ECO_MODEL,
      max_tokens: maxTokens,
      messages: messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[ai/mistral] Erreur', res.status, errText);
    return json({ error: 'mistral error', detail: errText.slice(0, 300) }, res.status);
  }

  const data = await res.json();
  const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  // Format "Anthropic-like" JSON : le client sait le lire (mode non-streamé)
  return json({ content: [{ type: 'text', text: text }] }, 200);
}
