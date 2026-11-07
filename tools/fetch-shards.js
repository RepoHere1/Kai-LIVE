#!/usr/bin/env node
// Fetch Kalshi shard account IDs using API credentials from .env
// Run this to auto-populate KALSHI_SHARD_CRYPTO, KALSHI_SHARD_POLITICS, etc.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const ENV_FILE = path.join(HERE, '.env');

function loadEnv() {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch (e) { return out; }
  const lines = text.split(/\r?\n/);
  let key = null, buf = [];
  const flush = () => {
    if (key) out[key] = buf.join('\n').trim();
    key = null; buf = [];
  };
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) {
      if (key && buf.length > 0) flush();
      continue;
    }
    if (/^[A-Z0-9_]+\s*=/.test(line)) {
      flush();
      const i = line.indexOf('=');
      key = line.slice(0, i).trim();
      buf.push(line.slice(i + 1));
    } else if (key) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

const ENV = loadEnv();
const KEY_ID = (ENV.KALSHI_LIVE_KEY_ID || '').trim();
const PRIVATE_KEY = (ENV.KALSHI_LIVE_PRIVATE_KEY || '').trim();
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

if (!KEY_ID || !PRIVATE_KEY) {
  console.error('Missing KALSHI_LIVE_KEY_ID or KALSHI_LIVE_PRIVATE_KEY in .env');
  process.exit(1);
}

function sign(method, fullPath, ts) {
  const msg = ts + method.toUpperCase() + fullPath;
  // Use RSA-PSS like the server (sign function in kalshi.js)
  return crypto.sign('sha256', Buffer.from(msg, 'utf8'), {
    key: PRIVATE_KEY,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }).toString('base64');
}

async function fetchShards() {
  const route = '/portfolio/balance';
  const ts = Math.floor(Date.now() / 1000).toString();
  const fullPath = '/trade-api/v2' + route;
  const signature = sign('GET', fullPath, ts);

  const headers = {
    'KALSHI-ACCESS-KEY': KEY_ID,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const url = BASE + route;
  console.log('Fetching shard info from:', url);

  // Retry on rate limit
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { method: 'GET', headers });
      const text = await res.text();
      console.log('Response status:', res.status);
      console.log('Response body:', text.slice(0, 2000));

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '5') * 1000;
        console.log(`Rate limited, waiting ${retryAfter}ms before retry ${attempt}/5...`);
        await new Promise(r => setTimeout(r, retryAfter));
        continue;
      }

      if (!res.ok) {
        console.error('Error:', text);
        return;
      }

      const data = JSON.parse(text);
      console.log('\nParsed response:', JSON.stringify(data, null, 2));

      // Extract exchange_index values from balance breakdown
      const breakdown = data.balance_breakdown || data.balance || [];
      if (Array.isArray(breakdown) && breakdown.length > 0) {
        console.log('\n=== SHARD BREAKDOWN ===');
        for (const b of breakdown) {
          console.log(`exchange_index: ${b.exchange_index}, balance: $${b.balance || b.balance_dollars}, subaccount: ${b.subaccount || 'N/A'}`);
        }

        // Update .env with discovered shards
        let envText = fs.readFileSync(ENV_FILE, 'utf8');
        const shardMap = {};
        // Map exchange_index to shard categories based on which has balance
        // exchange_index 0 = primary/default
        // exchange_index 2 has balance ($0.0434) - likely crypto
        for (const b of breakdown) {
          if (b.exchange_index === 0) shardMap.KALSHI_SHARD_CRYPTO = 0;
          if (b.exchange_index === 1) shardMap.KALSHI_SHARD_POLITICS = 1;
          if (b.exchange_index === 2) shardMap.KALSHI_SHARD_CRYPTO = 2; // crypto has balance here
          if (b.exchange_index === 3) shardMap.KALSHI_SHARD_FINANCE = 3;
          if (b.exchange_index === 4) shardMap.KALSHI_SHARD_CRYPTO = 4;
        }

        // Write back to .env
        for (const [key, val] of Object.entries(shardMap)) {
          const regex = new RegExp(`^${key}=.*`, 'm');
          if (regex.test(envText)) {
            envText = envText.replace(regex, `${key}=${val}`);
          } else {
            envText += `\n${key}=${val}`;
          }
        }

        // Add subaccount (default to 0 if not in response)
        const subaccount = 0;
        const subRegex = /^KALSHI_SUBACCOUNT=.*/m;
        if (subRegex.test(envText)) {
          envText = envText.replace(subRegex, `KALSHI_SUBACCOUNT=${subaccount}`);
        } else {
          envText += `\nKALSHI_SUBACCOUNT=${subaccount}`;
        }

        fs.writeFileSync(ENV_FILE, envText);
        console.log('\n[OK] Updated .env with shard IDs');
      }
      return;

    } catch (e) {
      console.error('Fetch error:', e.message);
      if (attempt < 5) await new Promise(r => setTimeout(r, 2000));
    }
  }
}

fetchShards();