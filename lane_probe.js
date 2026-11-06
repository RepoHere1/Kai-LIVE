const fs=require('fs');
const s=JSON.parse(fs.readFileSync('state.json','utf8'));
for(const [k,v] of Object.entries(s.lanes||{})){
  console.log(k.padEnd(22),'running='+v.running,'heartbeat='+v.heartbeat,'last_tick='+v.last_tick,'skips='+v.skips,'last_skip='+JSON.stringify(v.last_skip));
}
console.log('--- live.last_balance', JSON.stringify(s.live&&s.live.last_balance));
console.log('--- live.starting_balance', s.live&&s.live.starting_balance);
