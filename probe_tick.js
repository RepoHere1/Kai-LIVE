const t0=Date.now();
const L=(...a)=>console.log(((Date.now()-t0)/1000).toFixed(2)+'s',...a);
(async()=>{
  const k=require('./kalshi.js');
  for(let i=0;i<5;i++){
    const t=Date.now();
    try{ const r=await k.get('/markets',{query:{limit:5,status:'open',series_ticker:'KXBTC15M'},ttlMs:0});
      L('get /markets',Date.now()-t+'ms','source',r.source,'ms',r.ms); }
    catch(e){ L('get /markets ERR',Date.now()-t+'ms',String(e.message||e).slice(0,140)); }
  }
  const sk=require('./series_kind.js');
  const t2=Date.now();
  const r2=await Promise.race([sk.resolveFresh('btc_updown'), new Promise(r=>setTimeout(()=>r('TIMEOUT'),20000))]);
  L('resolveFresh btc_updown ->',JSON.stringify(r2),Date.now()-t2+'ms');
})();
