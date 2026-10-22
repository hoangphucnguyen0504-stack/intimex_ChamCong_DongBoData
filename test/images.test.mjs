import {test} from 'node:test';
import assert from 'node:assert/strict';
import {upsertImage,linkImage} from '../src/images.js';
import {createApp} from '../src/app.js';

function database(){
  const tables={image_metadata:new Map(),image_links:new Map()};
  let backup;
  const conn={
    async beginTransaction(){backup=structuredClone(tables);},async commit(){},
    async rollback(){for(const name of Object.keys(tables))tables[name]=backup[name];},release(){},
    async query(sql,args=[]){
      const name=sql.match(/(?:INTO|FROM|UPDATE) (image_\w+)/)?.[1];
      if(!name)return [{affectedRows:1}];
      if(sql.startsWith('INSERT')){
        const key=JSON.stringify(args);if(!tables[name].has(key))tables[name].set(key,{version:0,fingerprint:''});
        return [{affectedRows:1}];
      }
      if(sql.startsWith('SELECT'))return [[tables[name].get(JSON.stringify(args))]];
      const fields=sql.split(' SET ')[1].split(' WHERE ')[0].split(',').map(v=>v.split('=')[0]);
      const row=tables[name].get(JSON.stringify(args.slice(fields.length)));
      for(let i=0;i<fields.length;i++)row[fields[i]]=args[i];
      return [{affectedRows:1}];
    }
  };
  return {tables,query:conn.query,getConnection:async()=>conn};
}
const image={namespace:'cham-cong',imageId:'a'.repeat(32),version:2,state:'COMPLETED',driveFileId:'drive_image_12345',mime:'image/jpeg',size:123,checksum:'b'.repeat(64),verifiedAt:'2026-10-22T10:00:00Z',updatedAt:'2026-10-22T10:00:01Z'};
const link={namespace:'cham-cong',imageId:image.imageId,entity:'VehicleTrips',recordId:'trip-1',field:'PhotoIn',slot:0,version:1,updatedAt:'2026-10-22T10:00:02Z'};
test('metadata completion before business link is durable, idempotent and ignores older events',async()=>{
  const db=database();assert.deepEqual(await upsertImage(db,image),{ok:true,applied:true,version:2});
  assert.deepEqual(await upsertImage(db,image),{ok:true,applied:false,version:2});
  assert.deepEqual(await upsertImage(db,{...image,version:1,state:'HOLD',driveFileId:null,verifiedAt:null}),{ok:true,applied:false,version:2});
  assert.equal((await linkImage(db,link)).applied,true);
  assert.equal(db.tables.image_metadata.size,1);assert.equal(db.tables.image_links.size,1);
  assert.equal([...db.tables.image_metadata.values()][0].drive_file_id,image.driveFileId);
});
test('link can precede metadata and slot updates never overwrite other slots',async()=>{
  const db=database();await linkImage(db,link);await linkImage(db,{...link,slot:1,imageId:'c'.repeat(32)});
  assert.equal((await upsertImage(db,image)).applied,true);
  assert.equal((await linkImage(db,link)).applied,false);
  assert.equal((await linkImage(db,{...link,version:2,imageId:'d'.repeat(32)})).applied,true);
  assert.equal((await linkImage(db,link)).version,2);
  assert.equal(db.tables.image_links.size,2);
});
test('same-version conflicts and completion regression roll back safely',async()=>{
  const db=database();await upsertImage(db,image);await linkImage(db,link);
  await assert.rejects(upsertImage(db,{...image,size:124}),e=>e.status===409&&e.code==='IMAGE_VERSION_CONFLICT');
  await assert.rejects(linkImage(db,{...link,imageId:'c'.repeat(32)}),e=>e.status===409);
  await assert.rejects(upsertImage(db,{...image,version:3,state:'FAILED',verifiedAt:null}),e=>e.code==='IMAGE_ALREADY_COMPLETED');
  assert.equal([...db.tables.image_metadata.values()][0].version,2);
});
test('metadata validates bounds, identifiers, hashes, verification and rejects blob/url fields',async()=>{
  for(const change of [{imageId:'../etc/passwd'},{size:0},{size:52428801},{checksum:'invalid'},{version:0},{version:Number.MAX_SAFE_INTEGER+1},{mime:'text/html'},{driveFileId:null},{verifiedAt:null},{url:'https://example.invalid'},{base64:'AAAA'}]){
    await assert.rejects(upsertImage(database(),{...image,...change}),e=>e.name==='ZodError');
  }
  for(const change of [{slot:100},{field:'../file'},{namespace:'../root'},{recordId:'bad\u0000id'}])await assert.rejects(linkImage(database(),{...link,...change}),e=>e.name==='ZodError');
});
test('image HTTP endpoints require service token, enforce schema and bounded request bodies',async t=>{
  const app=createApp(database(),{API_TOKEN:'test-images-secret'}),listener=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>listener.once('listening',resolve));t.after(()=>new Promise(resolve=>{listener.close(resolve);listener.closeAllConnections();}));
  const base='http://127.0.0.1:'+listener.address().port+'/v1/cham-cong/images/';
  const post=(route,body,token=true)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer test-images-secret'}:{})},body:JSON.stringify(body)});
  for(const route of ['upsert','link'])assert.equal((await post(route,{},false)).status,401);
  assert.equal((await post('upsert',image)).status,200);assert.equal((await post('link',link)).status,200);
  assert.equal((await post('upsert',{...image,data:'forbidden'})).status,400);
  assert.equal((await post('link',{...link,field:'x'.repeat(2*1024*1024)})).status,413);
});
