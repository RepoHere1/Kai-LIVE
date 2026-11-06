const k=require('./kalshi.js');
(async()=>{
  for(let i=0;i<3;i++){
    const t=Date.now();
    try{ const b=await k.raw('live','GET','/portfolio/balance',{noRetry429:true}); console.log(i,'OK',Date.now()-t,'ms',JSON.stringify(b).slice(0,220)); }
    catch(e){ console.log(i,'ERR',Date.now()-t,'ms',String(e.message||e).slice(0,220)); }
    await new Promise(r=>setTimeout(r,4000));
  }
})();
