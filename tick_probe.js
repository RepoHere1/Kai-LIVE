const http=require('http');
function get(p){return new Promise(r=>{const t=Date.now();http.get({host:'127.0.0.1',port:8788,path:p},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>r({ms:Date.now()-t,body:b}))}).on('error',e=>r({err:e.message}))})}
(async()=>{
 for(let i=0;i<10;i++){
  const r=await get('/api/strategies');
  const j=JSON.parse(r.body);
  console.log(new Date().toISOString(),'btc.last_tick='+j.btc_updown.heartbeat,'eth='+j.eth_updown.heartbeat,'btc.skips='+j.btc_updown.skips,'btc.edge='+j.btc_updown.last_edge);
  await new Promise(r=>setTimeout(r,12000));
 }
})();
