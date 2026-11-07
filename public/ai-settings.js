const node=(tag,text,className)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(className)e.className=className;return e;};
const vendors={gemini:'Google Gemini',openai:'OpenAI'};
export function mountAISettings({api,notice,busy,date}){
  const stylesheet=node('link');stylesheet.rel='stylesheet';stylesheet.href='/ai-settings.css';document.head.append(stylesheet);
  const nav=node('button','Danh sách API AI');nav.dataset.tab='ai';document.querySelector('aside nav').append(nav);
  const page=node('section',null,'ai-manager');page.dataset.page='ai';page.hidden=true;document.querySelector('.workspace').append(page);
  const panel=node('section',null,'panel ai-panel'),head=node('div',null,'ai-heading'),title=node('div');
  title.append(node('span','KẾT NỐI MÔ HÌNH','ai-eyebrow'),node('h2','Danh sách API AI'),node('p','Chọn nhà cung cấp, nhập model và API key. Hệ thống ưu tiên từ trên xuống, tự chuyển sang API tiếp theo khi gặp lỗi.','muted'));
  const add=button('+ Thêm API',()=>{const list=collect();list.push({id:crypto.randomUUID(),vendor:'gemini',model:'',enabled:true});render(list);markDirty();editor.querySelector('tbody tr:last-child input')?.focus();});add.className='ai-add';head.append(title,add);
  const summary=node('div',null,'ai-summary'),count=node('span'),secure=node('span','API key được mã hóa','ai-secure');summary.append(count,secure);
  const status=node('p','Chưa tải danh sách API.','ai-status');status.setAttribute('role','status');
  const form=node('form'),editor=node('div'),footer=node('div',null,'ai-footer'),hint=node('span','Các thay đổi chỉ áp dụng sau khi lưu.','muted');
  const controls=node('div',null,'ai-footer-actions'),reload=button('Tải lại',()=>{if(!dirty||confirm('Bỏ thay đổi chưa lưu và tải lại?'))open();}),save=node('button','Lưu danh sách API');save.type='submit';controls.append(reload,save);footer.append(hint,controls);form.append(editor,footer);
  panel.append(head,summary,status,form);page.append(panel);
  const history=node('details',null,'panel ai-history');history.append(node('summary','Lịch sử thay đổi'));const historyRows=node('div');history.append(historyRows);page.append(history);
  const diagnostics=node('details',null,'panel ai-history');diagnostics.append(node('summary','Nhật ký lỗi xử lý file'));const diagnosticRows=node('div');diagnostics.append(diagnosticRows);page.append(diagnostics);
  let config=null,rows=[],dirty=false,generation=0;
  function button(title,fn,label){const b=node('button',title,'ghost');b.type='button';if(label){b.setAttribute('aria-label',label);b.title=label;}b.addEventListener('click',fn);return b;}
  function markDirty(){dirty=true;hint.textContent='Có thay đổi chưa lưu';hint.className='ai-unsaved';}
  function collect(){return rows.map(row=>({id:row.value.id,...(row.value.name?{name:row.value.name}:{}),vendor:row.vendor.value,model:row.model.value.trim(),enabled:row.value.enabled!==false,...(row.key.value.trim()?{apiKey:row.key.value.trim()}:{})}));}
  function render(providers){
    editor.replaceChildren();rows=[];count.textContent=`${providers.length} API · ${providers.filter(p=>p.enabled!==false).length} đang bật`;add.disabled=!config;
    if(!providers.length){const empty=node('div',null,'ai-empty');empty.append(node('span','＋','ai-empty-icon'),node('h3','Chưa có kết nối AI'),node('p','Thêm API đầu tiên để bắt đầu phân tích mẫu.','muted'));editor.append(empty);return;}
    const scroll=node('div',null,'ai-table-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Bảng danh sách API AI, có thể cuộn ngang');
    const table=node('table',null,'ai-table'),caption=node('caption','Danh sách kết nối theo thứ tự ưu tiên');caption.className='ai-visually-hidden';table.append(caption);
    const thead=node('thead'),heading=node('tr');for(const label of ['Ưu tiên','Nhà cung cấp','Tên model','API key','Trạng thái','Thao tác']){const th=node('th',label);th.scope='col';heading.append(th);}thead.append(heading);table.append(thead);const tbody=node('tbody');table.append(tbody);
    providers.forEach((p,index)=>{
      const tr=node('tr');const cell=()=>{const td=node('td');tr.append(td);return td;};
      cell().append(node('span',String(index+1).padStart(2,'0'),'ai-order'));
      const vendorCell=cell(),vendor=node('select');vendor.setAttribute('aria-label',`Nhà cung cấp API ${index+1}`);for(const [value,title] of Object.entries(vendors)){const option=node('option',title);option.value=value;vendor.append(option);}vendor.value=p.vendor||'gemini';vendorCell.append(vendor);
      const modelCell=cell(),model=node('input');model.value=p.model||'';model.placeholder='Nhập tên model';model.required=true;model.maxLength=100;model.setAttribute('aria-label',`Tên model API ${index+1}`);model.autocomplete='off';modelCell.append(model);
      const keyCell=cell(),key=node('input');key.type='password';key.value=p.apiKey||'';key.maxLength=2000;key.autocomplete='new-password';key.setAttribute('aria-label',`API key ${index+1}`);const keyNote=node('small',null,'ai-key-note');keyCell.append(key,keyNote);
      const saved=config?.providers.find(old=>old.id===p.id),configured=()=>saved?.vendor===vendor.value&&saved.keyConfigured;
      const syncKey=()=>{key.placeholder=configured()?'Để trống để giữ key đã lưu':'Nhập API key';key.required=p.enabled!==false&&!configured();keyNote.textContent=configured()?'Đã lưu an toàn':'Key mới được mã hóa khi lưu';};syncKey();vendor.addEventListener('change',syncKey);
      const stateCell=cell(),toggle=button(p.enabled===false?'Tạm dừng':'Đang bật',()=>{const list=collect();list[index].enabled=p.enabled===false;render(list);markDirty();},`${p.enabled===false?'Bật':'Tạm dừng'} API ${index+1}`);toggle.className=`ai-badge ${p.enabled===false?'is-paused':'is-enabled'}`;toggle.setAttribute('aria-pressed',String(p.enabled!==false));stateCell.append(toggle);
      if(saved?.health){const until=Date.parse(saved.health.cooldown_until),waiting=Number.isFinite(until)&&until>Date.now();stateCell.append(node('small',waiting?`Chờ đến ${date(saved.health.cooldown_until)}`:'Đã hết thời gian chờ','ai-health'),node('small',saved.health.error_code,'ai-health'));}
      const actionCell=cell(),actions=node('div',null,'ai-row-actions');
      const up=button('↑',()=>move(index,-1),`Đưa API ${index+1} lên`),down=button('↓',()=>move(index,1),`Đưa API ${index+1} xuống`);up.disabled=index===0;down.disabled=index===providers.length-1;
      const test=button('Kiểm tra',()=>busy(test,async()=>{
        if(dirty)throw Error('Lưu danh sách trước khi kiểm tra kết nối.');
        const current=generation,r=await api(`/admin/ai/providers/${encodeURIComponent(p.id)}/test`,{method:'POST'});if(current!==generation)return;
        status.textContent=`Đang kiểm tra ${vendors[p.vendor]} · ${p.model}…`;
        for(let i=0;i<40&&current===generation;i++){
          await new Promise(resolve=>setTimeout(resolve,2000));if(current!==generation)return;
          const result=(await api(`/admin/ai/jobs/${r.job.id}`)).job;if(current!==generation)return;
          if(result.state==='success'){status.textContent='Kết nối và phản hồi cấu trúc hợp lệ.';return;}
          if(['failed','needs_review'].includes(result.state)){status.textContent=`Kiểm tra chưa thành công: ${result.errorCode||result.state}`;throw Error(status.textContent);}
        }
        if(current===generation)status.textContent='Tác vụ vẫn đang chờ. Kiểm tra worker DataDongBo rồi tải lại danh sách.';
      }),`Kiểm tra API ${index+1}`);test.disabled=!configured()||p.enabled===false;
      const remove=button('Xoá',()=>{if(!confirm(`Xoá kết nối ${vendors[vendor.value]} · ${model.value||'model chưa nhập'}?`))return;const list=collect();list.splice(index,1);render(list);markDirty();},`Xoá API ${index+1}`);remove.className='ghost ai-delete';actions.append(up,down,test,remove);actionCell.append(actions);
      rows.push({value:p,vendor,model,key});tbody.append(tr);
    });
    scroll.append(table);editor.append(scroll,node('p','Đổi thứ tự bằng ↑ ↓ để chọn API được ưu tiên. Trên màn hình nhỏ, cuộn ngang để xem đầy đủ bảng.','ai-table-help'));
  }
  function move(index,delta){const list=collect();[list[index],list[index+delta]]=[list[index+delta],list[index]];render(list);markDirty();editor.querySelector(`button[aria-label="Đưa API ${index+delta+1} ${delta>0?'lên':'xuống'}"]`)?.focus();}
  async function open(){
    const current=++generation;save.disabled=add.disabled=true;status.textContent='Đang tải danh sách API…';
    try{
      const r=await api('/admin/ai');if(current!==generation)return;config=r.configuration;dirty=false;render(config.providers);save.disabled=reload.disabled=false;hint.textContent='Các thay đổi chỉ áp dụng sau khi lưu.';hint.className='muted';status.textContent='Đã tải danh sách. API key đã lưu luôn được giữ kín.';
      try{const audit=await api('/admin/ai/history');if(current!==generation)return;historyRows.replaceChildren();for(const item of audit.items)historyRows.append(node('p',`Phiên bản ${item.revision} · ${item.actor} · ${date(item.created_at)}`));if(!audit.items.length)historyRows.append(node('p','Chưa có thay đổi được ghi nhận.','muted'));}catch{if(current===generation)historyRows.replaceChildren(node('p','Chưa tải được lịch sử. Bạn vẫn có thể quản lý danh sách API.','muted'));}
      try{
        const logs=await api('/admin/ai/diagnostics');if(current!==generation)return;diagnosticRows.replaceChildren();
        const retryJobs=new Set();
        for(const item of logs.items||[]){
          const entry=node('div',null,'ai-diagnostic'),code=item.code||item.error_code;
          entry.append(node('p',`${date(item.created_at)} · ${item.stage} · ${code}`),node('small',`Tác vụ: ${item.jobId||'chưa có'} · API: ${item.providerId||'—'} · File: ${item.fileHash||'—'}`),node('small',`Mã nhật ký: ${item.id}`));
          if(item.processingId)entry.append(node('small',`Lượt xử lý file: ${item.processingId}`));
          if(item.driveCredentialId)entry.append(node('small',`Drive: ${item.driveCredentialLabel||item.driveCredentialId}`));
          if(item.temporaryFileId)entry.append(node('small',`File tạm cần dọn: ${item.temporaryFileId}`));
          const transport=item.details?.transport;
          if(transport){const reasons={deadline:'hết thời gian chờ',connect_timeout:'hết thời gian kết nối',upstream_timeout:'kết nối bên ngoài hết thời gian',dns:'không phân giải được DNS',tls:'lỗi kết nối TLS',connection_refused:'kết nối bị từ chối',connection_reset:'kết nối bị ngắt',network:'lỗi mạng'};entry.append(node('small',`${transport.phase==='response'?'Đọc phản hồi':'Gửi/chờ phản hồi'}: ${reasons[transport.reason]||'lỗi kết nối'} · ${Math.round(transport.elapsedMs/1000)} giây · thời gian chờ ${Math.round(transport.timeoutMs/1000)} giây`));}
           const upstream=item.details?.upstream;
           if(upstream)entry.append(node('small',`HTTP ${upstream.status} · ${vendors[upstream.vendor]||upstream.vendor}${upstream.model?' · '+upstream.model:''} · ${Math.round(upstream.elapsedMs/1000)} giây · chờ ${upstream.retryAfterSeconds} giây`));
          for(const issue of item.details?.issues||[])entry.append(node('p',`${issue.code}: ${issue.path.join('.')}`));
          if(/^[a-f0-9]{64}$/.test(item.jobId||'')&&/^[a-f0-9]{64}$/.test(item.retryToken||'')&&['AI_UNKNOWN','AI_TIMEOUT','AI_NETWORK','AI_INTERRUPTED','AI_INTERNAL'].includes(code)&&!retryJobs.has(item.jobId)){
            retryJobs.add(item.jobId);
            const retry=button('Thử lại tác vụ',async()=>{
              if(!confirm('Lượt gọi trước chưa xác định được kết quả. Gửi lại có thể tạo thêm một lượt gọi AI. Bạn có muốn tiếp tục?'))return;
              retry.disabled=true;
              try{await api('/admin/ai/jobs/'+item.jobId+'/retry',{method:'POST',body:JSON.stringify({attemptToken:item.retryToken})});retry.remove();entry.append(node('p','Đã gửi lại tác vụ. Chọn lại file trong Giám định để nhận kết quả.'));}
              catch(error){retry.disabled=false;notice(error.message,true);}
            });entry.append(retry);
          }
          diagnosticRows.append(entry);
        }
        if(!logs.items?.length)diagnosticRows.append(node('p','Chưa có lỗi xử lý file được ghi nhận.','muted'));
      }catch{if(current===generation)diagnosticRows.replaceChildren(node('p','Chưa tải được nhật ký lỗi. Chọn Tải lại để thử lại.','muted'));}
    }catch(e){if(current===generation){reload.disabled=false;status.textContent='Chưa tải được danh sách. Chọn Tải lại để thử lại.';notice(e.message,true);}}
  }
  form.addEventListener('input',markDirty);form.addEventListener('change',markDirty);
  form.addEventListener('submit',event=>{event.preventDefault();busy(save,async()=>{
    if(!config)throw Error('Tải danh sách trước khi lưu.');
    const current=generation,submittedRows=rows.slice(),body=JSON.stringify({revision:config.revision,providers:collect()});
    const disabled=[...form.querySelectorAll('input,select,button'),add].map(control=>({control,wasDisabled:control.disabled}));
    for(const {control} of disabled)control.disabled=true;
    try{
      await api('/admin/ai',{method:'PUT',body});
      if(current!==generation)return;
      for(const row of submittedRows)row.key.value='';
      notice('Đã lưu danh sách API AI.');await open();
    }finally{if(current===generation)for(const {control,wasDisabled} of disabled)if(control.isConnected)control.disabled=wasDisabled;}
  });});
  save.disabled=add.disabled=true;
  return {open:()=>config&&dirty?undefined:open(),clear(){generation++;config=null;rows=[];dirty=false;editor.replaceChildren();historyRows.replaceChildren();diagnosticRows.replaceChildren();count.textContent='';status.textContent='Chưa tải danh sách API.';hint.textContent='Các thay đổi chỉ áp dụng sau khi lưu.';save.disabled=add.disabled=true;}};
}
