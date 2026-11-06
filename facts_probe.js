const sqlite3=require('sqlite3').verbose();
const db=new sqlite3.Database('facts.db');
db.all("SELECT reasons, COUNT(*) n FROM facts GROUP BY reasons ORDER BY n DESC LIMIT 25",(e,r)=>{
 if(e)return console.log('ERR',e.message);
 console.log('--- reasons histogram'); r.forEach(x=>console.log(String(x.n).padStart(7),x.reasons));
 db.all("SELECT COUNT(*) obs, SUM(CASE WHEN verdict='GOOD' THEN 1 ELSE 0 END) good, SUM(CASE WHEN verdict LIKE 'GOOD%' THEN 1 ELSE 0 END) good2 FROM facts",(e2,r2)=>{
  console.log('totals',JSON.stringify(r2));
  db.all("SELECT source, COUNT(*) n, SUM(CASE WHEN verdict='GOOD' THEN 1 ELSE 0 END) good FROM facts GROUP BY source",(e3,r3)=>{
   console.log('--- by source'); r3.forEach(x=>console.log(x.source,'n='+x.n,'good='+x.good));
   db.all("SELECT COUNT(*) n FROM facts WHERE yes_bid=0 AND yes_ask=0 AND no_bid=1 AND no_ask=1",(e4,r4)=>{
    console.log('all-empty-book rows:',JSON.stringify(r4));
    db.all("SELECT COUNT(*) n FROM facts WHERE verdict='GOOD'",(e5,r5)=>{console.log('GOOD rows',JSON.stringify(r5)); db.close();});
   });
  });
 });
});
