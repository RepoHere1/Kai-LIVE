'use strict';
// Loads the SERVED dashboard (http://127.0.0.1:8787/) in jsdom and asserts the
// page works with real data: app script compiled, panels rendered, ALL NO rows
// filled from the live API, provenance panel populated, zero console errors.
const { JSDOM, VirtualConsole } = require('jsdom');
const URL_ = 'http://127.0.0.1:8787/';

function stubCanvas(canvas) {
  const noop = () => {};
  const base = {
    canvas,
    measureText: t => ({ width: (t ? String(t).length : 0) * 6 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getLineDash: () => [],
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  };
  ['save','restore','beginPath','closePath','moveTo','lineTo','arc','arcTo','ellipse','rect','stroke','fill','clip',
   'fillRect','strokeRect','clearRect','fillText','strokeText','setTransform','resetTransform','translate','scale',
   'rotate','transform','bezierCurveTo','quadraticCurveTo','drawImage','roundRect'].forEach(k => { base[k] = noop; });
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

const problems = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => problems.push('jsdomError: ' + (e && e.message)));
vc.on('error', (...a) => problems.push('console.error: ' + a.map(String).join(' ').slice(0, 200)));
vc.on('warn', (...a) => { const s = a.map(String).join(' '); if (!/ResizeObserver|not implemented/i.test(s)) problems.push('console.warn: ' + s.slice(0, 200)); });

(async () => {
  const html = await fetch(URL_).then(r => r.text());
  check('server serves the built page', html.length > 500000, html.length + ' bytes');
  check('page has the injected real-data wiring', html.indexOf('kaiProof') !== -1 && html.indexOf('no-lanes/book') !== -1);
  check('page has NO mock backend', html.indexOf('local mirror has no handler') === -1);

  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: URL_,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = function () { return stubCanvas(this); };
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.fetch = (input, init) => fetch(new URL(String(input), URL_).toString(), init);
      w.EventSource = class {
        constructor() { setTimeout(() => this.onopen && this.onopen(), 50); }
        addEventListener() {} removeEventListener() {}
        close() {}
      };
    },
  });
  const w = dom.window;
  const $ = id => w.document.getElementById(id);

  await new Promise(r => setTimeout(r, 9000));

  check('app script compiled (paint exists)', typeof w.paint === 'function');
  check('ALL NO panel present', !!w.document.querySelector('.all-no-panel'));
  check('#noBody exists', !!$('noBody'));
  check('#posBody exists', !!$('posBody'));
  check('#feedNote exists', !!$('feedNote'));
  check('filter helpers defined', typeof w.filterRows === 'function' && typeof w.clearFilter === 'function');
  check('body in DRY mode', w.document.body.dataset.mode === 'dry', w.document.body.dataset.mode);

  const noRows = $('noBody') ? $('noBody').querySelectorAll('tr').length : 0;
  check('ALL NO filled with real rows', noRows > 1, noRows + ' rows');
  if (noRows > 1) {
    const first = $('noBody').querySelector('tr');
    const cells = first.querySelectorAll('td');
    check('ALL NO row has all 17 columns', cells.length === 17, cells.length + ' cells');
    console.log('   first NO row:', Array.from(cells).map(c => c.textContent.trim()).join(' | '));
  }

  const proof = $('kaiProof');
  check('provenance panel rendered', !!proof && /api\.elections\.kalshi\.com/.test(proof.textContent), proof ? proof.textContent.replace(/\s+/g, ' ').slice(0, 150) : 'missing');
  const strip = $('kaiModeStrip');
  check('mode/source strip rendered', !!strip && /api\.elections\.kalshi\.com/.test(strip.textContent), strip ? strip.textContent.replace(/\s+/g, ' ').slice(0, 120) : 'missing');

  const feed = $('tradeFeed') ? $('tradeFeed').textContent : '';
  check('event feed receiving server events', feed.length > 0, feed.split('\n').slice(0, 2).join(' / ').slice(0, 160));
  check('no "snapshot refresh failed" in feed', feed.indexOf('snapshot refresh failed') === -1);

  const spotAge = $('spotAge') ? $('spotAge').textContent : '';
  check('spot tile shows a live price', /\$/.test(spotAge), spotAge);
  const k15 = $('k15Ticker') ? $('k15Ticker').textContent : '';
  check('Kalshi contract tile shows a real ticker', /^KX/.test(k15), k15);

  const problemsFiltered = problems.filter(p => !/Could not parse CSS|Error: Not implemented/i.test(p));
  check('zero console problems', problemsFiltered.length === 0, problemsFiltered.slice(0, 3).join(' | '));

  console.log('\n================ ' + pass + ' passed, ' + fail + ' failed ================');
  if (fail) console.log('failures: ' + failures.join(', '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('harness error', e); process.exit(2); });
