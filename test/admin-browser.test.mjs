import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
let chromium;
try {({chromium}=require(require.resolve('playwright',{paths:[fileURLToPath(new URL('../../Cham_cong/frontend/',import.meta.url))]})));} catch {}

test('admin browser submits login without navigating or reloading', {skip:!chromium,timeout:30000}, async t=>{
  let loggedIn=false,logins=0;
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://fixture').pathname;
    if(path.startsWith('/admin/')){
      res.setHeader('Content-Type','application/json');
      if(path==='/admin/login'){logins++;loggedIn=true;res.end('{"ok":true}');return;}
      if(!loggedIn){res.writeHead(401);res.end('{"code":"LOGIN_REQUIRED"}');return;}
      const data=path==='/admin/me'?{username:'admin'}:path==='/admin/settings'?{settings:{spreadsheetId:'fixture-spreadsheet-123456',intervalMinutes:60,batchSize:100,enabled:false}}:{entities:[],runtime:{},runs:[],jobs:[]};
      res.end(JSON.stringify(data));return;
    }
    const name=path==='/'?'index.html':path.slice(1);
    if(!['index.html','app.js','google-settings.js','retention.js','styles.css','favicon.svg'].includes(name)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
    res.end(await readFile(new URL('../public/'+name,import.meta.url)));
  }).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  let browser;
  t.after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForLoadState('networkidle');
  assert.deepEqual(errors,[]);
  await page.locator('#login-form [name=username]').fill('admin');
  await page.locator('#login-form [name=password]').fill('fixture-password');
  await page.getByRole('button',{name:'Đăng nhập',exact:true}).click();
  await page.locator('#application').waitFor({state:'visible'});
  assert.equal(logins,1);assert.deepEqual(errors,[]);
});
