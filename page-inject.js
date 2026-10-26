// Kai-Mirror page injector.
// Runs inside the dashboard page alongside the app script. It adds ONLY what the
// served markup was missing and wires real-data panels - it never fabricates data.
// Every number it renders comes from the local server, which in turn reads the
// Kalshi live API (demo only as fallback) and Coinbase spot.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var currentView = 'dry'; // Track which view is active

  // ---------------------------------------------------------------------
  // 1. file:// guard - /api/* only exists on the local server
  // ---------------------------------------------------------------------
  if (location.protocol === 'file:') {
    var url = 'http://127.0.0.1:8787/';
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0b0f14;color:#e6edf6;'
      + 'font:600 15px/1.6 system-ui,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;padding:40px';
    bar.innerHTML = '<div><div style="font-size:22px;margin-bottom:10px">Kai-Mirror needs its data server</div>'
      + '<div style="color:#8fa3bd;font-weight:400">This page now renders <b style="color:#2ee6a8">real Kalshi + Coinbase data</b>, '
      + 'so it must be opened through the local server (the browser refuses cross-origin file:// API calls).</div>'
      + '<div style="margin:18px 0"><a href="' + url + '" style="color:#000;background:#2ee6a8;padding:10px 16px;border-radius:6px;text-decoration:none">Open ' + url + '</a></div>'
      + '<div style="color:#5b6a80;font-weight:400;font-size:13px">Start it with: <code style="color:#e6edf6">node server.js</code> in C:\\Users\\darri\\Kai-Mirror</div></div>';
    document.body.appendChild(bar);
    return;
  }

  // ---------------------------------------------------------------------
  // 2. DOM repairs: ids the app writes that the served markup lacks
  // ---------------------------------------------------------------------
  if (!$('feedNote')) {
    var anchor = $('feedsPanel') || document.body;
    var fn = document.createElement('div');
    fn.id = 'feedNote';
    fn.className = 'note';
    fn.style.cssText = 'padding:6px 10px;color:#8fa3bd;font-size:12px';
    fn.textContent = 'waiting for feeds...';
    anchor.insertBefore(fn, anchor.firstChild ? anchor.firstChild.nextSibling : null);
  }
  if (!$('posBody')) {
    var host0 = document.querySelector('main') || document.body;
    var panel = document.createElement('section');
    panel.className = 'panel';
    panel.style.cssText = 'margin:14px 0';
    panel.innerHTML = '<div class="ph"><h2>OPEN POSITIONS</h2>'
      + '<span class="note">rows written by the dashboard from /api/snapshot - real Kalshi market ids</span></div>'
      + '<div class="pb"><div class="scroll"><table><thead><tr>'
      + '<th>Market</th><th>Title</th><th>Side</th><th class="num">Entry</th><th class="num">Qty</th>'
      + '<th>Strategy</th><th class="num">Stop</th><th class="num">Target</th>'
      + '</tr></thead><tbody id="posBody"></tbody></table></div></div>';
    host0.appendChild(panel);
  }
  if (!$('dAvailTile')) {
    var dep = $('dDepTile');
    if (dep && dep.parentNode) {
      var host = dep.parentNode;
      var wrap = document.createElement('div');
      wrap.innerHTML = '<b class="v" id="dAvailTile">-</b><span>dry status</span>';
      host.appendChild(wrap.firstChild);
    }
  }

  // ---------------------------------------------------------------------
  // 3. filter helpers the ALL NO filter box calls
  // ---------------------------------------------------------------------
  var noRows = [];
  window.filterRows = function (inputId, bodyId) {
    var q = ($(inputId) && $(inputId).value || '').toLowerCase();
    var body = $(bodyId || 'noBody');
    if (!body) return;
    var all = Array.prototype.slice.call(body.querySelectorAll('tr'));
    var shown = 0;
    all.forEach(function (tr) {
      if (tr.querySelector('.empty')) return;
      var text = (tr.getAttribute('data-text') || tr.textContent || '').toLowerCase();
      var hit = !q || text.indexOf(q) !== -1;
      tr.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    return shown;
  };
  window.clearFilter = function (inputId, bodyId) {
    var i = $(inputId); if (i) i.value = '';
    return window.filterRows(inputId, bodyId);
  };

  // ---------------------------------------------------------------------
  // 4. ALL NO MARKETS - real NO-side quotes from the local server
  // ---------------------------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(v) { return v == null ? '-' : '$' + Number(v).toFixed(2); }
  function num3(v) { return v == null ? '-' : Number(v).toFixed(3); }

  function renderNoBook() {
    fetch('/api/no-lanes/book').then(function (r) { return r.json(); }).then(function (d) {
      noRows = d.rows || [];
      var body = $('noBody');
      if (!body) return;
      if (!noRows.length) {
        body.innerHTML = '<tr><td colspan="17" class="empty">No NO-side quotes returned by Kalshi right now.</td></tr>';
        return;
      }
      body.innerHTML = noRows.map(function (r) {
        var cells = [
          '<td class="mono" title="' + esc(r.id) + '">' + esc(String(r.id).slice(0, 18)) + '</td>',
          '<td>' + esc(r.market) + '</td>',
          '<td><span class="tag">' + esc(r.strategy) + '</span></td>',
          '<td><span class="tag">NO</span></td>',
          '<td class="num">' + num3(r.limit_entry) + '</td>',
          '<td class="num">' + (r.qty == null ? '-' : r.qty) + '</td>',
          '<td class="num">' + money(r.cost) + '</td>',
          '<td class="num">' + num3(r.fair) + '</td>',
          '<td class="num ' + (r.edge > 0 ? 'up' : (r.edge < 0 ? 'down' : 'flat')) + '">' + num3(r.edge) + '</td>',
          '<td class="num">' + num3(r.kelly) + '</td>',
          '<td class="num">' + num3(r.stop) + '</td>',
          '<td class="num">' + num3(r.take_profit) + '</td>',
          '<td class="num">' + (r.confidence == null ? '-' : r.confidence) + '</td>',
          '<td class="mono">' + esc(String(r.expiration || '').slice(0, 16)) + '</td>',
          '<td>' + esc(r.status) + '</td>',
          '<td>' + esc(String(r.book || '').toUpperCase()) + '</td>',
          '<td class="mono">' + esc(r.opened || '') + '</td>',
        ];
        var text = [r.id, r.market, r.strategy].join(' ');
        return '<tr data-text="' + esc(text) + '">' + cells.join('') + '</tr>';
      }).join('');
      var f = $('noFilter');
      if (f && f.value) window.filterRows('noFilter', 'noBody');
    }).catch(function (e) {
      var body = $('noBody');
      if (body) body.innerHTML = '<tr><td colspan="17" class="empty">ALL NO feed error: ' + esc(e.message) + '</td></tr>';
    });
  }

  // ---------------------------------------------------------------------
  // 5. PROOF panel - shows the real source behind every headline number
  // ---------------------------------------------------------------------
  function proofPanel() {
    var el = $('kaiProof');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'kaiProof';
    el.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:9000;max-width:360px;background:#0d1219;border:1px solid #223041;'
      + 'border-radius:8px;padding:10px 12px;font:11.5px/1.5 ui-monospace,Consolas,monospace;color:#9fb1c7;box-shadow:0 8px 28px rgba(0,0,0,.5)';
    document.body.appendChild(el);
    return el;
  }
  function paintProof() {
    var el = proofPanel();
    fetch('/api/provenance').then(function (r) { return r.json(); }).then(function (d) {
      var p = d.provenance || {};
      var k = p.kalshi || {}, s = p.spot || {}, l = p.llm || {};
      el.innerHTML =
        '<div style="color:#2ee6a8;font-weight:700;margin-bottom:4px">REAL DATA PROOF <span style="color:#5b6a80" id="kaiProofClose">[hide]</span></div>'
        + '<div>kalshi : <b style="color:#e6edf6">' + esc(k.source || '?') + '</b> ' + esc(String(k.host || '').replace('https://', '').slice(0, 34)) + '</div>'
        + '<div>series : ' + esc(k.series || '') + ' Â· ' + (k.latency_ms == null ? '-' : k.latency_ms + 'ms') + ' Â· ' + esc(String(k.fetched_at || '').slice(11, 19)) + 'Z</div>'
        + '<div>key id : <b style="color:#e6edf6">' + esc(String(k.key_id || '').slice(0, 18)) + '</b></div>'
        + '<div>spot   : <b style="color:#e6edf6">' + esc(s.product || '') + '</b> ' + (s.price == null ? '-' : '$' + Number(s.price).toLocaleString()) + ' Â· ' + esc(String(s.at || '').slice(11, 19)) + 'Z</div>'
        + '<div>source : ' + esc(s.source || '') + '</div>'
        + '<div>llm    : ' + esc(l.provider || '') + ' Â· ' + esc(l.model || '') + '</div>'
        + '<div style="color:#f5c542;margin-top:4px">' + esc(p.dry_execution || '') + '</div>'
        + '<div style="margin-top:4px"><a href="/api/provenance" target="_blank" style="color:#4d9fff;text-decoration:none">raw /api/provenance</a>'
        + ' &middot; <a href="/api/snapshot" target="_blank" style="color:#4d9fff;text-decoration:none">/api/snapshot</a></div>';
      var close = $('kaiProofClose');
      if (close) close.onclick = function () { el.style.display = 'none'; window.__kaiProofHidden = true; };
    }).catch(function (e) {
      el.innerHTML = '<div style="color:#ff5555">proof panel error: ' + esc(e.message) + '</div>';
    });
  }

  // ---------------------------------------------------------------------
  // 6. keep the live feed list honest: surface the server's own event lines
  // ---------------------------------------------------------------------
  function paintModeStrip() {
    var el = $('kaiModeStrip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'kaiModeStrip';
      el.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:9000;background:#0d1219;border:1px solid #223041;border-radius:8px;padding:8px 12px;font:11.5px/1.5 ui-monospace,Consolas,monospace;color:#9fb1c7';
      document.body.appendChild(el);
    }
    fetch('/api/health').then(function (r) { return r.json(); }).then(function (d) {
      el.innerHTML = '<b style="color:' + (d.mode === 'live' ? '#ff5555' : '#2ee6a8') + '">' + String(d.mode).toUpperCase() + '</b>'
        + ' Â· dry cash <b style="color:#e6edf6">$' + Number(d.dry_balance || 0).toFixed(2) + '</b>'
        + '<div style="color:#5b6a80">live ' + esc(String(d.hosts.kalshi_live).replace('https://', '')) + '</div>'
        + '<div style="color:#5b6a80">demo ' + esc(String(d.hosts.kalshi_demo).replace('https://', '')) + ' (fallback)</div>';
    }).catch(function () { });
  }

  setInterval(renderNoBook, 3000);
  setInterval(paintProof, 5000);
  setInterval(paintModeStrip, 4000);
  renderNoBook();
  paintProof();
  paintModeStrip();
})();

