import {createHash} from 'node:crypto';

// Runtime presence only: no payloads, credentials, query strings or business data.
export function createAccessActivity({now=Date.now,maxEntries=200,ttlMs=15*60*1000}={}) {
  const entries=new Map();
  function prune(){for(const [key,row]of entries)if(now()-row.lastSeenMs>=ttlMs)entries.delete(key);}
  function track(kind,account){return(req,res,next)=>{
    // Dashboard refreshes are not evidence that a person is actively using data.
    if(req.path==='/status'||req.path==='/me')return next();
    const peer=String(req.socket?.remoteAddress||'unknown');
    const fingerprint=createHash('sha256').update(kind+'\0'+peer).digest('hex').slice(0,12);
    const label=kind==='admin'?String(account):'Kết nối API (token dùng chung)';
    const route=String(req.path||'').split('?')[0];
    const resource=/\/entities\/([A-Za-z][A-Za-z0-9_]{0,63})(?:\/|$)/.exec(route)?.[1]
      ||/\/cham-cong\/rows\/([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(route)?.[1]
      ||(route==='/cham-cong/write'&&typeof req.body?.entity==='string'?req.body.entity.slice(0,64):'');
    prune();const key=kind+':'+fingerprint;
    const old=entries.get(key),at=now();
    entries.delete(key);
    entries.set(key,{id:key,kind,account:label,connection:fingerprint,resource,
      method:req.method,operation:route.startsWith('/cham-cong/')?'Tích hợp chấm công':route.startsWith('/entities/')?'Dữ liệu tài nguyên':route==='/batch'?'Ghi theo lô':'Quản trị / API',
      firstSeen:old?.firstSeen||new Date(at).toISOString(),lastSeen:new Date(at).toISOString(),lastSeenMs:at,requests:(old?.requests||0)+1});
    while(entries.size>maxEntries)entries.delete(entries.keys().next().value);
    res.once('finish',()=>{const current=entries.get(key);if(current?.lastSeenMs===at)current.status=res.statusCode;});
    next();
  };}
  return {track,snapshot(){prune();return {windowMinutes:ttlMs/60000,activeSeconds:60,scope:'Tiến trình API hiện tại; xóa khi khởi động lại. API dùng token chung không xác định được người dùng cuối.',items:[...entries.values()].sort((a,b)=>b.lastSeenMs-a.lastSeenMs).map(({lastSeenMs,...r})=>({...r,active:now()-lastSeenMs<60000}))};}};
}
