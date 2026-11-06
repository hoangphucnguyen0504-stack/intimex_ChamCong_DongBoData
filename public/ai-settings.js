const node=(tag,text,className)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(className)e.className=className;return e;};
export function mountAISettings({api,notice,busy,date}){
  const stylesheet=node('link');stylesheet.rel='stylesheet';stylesheet.href='/ai-settings.css';document.head.append(stylesheet);
  const nav=node('button','Danh sách API AI');nav.dataset.tab='ai';document.querySelector('aside nav').append(nav);
  const page=node('section');page.dataset.page='ai';page.hidden=true;document.querySelector('.workspace').append(page);
  const intro=node('div',null,'panel');intro.append(node('h2','Danh sách API AI'),node('p','Key được mã hoá tại DataDongBo và không trả về trình duyệt. Worker phân tích mẫu; thứ tự từ trên xuống là thứ tự ưu tiên. Kiểm tra kết nối có thể phát sinh một lượt gọi AI.','muted'));
  const status=node('p','Chưa tải cấu hình.','muted');status.setAttribute('role','status');intro.append(status);page.append(intro);
  const form=node('form',null,'panel'),limits=node('div',null,'form-grid'),editor=node('div');
  const actions=node('div',null,'actions'),add=node('button','Thêm API dự phòng'),save=node('button','Lưu cấu hình AI'),reload=node('button','Tải lại');
  add.type=reload.type='button';save.type='submit';reload.className='ghost';actions.append(add,save,reload);form.append(limits,editor,actions);page.append(form);
  const statistics=node('div',null,'panel'),history=node('div',null,'panel');page.append(statistics,history);
  let config=null,rows=[],dirty=false,generation=0;
  const input=(label,value,{type='text',name,min,max,step}={})=>{
    const wrapper=node('label',label),control=node('input');control.type=type;control.name=name||'';
    if(type==='checkbox'){control.checked=!!value;wrapper.className='ai-toggle';}else control.value=value??'';
    for(const [key,val] of Object.entries({min,max,step}))if(val!==undefined)control[key]=val;
    if(type==='password'){control.autocomplete='new-password';control.maxLength=2000;control.placeholder='Để trống để giữ key đã lưu';}
    wrapper.append(control);return {wrapper,control};
  };
  const button=(title,fn)=>{const b=node('button',title,'ghost');b.type='button';b.addEventListener('click',fn);return b;};
  function collect(){return rows.map(row=>({...row.value,name:row.name.value.trim(),vendor:row.vendor.value,model:row.model.value.trim(),enabled:row.enabled.checked,pricingKnown:row.pricing.checked,inputUsdPerMillion:Number(row.input.value),outputUsdPerMillion:Number(row.output.value),...(row.key.value.trim()?{apiKey:row.key.value.trim()}:{})}));}
  function render(providers){
    editor.replaceChildren();rows=[];
    providers.forEach((p,index)=>{
      p={...p,keyConfigured:p.keyConfigured||config?.providers.some(saved=>saved.id===p.id&&saved.vendor===p.vendor&&saved.keyConfigured)};
      const box=node('fieldset',null,'panel');box.append(node('legend',`${index+1}. ${p.name||'API mới'}`));
      const grid=node('div',null,'form-grid');
      const name=input('Tên hiển thị',p.name),model=input('Model',p.model),key=input(p.keyConfigured?'API key (đã lưu)':'API key',p.apiKey||'',{type:'password'}),enabled=input('Bật API',p.enabled,{type:'checkbox'}),pricing=input('Đã xác định đơn giá',p.pricingKnown,{type:'checkbox'}),priceIn=input('USD / 1 triệu token đầu vào',p.inputUsdPerMillion||0,{type:'number',min:0,max:10000,step:'any'}),priceOut=input('USD / 1 triệu token đầu ra',p.outputUsdPerMillion||0,{type:'number',min:0,max:10000,step:'any'});
      const vendor=node('select'),vendorLabel=node('label','Nhà cung cấp');
      for(const [value,title] of [['openai','OpenAI'],['gemini','Google Gemini']]){const option=node('option',title);option.value=value;vendor.append(option);}vendor.value=p.vendor||'openai';vendorLabel.append(vendor);
      model.control.required=name.control.required=true;
      model.control.placeholder=p.vendor==='gemini'?'Model Gemini hỗ trợ JSON schema':'Model OpenAI hỗ trợ JSON schema';
      grid.append(name.wrapper,vendorLabel,model.wrapper,key.wrapper,priceIn.wrapper,priceOut.wrapper,enabled.wrapper,pricing.wrapper);box.append(grid);
      const value={id:p.id,name:p.name,vendor:p.vendor,model:p.model,enabled:p.enabled,pricingKnown:!!p.pricingKnown,inputUsdPerMillion:p.inputUsdPerMillion||0,outputUsdPerMillion:p.outputUsdPerMillion||0};
      rows.push({value,name:name.control,vendor,model:model.control,key:key.control,enabled:enabled.control,pricing:pricing.control,input:priceIn.control,output:priceOut.control});
      const controls=node('div',null,'actions');
      const up=button('Đưa lên',()=>{const list=collect();[list[index-1],list[index]]=[list[index],list[index-1]];render(list);dirty=true;}),down=button('Đưa xuống',()=>{const list=collect();[list[index],list[index+1]]=[list[index+1],list[index]];render(list);dirty=true;});up.disabled=index===0;down.disabled=index===providers.length-1;
      const test=button('Kiểm tra API đã lưu',()=>busy(test,async()=>{
        if(dirty)throw Error('Lưu cấu hình trước khi kiểm tra.');
        const current=generation,r=await api(`/admin/ai/providers/${encodeURIComponent(p.id)}/test`,{method:'POST'});
        status.textContent='Đã xếp hàng kiểm tra, đang chờ worker…';
        for(let i=0;i<40&&current===generation;i++){
          await new Promise(resolve=>setTimeout(resolve,2000));if(current!==generation)return;
          const result=(await api(`/admin/ai/jobs/${r.job.id}`)).job;
          if(result.state==='success'){status.textContent='Kết nối và phản hồi cấu trúc hợp lệ.';await refreshStats();return;}
          if(['failed','needs_review'].includes(result.state))throw Error(`Kiểm tra chưa thành công: ${result.errorCode||result.state}`);
        }
        if(current===generation)status.textContent='Tác vụ vẫn đang chờ. Kiểm tra worker và tải lại trạng thái.';
      }));test.disabled=!p.keyConfigured||!p.enabled;
      controls.append(up,down,test,button('Gỡ API',()=>{if(!confirm(`Gỡ ${p.name||'API này'} khỏi danh sách?`))return;const list=collect();list.splice(index,1);render(list);dirty=true;}));box.append(controls);editor.append(box);
    });
  }
  const limitControls={};
  function renderLimits(){limits.replaceChildren();for(const [name,label,min,max,step] of [['maxAttempts','Số API thử tối đa / tác vụ',1,3,1],['maxCallsPerDay','Lượt gọi tối đa / ngày (UTC)',1,1000,1],['maxOutputTokens','Token đầu ra tối đa / lượt',256,8000,1],['dailyBudgetUsd','Giới hạn chi phí ước tính USD / ngày (0 = không đặt)',0,1000,'any']]){const f=input(label,config[name],{type:'number',name,min,max,step});f.control.required=true;limitControls[name]=f.control;limits.append(f.wrapper);}}
  function stats(configuration){statistics.replaceChildren(node('h2','Sử dụng trong ngày (UTC)'),node('p','Chi phí là ước tính từ đơn giá bạn cấu hình. Lượt lỗi hoặc chưa rõ kết quả giữ khoản dự trù; không thay thế hoá đơn nhà cung cấp.','muted'));for(const p of configuration.providers){const s=p.stats||{};statistics.append(node('p',`${p.name}: ${s.calls||0} lượt · ${s.successes||0} thành công · ${s.uncertain||0} chưa rõ kết quả · ${s.input_tokens||0}/${s.output_tokens||0} token vào/ra · ${Number(s.unpriced_calls)>0?'Chi phí chưa đầy đủ: có lượt chưa cấu hình đơn giá':'~'+Number(s.estimated_usd||0).toFixed(6)+' USD'}${p.health?` · ${p.health.error_code}, chờ đến ${date(p.health.cooldown_until)}`:''}`));}}
  async function refreshStats(){const r=await api('/admin/ai');stats(r.configuration);}
  async function open(){const current=++generation;save.disabled=true;status.textContent='Đang tải cấu hình AI…';try{const r=await api('/admin/ai');if(current!==generation)return;config=r.configuration;dirty=false;renderLimits();render(config.providers);stats(config);save.disabled=false;status.textContent='Đã tải cấu hình. Key đã lưu luôn được giữ kín.';const audit=await api('/admin/ai/history');if(current!==generation)return;history.replaceChildren(node('h2','Lịch sử thay đổi'));for(const item of audit.items)history.append(node('p',`Phiên bản ${item.revision} · ${item.actor} · ${date(item.created_at)}`));}catch(e){status.textContent='Chưa tải được cấu hình AI.';notice(e.message,true);}}
  form.addEventListener('input',()=>{dirty=true;});form.addEventListener('change',()=>{dirty=true;});
  form.addEventListener('submit',event=>{event.preventDefault();busy(save,async()=>{if(!config)throw Error('Tải cấu hình trước khi lưu.');const settings=Object.fromEntries(Object.entries(limitControls).map(([key,control])=>[key,Number(control.value)]));await api('/admin/ai',{method:'PUT',body:JSON.stringify({revision:config.revision,providers:collect(),...settings})});for(const row of rows)row.key.value='';notice('Đã lưu danh sách API AI.');await open();});});
  add.addEventListener('click',()=>{const list=collect();list.push({id:crypto.randomUUID(),name:'',vendor:'openai',model:'',enabled:false});render(list);dirty=true;});
  reload.addEventListener('click',()=>{if(!dirty||confirm('Bỏ thay đổi chưa lưu và tải lại?'))open();});
  save.disabled=true;
  return {open,clear(){generation++;config=null;rows=[];dirty=false;editor.replaceChildren();limits.replaceChildren();statistics.replaceChildren();history.replaceChildren();save.disabled=true;}};
}
