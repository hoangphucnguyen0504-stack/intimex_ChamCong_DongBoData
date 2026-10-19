const $=selector=>document.querySelector(selector);
let session=false,refreshing=false,settings,lastStatus;
const labels={pending:'Chờ xử lý',retry:'Đang chờ thử lại',running:'Đang chạy',success:'Thành công',failed:'Lỗi',needs_review:'Cần kiểm tra',interrupted:'Bị gián đoạn',ready:'Sẵn sàng',new:'Chưa khởi tạo',importing:'Đang nhập'};
const date=v=>v?new Intl.DateTimeFormat('vi-VN',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Ho_Chi_Minh'}).format(new Date(v)):'Chưa có';
function notice(message,error=false){const n=$('#notice');n.textContent=message;n.className=error?'error':'';n.hidden=false;clearTimeout(notice.timer);notice.timer=setTimeout(()=>n.hidden=true,error?12000:5000);}
async function api(path,options={}) {
  const r=await fetch(path,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
  const data=await r.json();if(!r.ok){if(r.status===401)showLogin();throw Error(data.message||data.code||'Không thể kết nối.');}return data;
}
function showLogin(){session=false;$('#application').hidden=true;$('#login-panel').hidden=false;}
function badge(value){const e=document.createElement('span');e.className='badge'+(['failed','needs_review','interrupted'].includes(value)?' error':'');e.textContent=labels[value]||value;return e;}
function table(target,rows,cells){const body=$(target);body.replaceChildren();if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=8;td.textContent='Không có dữ liệu';tr.append(td);body.append(tr);return;}for(const row of rows){const tr=document.createElement('tr');for(const content of cells(row)){const td=document.createElement('td');if(content instanceof Node)td.append(content);else td.textContent=String(content??'—');tr.append(td);}body.append(tr);}}
function button(text,action){const b=document.createElement('button');b.type='button';b.className='ghost';b.textContent=text;b.addEventListener('click',()=>busy(b,action));return b;}
async function busy(b,action){if(b.disabled)return;b.disabled=true;try{await action();}catch(e){notice(e.message,true);}finally{b.disabled=false;}}
async function refresh(initial=false) {
  if(!session||refreshing||document.hidden)return;refreshing=true;if(initial)$('#loading').hidden=false;
  try {
    const s=await api('/admin/status');lastStatus=s;
    $('#access-scope').textContent=s.accessActivity?.scope||'Chưa có thông tin truy cập.';
    table('#access-activity',s.accessActivity?.items||[],r=>[r.account,r.connection,r.active?'Vừa hoạt động (< 60 giây)':'Gần đây',r.resource||r.operation,r.method+(r.status?' · '+r.status:''),r.requests,date(r.lastSeen)]);
    const pending=s.entities.reduce((sum,e)=>sum+Number(e.pending),0),total=s.entities.reduce((sum,e)=>sum+Number(e.total),0);
    $('#total-count').textContent=total.toLocaleString('vi-VN');$('#pending-count').textContent=pending.toLocaleString('vi-VN');
    const latest=s.entities.map(e=>e.last_sync_at).filter(Boolean).sort().at(-1);$('#last-sync').textContent=date(latest);
    $('#next-sync').textContent=settings?.enabled?date(s.runtime.next_sync_at):'Tự động đang tắt';
    $('#schedule-state').textContent=settings?.enabled?`Mỗi ${settings.intervalMinutes} phút; các lô tiếp theo chạy liên tục`:'Có thể chạy đồng bộ thủ công';
    const alive=s.runtime.heartbeat_at&&Date.now()-Date.parse(s.runtime.heartbeat_at)<120000;
    $('#worker-status').textContent=s.runtime.worker_error?`Worker: ${s.runtime.worker_error}`:alive?'Worker đang hoạt động':'Chưa nhận tín hiệu worker';
    $('#worker-status').className='pill'+(!alive||s.runtime.worker_error?' bad':'');
    table('#entity-status',s.entities,e=>[`${e.name} / ${e.tab_name}`,badge(e.bootstrap_state),e.total,e.pending,date(e.last_sync_at),e.last_error||'—']);
    table('#runs',s.runs,r=>[date(r.started_at),r.entity,r.kind==='import'?'Nhập lần đầu':'Đồng bộ',badge(r.state),r.rows_count,r.error_code||date(r.finished_at)]);
    table('#jobs',s.jobs,j=>{const cell=document.createElement('div');cell.textContent=j.error_code||'—';if(j.state==='needs_review')cell.append(button('Thử lại',async()=>{await api(`/admin/jobs/${encodeURIComponent(j.id)}/retry`,{method:'POST'});notice('Đã đưa tác vụ vào hàng đợi.');await refresh();}));return[date(j.created_at),`${j.kind} / ${j.entity||'Tất cả'}`,badge(j.state),j.attempts,cell];});
    const container=$('#entity-actions');container.replaceChildren();
    if(!s.entities.length)container.textContent='Chưa có tài nguyên. Hãy thêm tài nguyên trước.';
    for(const e of s.entities){const row=document.createElement('div');row.className='entity-action';const info=document.createElement('span');info.textContent=`${e.name} → ${e.tab_name} · ${labels[e.bootstrap_state]} · lưu ${e.retention_days?e.retention_days+' ngày':'vĩnh viễn'}`;row.append(info);
      if(e.bootstrap_state!=='ready')row.append(button('Nhập từ Sheets',async()=>{if(!confirm(`Nhập dữ liệu tab ${e.tab_name} vào MySQL? Không ghi đè dữ liệu đã nhập.`))return;await api('/admin/jobs',{method:'POST',body:JSON.stringify({kind:'import',entity:e.name})});notice('Đã lưu tác vụ nhập. Theo dõi tiến độ ở Tổng quan.');await refresh();}));container.append(row);}
  }catch(e){notice('Chưa cập nhật được trạng thái: '+e.message,true);}finally{refreshing=false;$('#loading').hidden=true;}
}
async function initialize(){const me=await api('/admin/me');session=true;$('#application').hidden=false;$('#login-panel').hidden=true;$('#account').textContent=me.username;
  settings=(await api('/admin/settings')).settings;const f=$('#settings-form');for(const key of ['spreadsheetId','intervalMinutes','batchSize'])f.elements[key].value=settings[key];f.elements.enabled.checked=settings.enabled;
  $('#credential-info').textContent=settings.credentialsConfigured?`Đã lưu Service Account: ${settings.serviceAccountEmail}`:'Chưa cấu hình Service Account. Chia sẻ Sheet với email của Service Account, quyền Editor.';await refresh(true);
}
$('#login-form').addEventListener('submit',e=>{e.preventDefault();busy(e.submitter,async()=>{const form=e.target;await api('/admin/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});form.elements.password.value='';await initialize();});});
$('#logout').addEventListener('click',()=>busy($('#logout'),async()=>{await api('/admin/logout',{method:'POST'});showLogin();$('#settings-form').elements.serviceAccount.value='';}));
$('#settings-form').addEventListener('submit',e=>{e.preventDefault();busy(e.submitter,async()=>{const f=e.target;const payload={spreadsheetId:f.elements.spreadsheetId.value.trim(),intervalMinutes:Number(f.elements.intervalMinutes.value),batchSize:Number(f.elements.batchSize.value),enabled:f.elements.enabled.checked};if(f.elements.serviceAccount.value.trim()){let credentials;try{credentials=JSON.parse(f.elements.serviceAccount.value);}catch{throw Error('JSON Service Account không hợp lệ.');}payload.serviceAccount={client_email:credentials.client_email,private_key:credentials.private_key};}
  await api('/admin/settings',{method:'PUT',body:JSON.stringify(payload)});f.elements.serviceAccount.value='';settings=(await api('/admin/settings')).settings;$('#credential-info').textContent=`Đã lưu Service Account: ${settings.serviceAccountEmail}`;notice('Đã lưu cấu hình.');await refresh();});});
$('#test-sheets').addEventListener('click',()=>busy($('#test-sheets'),async()=>{const r=await api('/admin/sheets/test',{method:'POST'});notice(`Kết nối thành công: ${r.title}. Các tab: ${r.tabs.join(', ')}`);}));
$('#entity-form').addEventListener('submit',e=>{e.preventDefault();busy(e.submitter,async()=>{const f=e.target;await api('/admin/entities',{method:'POST',body:JSON.stringify({name:f.elements.name.value.trim(),tabName:f.elements.tabName.value.trim(),headers:f.elements.headers.value.split(/[\r\n,]+/).map(s=>s.trim()).filter(Boolean),retentionDays:Number(f.elements.retentionDays.value)})});notice('Đã lưu tài nguyên. Chạy nhập lần đầu để bắt đầu sử dụng.');await refresh();});});
$('#read-headers').addEventListener('click',()=>busy($('#read-headers'),async()=>{const f=$('#entity-form'),tab=f.elements.tabName.value.trim();if(!tab)throw Error('Nhập tên tab trước.');const r=await api('/admin/sheets/headers?tab='+encodeURIComponent(tab));if(!r.headers.length)throw Error('Tab chưa có tiêu đề. Hãy nhập danh sách cột thủ công.');f.elements.headers.value=r.headers.join('\n');if(!f.elements.name.value)f.elements.name.value=tab;notice('Đã lấy cột từ tab. Kiểm tra lại trước khi lưu.');}));
$('#sync-now').addEventListener('click',()=>busy($('#sync-now'),async()=>{const r=await api('/admin/jobs',{method:'POST',body:JSON.stringify({kind:'sync'})});notice(r.existing?'Đã có tác vụ đang chờ/chạy.':'Đã lưu yêu cầu đồng bộ.');await refresh();}));
const titles={overview:'Tổng quan đồng bộ',settings:'Cấu hình đồng bộ',entities:'Tài nguyên dữ liệu',connection:'Kết nối chấm công'};
for(const b of document.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>{for(const p of document.querySelectorAll('[data-page]'))p.hidden=p.dataset.page!==b.dataset.tab;for(const n of document.querySelectorAll('[data-tab]'))n.classList.toggle('active',n===b);$('#page-title').textContent=titles[b.dataset.tab];});
setInterval(()=>refresh(),10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
initialize().catch(()=>showLogin());
