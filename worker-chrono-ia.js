// ═══════════════════════════════════════════════════════════════
// CHRONO INSTA PRO — Worker IA (Cloudflare)
// Remplace /.netlify/functions/ai — SANS limite de streaming.
//
// DÉPLOIEMENT (10 min) :
// 1. dash.cloudflare.com → Workers & Pages → Create → Worker
//    Nom : chrono-ia  → Deploy → puis "Edit code" → colle TOUT ce fichier → Deploy
// 2. Worker → Settings → Variables and Secrets → ajoute 3 secrets :
//      ANTHROPIC_API_KEY          (ta clé Anthropic)
//      SUPABASE_URL               (ex: https://xxxx.supabase.co)
//      SUPABASE_SERVICE_ROLE_KEY  (clé service_role Supabase)
//    (optionnel : MISTRAL_API_KEY pour le mode éco)
// 3. Déploie le index.html v50 sur Netlify. C'est tout.
//
// L'app appelle : POST https://chrono-ia.chassap29.workers.dev/
//   body : { task, max_tokens, web_search, messages }
//   header : Authorization: Bearer <jeton session Supabase>
// ═══════════════════════════════════════════════════════════════

const PREMIUM_MODEL = 'claude-haiku-4-5-20251001';
const ECO_MODEL = 'mistral-small-latest';
const MAX_TOKENS_CAP = 6000;
const ALLOW_NO_SUBSCRIPTION_ROW = true;

// CORS : l'app (domaine Netlify) appelle un autre domaine (workers.dev)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405);
    }

    // ── SÉCURITÉ : jeton de session Supabase obligatoire ──
    const SUPABASE_URL = env.SUPABASE_URL;
    const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    const authHeader = req.headers.get('authorization') || '';
    const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!userToken) return json({ error: 'auth required' }, 401);
    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error('[ai] Secrets SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants');
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
          console.warn('[ai] Compte sans ligne abonnements (toléré) :', userEmail);
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
      if (task === 'eco') return await callMistral(env, messages, maxTokens);
      return await streamAnthropic(env, messages, maxTokens, useWebSearch);
    } catch (e) {
      console.error('[ai] Exception', e);
      return json({ error: 'internal error' }, 500);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ─────────────────────────────────────────────────────────────
// PREMIUM — Claude en STREAMING (aucune limite de durée ici)
// ─────────────────────────────────────────────────────────────
async function streamAnthropic(env, messages, maxTokens, useWebSearch) {
  const API_KEY = env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    console.error('[ai] Secret ANTHROPIC_API_KEY manquant');
    return json({ error: 'server misconfigured (anthropic)' }, 500);
  }

  // Prompt caching : le début stable du 1er message est marqué en cache
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

  // Flux SSE Anthropic → texte brut : seuls les morceaux text_delta passent
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = '';

  const textStream = new TransformStream({
    transform(chunk, controller) {
      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();
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
      ...CORS,
    },
  });
}

// ─────────────────────────────────────────────────────────────
// ECO — Mistral Small
// ─────────────────────────────────────────────────────────────
async function callMistral(env, messages, maxTokens) {
  const API_KEY = env.MISTRAL_API_KEY;
  if (!API_KEY) {
    console.warn('[ai] MISTRAL_API_KEY absente → fallback premium (Claude, streaming)');
    return await streamAnthropic(env, messages, maxTokens, false);
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
  return json({ content: [{ type: 'text', text: text }] }, 200);
}
