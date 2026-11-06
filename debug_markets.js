const k = require('./kalshi');
k.loadEnv();
async function test() {
  try {
    const res = await k.raw('live', 'GET', '/markets', { query: { limit: 10, status: 'open' } });
    console.log('Markets:', JSON.stringify(res.markets.map(m => ({ ticker: m.ticker, series: m.event_ticker })), null, 2));
  } catch (e) {
    console.error('Error:', e);
  }
}
test();