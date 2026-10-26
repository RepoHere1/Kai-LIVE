'use strict';
const { ENV } = require('./kalshi');
const bases = ['https://ai-gateway.kilo.ai/api/v1', 'https://api.kilo.ai/api/gateway'];
const models = ['auto/free', 'z-ai/glm-4.5-air:free', 'openai/gpt-oss-20b:free', 'deepseek/deepseek-chat-v3-0324:free', 'google/gemini-2.0-flash-exp:free', 'meta-llama/llama-3.3-70b-instruct:free'];

async function tryModel(base, model) {
  const started = Date.now();
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ENV.KILO_TOKEN },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'say OK' }], max_tokens: 8 }),
    });
    const t = await r.text();
    return { base, model, status: r.status, ms: Date.now() - started, body: t.slice(0, 200).replace(/\s+/g, ' ') };
  } catch (e) {
    return { base, model, status: 'ERR', body: e.message, ms: Date.now() - started };
  }
}

(async () => {
  for (const base of bases) {
    try {
      const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + ENV.KILO_TOKEN } });
      const t = await r.text();
      let ids = [];
      try { const j = JSON.parse(t); ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean); } catch (e) {}
      console.log('MODELS', base, 'HTTP', r.status, 'count', ids.length);
      const free = ids.filter(id => /free|auto/i.test(id));
      console.log('  free-ish:', JSON.stringify(free.slice(0, 25)));
    } catch (e) { console.log('MODELS', base, 'ERR', e.message); }
  }
  console.log('--- chat attempts ---');
  for (const base of bases) {
    for (const model of models) {
      const r = await tryModel(base, model);
      console.log(r.status, r.model, r.ms + 'ms', '|', r.base.replace('https://', ''), '|', r.body);
    }
  }
})();
