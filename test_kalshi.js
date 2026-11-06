const k = require('./kalshi');
k.loadEnv();
async function test() {
  try {
    const res = await k.raw('live', 'GET', '/markets', { query: { series_ticker: 'KXBTC15M', limit: 1, status: 'open' } });
    console.log('Markets:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('Error:', e);
  }
}
test();