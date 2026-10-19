import {transaction} from './db.js';
export const quotaGate=(pool,rpm)=>async()=>{
  const wait=await transaction(pool,async db=>{
    const [[r]]=await db.query('SELECT next_google_at,UTC_TIMESTAMP(3) AS now_at FROM runtime_state WHERE id=1 FOR UPDATE');
    const now=+new Date(r.now_at),slot=Math.max(now,r.next_google_at?+new Date(r.next_google_at):0);
    await db.query('UPDATE runtime_state SET next_google_at=? WHERE id=1',[new Date(slot+Math.ceil(60000/rpm))]);
    return Math.max(0,slot-now);
  });
  if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
};
