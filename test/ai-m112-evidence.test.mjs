import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateDual} from '../src/aiRecognitionV2.js';
const require=createRequire(import.meta.url),root=process.env.INSPECTION_PROJECT_ROOT||fileURLToPath(new URL('../../Cham_cong/',import.meta.url));
const source=path.join(root,'File_phieu/M112.1-2   PHIỀU TIẾP NHẬN YÊU CẦU KHÁCH HÀNG.docx'),backend=path.join(root,'backend/src/services/inspection');
test('actual M112 exact Tel/Fax evidence survives offset correction and independent backend validation',{skip:!fs.existsSync(source)||!fs.existsSync(backend)},async()=>{
  const documents=require(path.join(backend,'documents.js')),{blanks,prepareTargets}=require(path.join(backend,'inputTargets.js')),{validateFinalReview}=require(path.join(backend,'reviewTargets.js'));
  const buffer=fs.readFileSync(source);assert.equal(createHash('sha256').update(buffer).digest('hex'),'783f8a656cfc2c48ab08eca4c9fa0d9ac89bb5e7e23e9d095c434753c483a54a');
  const raw=await documents.scan({originalname:'M112.docx',buffer});
  for(const scan of [raw,prepareTargets(raw)]){
    const positions=scan.positions.filter(p=>p.id.startsWith('word/document.xml:p5')&&!p.readOnlyReason);
    const corrections=positions.map(p=>({position:p.id,recognized:true,label:'',targets:blanks(p.text).filter(r=>!p.inputRange||r.index>=p.inputRange.start&&r.index+r[0].length<=p.inputRange.end).map(r=>({start:0,end:r[0].length,text:r[0],label:'',type:'string',kind:'text',repeat:false}))}));
    const result=validateDual({corrections},{format:'docx',positions});
    const checked=validateFinalReview(result,{...scan,positions},positions.map(p=>p.id));
    assert.equal(checked.flatMap(c=>c.targets).length,2);
    for(const correction of checked){const p=positions.find(p=>p.id===correction.position);for(const t of correction.targets)assert.equal(p.text.slice(t.start,t.end),t.text);}
  }
});
