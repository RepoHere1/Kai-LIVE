const k=require('./kalshi.js');
(async()=>{
  const out=[];
  for (const route of ['/portfolio/balance','/portfolio/positions','/account/balance']) {
    try { const b=await k.raw('live','GET',route,{noRetry429:true}); out.push(route+' OK '+JSON.stringify(b).slice(0,400)); }
    catch(e){ out.push(route+' ERR '+String(e.message||e).slice(0,200)); }
  }
  try { const r=await k.get('/portfolio/balance',{ttlMs:0}); out.push('get() balance: '+JSON.stringify(r).slice(0,400)); } catch(e){ out.push('get() ERR '+e.message); }
  require('fs').writeFileSync('bal_probe.txt', out.join('\n')+'\n');
  console.log(out.join('\n'));
})().catch(e=>console.log('FATAL',e.message));
