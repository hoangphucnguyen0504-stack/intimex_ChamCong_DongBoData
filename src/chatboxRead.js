// A separate API principal: this token is never accepted by the writer integration.
import {equal} from './core.js';
const policy = {
  vehicles: {entity:'VehicleTrips',roles:['GUARD','ADMIN','SUPER_ADMIN'],kind:'VehicleType'},
  visitors: {entity:'Visitors',roles:['GUARD','ADMIN','SUPER_ADMIN']},
  attendance: {entity:'Attendance',roles:['GUARD','ADMIN','SUPER_ADMIN']},
  inventory: {entity:'InventoryLogs',roles:['WAREHOUSE_STAFF','WAREHOUSE_MANAGER','ADMIN','SUPER_ADMIN'],kind:'Type',quantity:'Quantity'},
  items: {entity:'TripItems',roles:['WAREHOUSE_STAFF','WAREHOUSE_MANAGER','ADMIN','SUPER_ADMIN'],kind:'TransactionType',weight:'WeightKg',quantity:'BagCount'},
};
const protocol = 'chatbox-read-v1';
const statuses=new Set(['ON_SITE','EXITED','WAITING','PENDING','CONFIRMED','CANCELLED','COMPLETED','RECORDED','IN','OUT','ACTIVE','SUBMITTED','APPROVED','REJECTED','PRESENT','DEPARTED']);
const kinds=new Set(['IMPORT','EXPORT','IN','OUT','TRUCK','CONTAINER','CAR','MOTORBIKE','OTHER','GOODS','VEHICLE','VISITOR','STAFF']);
function safeRow(row){
  const validDay=typeof row.event_day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.event_day)&&Number.isFinite(Date.parse(row.event_day))&&new Date(row.event_day).toISOString().slice(0,10)===row.event_day;
  const code=(value,allowed)=>allowed.has(String(value).toUpperCase())?String(value).toUpperCase():'OTHER';
  const number=value=>Number.isFinite(Number(value))&&Math.abs(Number(value))<=1e12?Number(value):0;
  return {event_day:validDay?row.event_day:'UNKNOWN',status:code(row.status,statuses),kind:code(row.kind,kinds),weight_kg:number(row.weight_kg),quantity:number(row.quantity)};
}
export function mountChatboxRead(app,pool,config,{track=(_req,_res,next)=>next()}={}) {
  const windows=new Map();let inFlight=0;
  app.use('/v1/chatbox',(req,res,next)=>{
    const now=Date.now();for(const [key,value] of windows)if(value.until<=now)windows.delete(key);
    const ip=req.socket.remoteAddress||'unknown',window=windows.get(ip)||{hits:0,until:now+60000};
    if((windows.size>=10000&&!windows.has(ip))||++window.hits>180){res.set('Retry-After','60');return res.status(429).json({ok:false,code:'READ_RATE_LIMIT'});}
    windows.set(ip,window);next();
  });
  app.use('/v1/chatbox',(req,res,next)=>{
    const token=config.CHATBOX_READ_TOKEN;
    if(!token||token.length<48||equal(token,config.API_TOKEN))return res.status(503).json({ok:false,code:'READ_TOKEN_NOT_CONFIGURED'});
    if(!equal(req.headers.authorization,`Bearer ${token}`))return res.status(401).json({ok:false,code:'READ_TOKEN_INVALID'});
    if(req.method!=='GET')return res.status(403).json({ok:false,code:'READ_ONLY'});
    const role=req.get('X-ChatBox-Role');
    if(!['GUARD','WAREHOUSE_STAFF','WAREHOUSE_MANAGER','ADMIN','SUPER_ADMIN'].includes(role))return res.status(403).json({ok:false,code:'ROLE_REQUIRED'});
    req.chatboxRole=role;
    next();
  });
  app.use('/v1/chatbox',track);
  app.use('/v1/chatbox',(req,res,next)=>{
    if(req.path!=='/rows')return next();
    if(inFlight>=3)return res.status(429).json({ok:false,code:'READ_BUSY'});
    inFlight++;let released=false;
    const release=()=>{if(!released){released=true;inFlight--;}};
    // Metadata only; question/row/token values never enter this log.
    res.once('finish',()=>{release();console.info(JSON.stringify({event:'chatbox_read',role:req.chatboxRole,dataset:policy[req.query.dataset]?req.query.dataset:'denied',rows:res.locals.chatboxRows||0,status:res.statusCode}));});
    res.once('close',release);next();
  });
  app.get('/v1/chatbox/capabilities',(req,res)=>res.json({ok:true,protocol,readOnly:true,maxRows:100,datasets:Object.keys(policy).filter(id=>policy[id].roles.includes(req.chatboxRole))}));
  app.get('/v1/chatbox/rows',async(req,res)=>{
    const dataset=typeof req.query.dataset==='string'?req.query.dataset:'';
    const spec=policy[dataset];
    if(!spec?.roles.includes(req.chatboxRole))return res.status(403).json({ok:false,code:'DATA_FORBIDDEN'});
    if(Object.keys(req.query).some(k=>!['dataset','dates'].includes(k))||(req.query.dates!==undefined&&typeof req.query.dates!=='string'))return res.status(400).json({ok:false,code:'INVALID_QUERY'});
    const dates=req.query.dates?req.query.dates.split(','):[];
    if(dates.length>2||dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))return res.status(400).json({ok:false,code:'INVALID_DATES'});
    const [health]=await pool.execute({sql:'SELECT bootstrap_state,retention_days FROM entities WHERE name=? LIMIT 1',timeout:5000},[spec.entity]);
    if(health[0]?.bootstrap_state!=='ready'||Number(health[0].retention_days)!==0)return res.status(409).json({ok:false,code:'DATA_NOT_READY'});
    const cell=name=>`JSON_UNQUOTE(JSON_EXTRACT(data,'$.${name}'))`;
    const code=name=>name?`CASE WHEN ${cell(name)} REGEXP '^[A-Z_ -]{1,40}$' THEN ${cell(name)} ELSE 'OTHER' END`:`'OTHER'`;
    const number=name=>name?`CASE WHEN ${cell(name)} REGEXP '^-?[0-9]{1,12}([.][0-9]{1,3})?$' THEN CAST(${cell(name)} AS DECIMAL(16,3)) ELSE 0 END`:'0';
    const day=`SUBSTRING(${cell('CreatedAt')},1,10)`;
    const where=dates.length?` AND ${day} IN (${dates.map(()=>'?').join(',')})`:'';
    // Only allowlisted scalar columns leave MySQL, never raw JSON/ID/name/phone/images.
    const [rows]=await pool.execute({sql:`SELECT ${day} event_day,${code('Status')} status,${code(spec.kind)} kind,${number(spec.weight)} weight_kg,${number(spec.quantity)} quantity FROM records WHERE entity=? AND deleted_at IS NULL${where} ORDER BY event_day DESC LIMIT 101`,timeout:5000},[spec.entity,...dates]);
    res.locals.chatboxRows=Math.min(100,rows.length);
    return res.json({ok:true,protocol,rows:rows.slice(0,100).map(safeRow),truncated:rows.length>100});
  });
  // Do not fall through to broader /v1 endpoints or static file handlers.
  app.use('/v1/chatbox',(_req,res)=>res.status(404).json({ok:false,code:'NOT_FOUND'}));
}
