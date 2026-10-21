import express from 'express';
import helmet from 'helmet';
import {fileURLToPath} from 'node:url';
import {ZodError} from 'zod';
import {Fault,entityName,recordId,json,publicRecord,tabRange,columnName} from './core.js';
import {authFor} from './auth.js';
import {mutate,listRecords} from './records.js';
import {getSettings,saveSettings,saveEntity} from './settings.js';
import {enqueue,importRecord} from './sync.js';
import {Sheets} from './sheets.js';
import {quotaGate} from './quota.js';
import {archivedPage} from './archive.js';
import * as chamCong from './chamCong.js';
import {createAccessActivity} from './accessActivity.js';
import {mountChatboxRead} from './chatboxRead.js';
export function createApp(pool,config,{sheetsFactory=s=>new Sheets(s,{gate:quotaGate(pool,config.SHEETS_REQUESTS_PER_MINUTE)})}={}) {
  const app=express(),auth=authFor(pool,config);
  const accessActivity=createAccessActivity();
  app.disable('x-powered-by');app.use(helmet());
  app.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.get('/health/live',(_req,res)=>res.json({ok:true}));
  app.get('/health/ready',async(_req,res)=>{try {await pool.query('SELECT 1');res.json({ok:true});}catch {res.status(503).json({ok:false});}});
  const normalJson=express.json({limit:'2mb',strict:true}),integrationJson=express.json({limit:'8mb',strict:true});
  app.use((req,res,next)=>req.path==='/v1/cham-cong/write'
    ? auth.integration(req,res,()=>integrationJson(req,res,next)) : normalJson(req,res,next));
  app.use('/admin',auth.csrf);
  app.post('/admin/login',auth.login);
  app.use('/admin',auth.admin);
  app.use('/admin',accessActivity.track('admin',config.ADMIN_USERNAME));
  app.post('/admin/logout',auth.logout);
  app.get('/admin/me',(_req,res)=>res.json({ok:true,username:config.ADMIN_USERNAME}));
  app.get('/admin/settings',async(_req,res)=>res.json({ok:true,settings:await getSettings(pool,config.CONFIG_ENCRYPTION_KEY,true)}));
  app.put('/admin/settings',async(req,res)=>res.json(await saveSettings(pool,config.CONFIG_ENCRYPTION_KEY,req.body)));
  app.post('/admin/sheets/test',async(_req,res)=>{
    const s=sheetsFactory(await getSettings(pool,config.CONFIG_ENCRYPTION_KEY));const result=await s.test();
    res.json({ok:true,title:result.properties.title,tabs:result.sheets.map(s=>s.properties.title)});
  });
  app.get('/admin/sheets/headers',async(req,res)=>{
    const tab=String(req.query.tab||'');if(!tab||tab.length>100)throw new Fault(400,'TAB_REQUIRED');
    const sheets=sheetsFactory(await getSettings(pool,config.CONFIG_ENCRYPTION_KEY));
    const [headers=[]]=await sheets.read(tabRange(tab)+'!1:1');
    res.json({ok:true,headers:headers.filter(h=>typeof h==='string'&&!h.startsWith('__dd_'))});
  });
  app.get('/admin/status',async(_req,res)=>{
    const [[runtime]]=await pool.query('SELECT heartbeat_at,next_sync_at,worker_error FROM runtime_state WHERE id=1');
    const [entities]=await pool.query(`SELECT e.*,COUNT(r.id) total,COALESCE(SUM(r.dirty=1),0) pending,
      COALESCE(SUM(r.deleted_at IS NOT NULL),0) deleted FROM entities e LEFT JOIN records r ON r.entity=e.name GROUP BY e.name`);
    const [runs]=await pool.query('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 30');
    const [jobs]=await pool.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 30');
    res.json({ok:true,runtime,entities:entities.map(e=>({...e,headers:json(e.headers)})),runs,jobs,accessActivity:accessActivity.snapshot()});
  });
  app.post('/admin/entities',async(req,res)=>res.status(201).json(await saveEntity(pool,req.body)));
  app.post('/admin/jobs',async(req,res)=>res.status(202).json(await enqueue(pool,req.body.kind,req.body.entity||null)));
  app.post('/admin/jobs/:id/retry',async(req,res)=>{
    const [r]=await pool.query("UPDATE jobs SET state='pending',attempts=0,error_code=NULL,available_at=UTC_TIMESTAMP(3) WHERE id=? AND state='needs_review'",[req.params.id]);
    if(!r.affectedRows)throw new Fault(409,'JOB_NOT_RETRYABLE');res.json({ok:true});
  });
  mountChatboxRead(app,pool,config,{track:accessActivity.track('api')});
  app.use('/v1',auth.integration);
  app.use('/v1',accessActivity.track('api'));
  app.get('/v1/cham-cong/ping',(_req,res)=>res.json({ok:true}));
  app.get('/v1/cham-cong/status',async(req,res)=>res.json(await chamCong.status(pool,config.CONFIG_ENCRYPTION_KEY,req.query.spreadsheetId)));
  app.get('/v1/cham-cong/rows/:entity',async(req,res)=>res.json(await chamCong.readRows(pool,config.CONFIG_ENCRYPTION_KEY,entityName.parse(req.params.entity),req.query)));
  app.post('/v1/cham-cong/write',async(req,res)=>res.json(await chamCong.writeRows(pool,config.CONFIG_ENCRYPTION_KEY,req.body)));
  app.post('/v1/batch',async(req,res)=>res.json(await mutate(pool,req.body)));
  app.get('/v1/requests/:id',async(req,res)=>{
    const [[r]]=await pool.query('SELECT response FROM requests WHERE id=?',[req.params.id]);
    if(!r?.response)throw new Fault(404,'REQUEST_NOT_FOUND');res.json(json(r.response));
  });
  app.get('/v1/entities/:entity/records',async(req,res)=>res.json(await listRecords(pool,entityName.parse(req.params.entity),req.query)));
  app.get('/v1/entities/:entity/records/:id',async(req,res)=>{
    const [[r]]=await pool.query('SELECT * FROM records WHERE entity=? AND id=?',[entityName.parse(req.params.entity),recordId.parse(req.params.id)]);
    if(!r) {
      const [[m]]=await pool.query('SELECT archived_at FROM row_map WHERE entity=? AND id=?',[req.params.entity,req.params.id]);
      if(m?.archived_at)throw new Fault(410,'RECORD_ARCHIVED','Dùng endpoint archive để xem lịch sử.');
      throw new Fault(404,'RECORD_NOT_FOUND');
    }
    res.json({ok:true,record:publicRecord(r)});
  });
  app.get('/v1/entities/:entity/archive',async(req,res)=>{
    const sheets=sheetsFactory(await getSettings(pool,config.CONFIG_ENCRYPTION_KEY));
    res.json(await archivedPage(pool,entityName.parse(req.params.entity),req.query,sheets));
  });
  app.get('/v1/entities/:entity/archive/:id',async(req,res)=>{
    const entity=entityName.parse(req.params.entity),id=recordId.parse(req.params.id);
    const [[e]]=await pool.query('SELECT * FROM entities WHERE name=?',[entity]);
    const [[m]]=await pool.query('SELECT sheet_row FROM row_map WHERE entity=? AND id=?',[entity,id]);
    if(!e||!m)throw new Fault(404,'ARCHIVE_NOT_FOUND');
    const sheets=sheetsFactory(await getSettings(pool,config.CONFIG_ENCRYPTION_KEY)),headers=[...json(e.headers),'__dd_version','__dd_deleted_at','__dd_business_at','__dd_finalized_at'];
    const [currentHeader=[]]=await sheets.read(tabRange(e.tab_name)+'!1:1');
    if(JSON.stringify(headers)!==JSON.stringify(currentHeader))throw new Fault(409,'SHEET_HEADER_MISMATCH');
    const [values=[]]=await sheets.read(`${tabRange(e.tab_name)}!A${m.sheet_row}:${columnName(headers.length-1)}${m.sheet_row}`);
    const r=importRecord(e,values,headers);
    if(!r||r.id!==id)throw new Fault(409,'SHEET_ROW_MOVED');
    res.json({ok:true,source:'sheets',record:{...r,entity}});
  });
  app.use(express.static(fileURLToPath(new URL('../public',import.meta.url)),{etag:true,maxAge:0}));
  app.use((_req,_res,next)=>next(new Fault(404,'NOT_FOUND')));
  app.use((err,_req,res,_next)=>{
    const status=err instanceof ZodError?400:err.type==='entity.parse.failed'?400:err.type==='entity.too.large'?413:err instanceof Fault?err.status:503;
    const code=err instanceof ZodError?'VALIDATION_ERROR':err instanceof Fault?err.code:status===413?'PAYLOAD_TOO_LARGE':'SERVICE_UNAVAILABLE';
    if(status>=500)console.error(JSON.stringify({event:'api_error',code}));
    res.status(status).json({ok:false,code,message:err instanceof Fault?err.message:err instanceof ZodError?'Dữ liệu không hợp lệ.':'Dịch vụ tạm thời chưa sẵn sàng.',...(err instanceof Fault&&err.details?{current:err.details}:{})});
  });
  return app;
}
