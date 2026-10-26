'use strict';
// Kilo AI Gateway client (OpenAI-compatible). Real LLM calls for the analysis
// features. The account has no credits, so only free-tier models work: the
// chain below tries the requested model, the configured model, then the known
// free ids, and treats an empty completion as a failed attempt.
const { ENV } = require('./kalshi');

const usageLog = [];

function bases() {
  const list = [ENV.KILO_BASE_URL, ENV.KILO_BASE_URL_FALLBACK].filter(Boolean);
  return list.length ? list : ['https://ai-gateway.kilo.ai/api/v1', 'https://api.kilo.ai/api/gateway'];
}

function modelChain(requested) {
  const chain = [];
  const push = m => { if (m && chain.indexOf(m) === -1) chain.push(m); };
  push(requested);
  push(ENV.KILO_MODEL);
  if (ENV.KILO_MODEL_FALLBACKS) String(ENV.KILO_MODEL_FALLBACKS).split(',').forEach(s => push(s.trim()));
  push('kilo-auto/free');
  push('openrouter/free');
  push('nvidia/nemotron-3.5-lightning:free');
  push('liquid/lfm-2.5-2.6b:free');
  return chain;
}

async function chatOnce(base, model, body) {
  const url = base.replace(/\/+$/, '') + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (ENV.KILO_TOKEN || '') },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' :: ' + text.slice(0, 180));
  let j = null;
  try { j = JSON.parse(text); } catch (e) { throw new Error('bad json from ' + base); }
  const choice = (j.choices && j.choices[0]) || {};
  const msg = choice.message || {};
  const content = msg.content || msg.reasoning || '';
  return { j, content, model: j.model || model };
}

async function chat(messages, opts) {
  opts = opts || {};
  const chain = modelChain(opts.model);
  const attempts = [];
  let lastErr = null;
  for (const base of bases()) {
    for (const model of chain) {
      const body = { model, messages, max_tokens: opts.max_tokens || 700 };
      if (opts.temperature != null) body.temperature = opts.temperature;
      const started = Date.now();
      try {
        const out = await chatOnce(base, model, body);
        if (!String(out.content || '').trim()) {
          attempts.push(model + ' @ ' + base.replace('https://', '') + ': empty completion');
          continue;
        }
        const u = out.j.usage || {};
        const rec = {
          at: new Date().toISOString(),
          strategy: opts.strategy || 'analysis',
          query_type: opts.query_type || 'recommendations',
          model: out.model, requested: model, base,
          calls: 1, tokens: u.total_tokens || 0,
          prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0,
          cost: 0, ms: Date.now() - started,
        };
        usageLog.push(rec);
        if (usageLog.length > 500) usageLog.shift();
        return { text: out.content, usage: u, model: out.model, requested: model, base, ms: rec.ms, raw: out.j, attempts };
      } catch (e) {
        lastErr = e;
        attempts.push(model + ' @ ' + base.replace('https://', '') + ': ' + (e.message || e));
      }
    }
  }
  const err = lastErr || new Error('kilo: every free model failed');
  err.attempts = attempts;
  throw err;
}

function usage() {
  const consumers = new Map();
  let tokens = 0, calls = 0;
  for (const r of usageLog) {
    calls += 1; tokens += r.tokens || 0;
    const key = r.strategy + '|' + r.query_type;
    const cur = consumers.get(key) || { strategy: r.strategy, query_type: r.query_type, calls: 0, tokens: 0, cost: 0, last_at: '' };
    cur.calls += 1;
    cur.tokens += r.tokens || 0;
    cur.last_at = r.at;
    consumers.set(key, cur);
  }
  return {
    total_calls: calls,
    total_tokens: tokens,
    total_cost: 0,
    model: ENV.KILO_MODEL || 'kilo-auto/free',
    consumers: Array.from(consumers.values()),
  };
}

module.exports = { chat, usage, modelChain, bases };
