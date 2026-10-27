'use strict';
// ===========================================================================
// KAI-LIVE MONITOR — OPERATOR OVERRIDE
// Purpose: Know the operator's last button push for every lane, forever.
// If a lane the operator turned ON turns off for ANY reason, FIX why and turn it back ON.
// Self-aware: knows it runs in LIVE folder (port 8788).
// If it cannot obey the operator's last button push, it COMMITS SUICIDE (exits).
// ===========================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const STATE_FILE = path.join(HERE, 'state.json');
const PORT = 8788;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const CHECK_INTERVAL_MS = 5000; // 5 seconds
const MAX_CONSECUTIVE_FAILURES = 3;

const LANES = [
  'btc_updown', 'eth_updown', 'xrp_updown',
  'btc_1h_updown', 'eth_1h_updown', 'xrp_1h_updown',
  'hyperliquid_updown', 'hyperliquid_1h_updown'
];

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[MONITOR:LIVE] ${ts} ${msg}`);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    log(`FATAL: Cannot read state.json: ${e.message}`);
    process.exit(1); // SUICIDE
  }
}

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${endpoint}`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000
    }, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(responseData) }); } catch (e) { resolve({ status: res.statusCode, body: responseData }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

async function checkHealth() {
  try {
    const health = await apiGet('/api/health');
    if (!health.ok || health.mode !== 'live') {
      log(`HEALTH CHECK FAILED: ${JSON.stringify(health)}`);
      return false;
    }
    return true;
  } catch (e) {
    log(`HEALTH CHECK ERROR: ${e.message}`);
    return false;
  }
}

async function getServerLaneStates() {
  try {
    const snapshot = await apiGet('/api/strategies');
    const states = {};
    // /api/strategies returns { laneName: { running, ... }, ... }
    for (const [laneName, laneData] of Object.entries(snapshot || {})) {
      states[laneName] = { running: laneData.running, last_tick: laneData.last_tick };
    }
    return states;
  } catch (e) {
    log(`GET LANE STATES ERROR: ${e.message}`);
    return null;
  }
}

async function enforceLane(laneName, desiredRunning) {
  const endpoint = `/api/strategy/${laneName}/toggle`;
  try {
    const result = await apiPost(endpoint, { running: desiredRunning });
    if (result.status === 200 && result.body.running === desiredRunning) {
      log(`ENFORCED: ${laneName} -> ${desiredRunning ? 'ON' : 'OFF'} (server confirmed)`);
      return true;
    } else {
      log(`ENFORCE FAILED: ${laneName} desired=${desiredRunning} got status=${result.status} body=${JSON.stringify(result.body)}`);
      return false;
    }
  } catch (e) {
    log(`ENFORCE ERROR: ${laneName} ${e.message}`);
    return false;
  }
}

async function monitorLoop() {
  const state = readState();
  const persistedLanes = state.lanes || {};
  let consecutiveFailures = 0;

  log(`MONITOR STARTED — defending operator's last button push on ${LANES.length} lanes`);
  log(`Persisted lane states: ${JSON.stringify(Object.fromEntries(Object.entries(persistedLanes).map(([k,v])=>[k,v.running]))) || '{}'}`);

  while (true) {
    // Self-awareness check: verify we're in LIVE folder
    if (!fs.existsSync(path.join(HERE, 'server.js')) || !fs.existsSync(STATE_FILE)) {
      log('SUICIDE: Not in LIVE folder or state.json missing');
      process.exit(1);
    }

    const healthy = await checkHealth();
    if (!healthy) {
      consecutiveFailures++;
      log(`Server unhealthy (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log('SUICIDE: Server unreachable after max failures');
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
      continue;
    }
    consecutiveFailures = 0;

    const serverStates = await getServerLaneStates();
    if (!serverStates) {
      await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
      continue;
    }

    // For each lane: if operator's last push was ON but server says OFF, enforce ON
    for (const laneName of LANES) {
      const persisted = persistedLanes[laneName];
      const server = serverStates[laneName];

      if (!persisted) continue; // Lane not in state yet

      const operatorWantsOn = persisted.running === true;
      const serverIsOn = server?.running === true;

      if (operatorWantsOn && !serverIsOn) {
        log(`DRIFT DETECTED: ${laneName} operator=ON server=OFF — enforcing ON`);
        const ok = await enforceLane(laneName, true);
        if (!ok) {
          log(`SUICIDE: Failed to enforce ${laneName} ON`);
          process.exit(1);
        }
        // Update local persisted state immediately (save() is debounced)
        persistedLanes[laneName] = { ...persistedLanes[laneName], running: true, heartbeat: new Date().toISOString() };
      } else if (!operatorWantsOn && serverIsOn) {
        log(`DRIFT DETECTED: ${laneName} operator=OFF server=ON — enforcing OFF`);
        const ok = await enforceLane(laneName, false);
        if (!ok) {
          log(`SUICIDE: Failed to enforce ${laneName} OFF`);
          process.exit(1);
        }
        // Update local persisted state immediately
        persistedLanes[laneName] = { ...persistedLanes[laneName], running: false, stop_reason: 'operator stop', heartbeat: new Date().toISOString() };
      }
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => { log('Received SIGINT — monitor stopping'); process.exit(0); });
process.on('SIGTERM', () => { log('Received SIGTERM — monitor stopping'); process.exit(0); });

// Start
log('=== KAI-LIVE MONITOR BOOT ===');
log(`Folder: ${HERE}`);
log(`State file: ${STATE_FILE}`);
log(`Target server: ${BASE_URL}`);
monitorLoop().catch(e => {
  log(`FATAL ERROR: ${e.stack}`);
  process.exit(1);
});