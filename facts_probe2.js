const sqlite3=require('sqlite3').verbose();
const db=new sqlite3.Database('facts.db');
const q=(s,...a)=>new Promise(r=>db.all(s,a,(e,x)=>r(e?{err:e.message}:x)));
(async()=>{
 const series=await q("SELECT substr(ticker,1,7) ser, COUNT(*) n, SUM(CASE WHEN verdict='GOOD' THEN 1 ELSE 0 END) good FROM facts GROUP BY ser ORDER BY n DESC LIMIT 15");
 console.log('--- by series prefix'); series.forEach(x=>console.log(x.ser,'n='+x.n,'good='+x.good,(100*x.good/x.n).toFixed(1)+'%'));
 const ages=await q("SELECT (age_ms/1000) sec, COUNT(*) n, SUM(CASE WHEN verdict='GOOD' THEN 1 ELSE 0 END) good FROM facts WHERE age_ms IS NOT NULL GROUP BY sec ORDER BY sec LIMIT 40");
 console.log('--- age_ms buckets(sec)'); ages.forEach(x=>console.log(x.sec+'s','n='+x.n,'good='+x.good));
 const empt=await q("SELECT COUNT(*) n FROM facts WHERE yes_bid=0 AND no_ask=1 AND yes_ask>0 AND no_bid>0");
 console.log('--- bid0/ask1 but other side present:',JSON.stringify(empt));
 const spread=await q("SELECT COUNT(*) n FROM facts WHERE verdict='GOOD' AND (yes_ask-yes_bid)<0.005");
 console.log('--- GOOD rows with spread<MIN_SPREAD (should be 0):',JSON.stringify(spread));
 db.close();
})();
