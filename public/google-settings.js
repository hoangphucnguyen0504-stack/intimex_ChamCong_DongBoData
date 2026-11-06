const $=selector=>document.querySelector(selector);
const serviceName=value=>({chamcong:'ChamCong',hdoi:'HDoi'}[value]||value);
const reasonName=value=>value==='userRateLimitExceeded'?'Giới hạn theo tài khoản':value==='initial'?'Nhận cấu hình lần đầu':value||'—';
export function spreadsheetId(value){
  const text=String(value||'').trim();
  if(!text.startsWith('https://'))return text;
  try{return new URL(text).pathname.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1]||text;}catch{return text;}
}
export function mountGoogleSettings({api,notice,busy,date,table,button}){
  let targets=[],credentials=[],revision=0,driveLoaded=false,statusLoaded=false,dirty=false,opening;
  const input=(text,value,onChange,{type='text',required=true,placeholder='',maxLength=8192}={})=>{
    const label=document.createElement('label'),caption=document.createElement('span'),field=document.createElement('input');
    caption.textContent=text;field.type=type;field.value=value||'';field.required=required;field.maxLength=maxLength;field.placeholder=placeholder;
    field.autocomplete=type==='password'?'new-password':'off';
    field.addEventListener('input',()=>onChange(field.value));label.append(caption,field);return label;
  };
  const checkbox=(text,checked,onChange)=>{
    const label=document.createElement('label'),field=document.createElement('input');
    label.className='check';field.type='checkbox';field.checked=checked;
    field.addEventListener('change',()=>onChange(field.checked));label.append(field,document.createTextNode(text));return label;
  };
  function move(list,index,direction,render){
    const next=index+direction;if(next<0||next>=list.length)return;
    [list[index],list[next]]=[list[next],list[index]];render();
  }
  function actions(list,index,render,onDirty=()=>{}){
    const row=document.createElement('div');row.className='google-card-actions';
    const up=button('Đưa lên',()=>{move(list,index,-1,render);onDirty();});up.disabled=index===0;
    const down=button('Đưa xuống',()=>{move(list,index,1,render);onDirty();});down.disabled=index===list.length-1;
    row.append(up,down,button('Xóa khỏi danh sách',()=>{list.splice(index,1);render();onDirty();}));return row;
  }
  function renderTargets(){
    const box=$('#sheet-target-editor');box.replaceChildren();
    if(!targets.length)box.textContent='Chưa có file dự phòng. Bấm “Thêm file dự phòng” để thêm.';
    targets.forEach((target,index)=>{
      const card=document.createElement('details'),title=document.createElement('summary'),fields=document.createElement('div');
      card.className='destination-card config-list-item';card.open=Boolean(target.editing);fields.className='google-config-fields';
      const caption=document.createElement('strong'),description=document.createElement('small');
      const updateTitle=()=>{caption.textContent=(index+1)+'. '+(target.label||'File dự phòng');description.textContent=(target.enabled===false?'Đã tắt':'Đang bật')+' · '+(target.spreadsheetId||'Chưa nhập Spreadsheet ID')+' · Bấm để chỉnh sửa';};
      updateTitle();title.append(caption,description);card.addEventListener('toggle',()=>target.editing=card.open);
      fields.append(input('Tên file',target.label,value=>target.label=value,{maxLength:100}),
        input('Link hoặc Spreadsheet ID',target.spreadsheetId,value=>target.spreadsheetId=value,{maxLength:512}));
      fields.addEventListener('input',updateTitle);
      card.addEventListener('change',updateTitle);
      card.append(title,fields,checkbox('Cho phép ghi bản ghi mới',target.enabled!==false,value=>target.enabled=value),actions(targets,index,renderTargets));box.append(card);
    });
    $('#add-sheet-target').disabled=targets.length>=20;
  }
  function renderCredentials(){
    const box=$('#drive-credentials-editor');box.replaceChildren();
    if(!credentials.length)box.textContent='Chưa có tài khoản Drive dự phòng. Bấm “Thêm tài khoản Drive” để thêm.';
    credentials.forEach((credential,index)=>{
      const card=document.createElement('details'),head=document.createElement('summary'),title=document.createElement('strong'),fields=document.createElement('div'),code=document.createElement('small');
      card.className='drive-credential-card config-list-item';card.open=Boolean(credential.editing);fields.className='google-config-fields';
      const updateTitle=()=>{title.textContent=(index+1)+'. '+(credential.label||'Tài khoản Drive mới');code.textContent=(credential.enabled===false?'Đã tắt':'Đang bật')+' · '+(credential.id||'Chưa lưu')+' · Bấm để chỉnh sửa';};
      updateTitle();head.append(title,code);card.addEventListener('toggle',()=>credential.editing=card.open);
      const change=key=>value=>{credential[key]=value;dirty=true;};
      if(credential.clientId !== undefined)fields.append(input('Tên tài khoản / cấu hình',credential.label,change('label'),{maxLength:100}),
        input('OAuth Client ID',credential.clientId,change('clientId'),{maxLength:512}),
        input('OAuth Client Secret',credential.clientSecret,change('clientSecret'),{type:'password',required:!credential.clientSecretConfigured,placeholder:credential.clientSecretConfigured?'Đã lưu — để trống để giữ nguyên':''}),
        input('DRIVE_REFRESH_TOKEN',credential.refreshToken,change('refreshToken'),{type:'password',required:!credential.refreshTokenConfigured,placeholder:credential.refreshTokenConfigured?'Đã lưu — để trống để giữ nguyên':''}),
        input('Thư mục Drive ID',credential.folderId,change('folderId'),{maxLength:200}));
      else {
        fields.append(input('DRIVE_REFRESH_TOKEN',credential.refreshToken,change('refreshToken'),{type:'password',required:!credential.refreshTokenConfigured,placeholder:credential.refreshTokenConfigured?'Đã lưu — để trống để giữ nguyên':'Dán refresh token'}));
        const help=document.createElement('p');help.className='muted';help.textContent='Dùng Client ID, Client Secret và thư mục sẵn có của dịch vụ nhận token.';fields.append(help);
      }
      card.append(head,fields,checkbox('Cho phép cấp cấu hình này',credential.enabled!==false,change('enabled')));
      card.addEventListener('input',updateTitle);card.addEventListener('change',updateTitle);
      const controls=actions(credentials,index,renderCredentials,()=>dirty=true);
      if(credential.id&&credential.clientId)controls.append(button('Kiểm tra quyền thư mục',async()=>{
        await api('/admin/drive-credentials/'+encodeURIComponent(credential.id)+'/test',{method:'POST'});
        notice('Kết nối Drive và quyền thư mục hợp lệ.');
      }));
      card.append(controls);box.append(card);
    });
    $('#add-drive-credential').disabled=!driveLoaded||credentials.length>=100;
    $('#save-drive-credentials').disabled=!driveLoaded;
  }
  function renderIssuance(data){
    const assigned=new Map((data.consumers||[]).map(item=>[item.consumer,item]));
    table('#drive-consumers',['chamcong','hdoi'].map(consumer=>assigned.get(consumer)||{consumer}),item=>[
      serviceName(item.consumer),item.credentialId?(item.label+' · '+item.credentialId):'Chưa được cấp từ danh sách',
      item.maskedToken||'—',item.issuedAt?date(item.issuedAt):'Chưa có',reasonName(item.reason)]);
    table('#drive-credential-events',data.events||[],item=>[serviceName(item.consumer),item.label+' · '+item.credentialId,date(item.issuedAt),reasonName(item.reason),item.version]);
  }
  async function loadDrive(replaceEditor=true){
    if(replaceEditor&&dirty&&!confirm('Tải lại sẽ bỏ bản nháp cấu hình Drive. Tiếp tục?'))return;
    $('#drive-credentials-status').textContent='Đang tải danh sách Drive…';
    try{
      const data=await api('/admin/drive-credentials');
      if(replaceEditor){
        credentials=(data.credentials||[]).map(item=>({...item,clientSecret:'',refreshToken:''}));revision=data.revision;driveLoaded=true;dirty=false;renderCredentials();
      }
      renderIssuance(data);$('#drive-credentials-status').textContent='Đã tải danh sách. Chỉ cập nhật khi mở lần đầu, lưu hoặc bấm tải lại.';
    }catch(error){$('#drive-credentials-status').textContent='Chưa tải được cấu hình Drive.';throw error;}
  }
  async function loadDestinations(){
    $('#sheet-target-status').textContent='Đang tải trạng thái các file…';
    try{
      const data=await api('/admin/sheets/destinations');statusLoaded=true;
      const current=$('#settings-form').elements.spreadsheetId.value.trim();
      const names=new Map([[current,'File gốc'],...targets.map(target=>[spreadsheetId(target.spreadsheetId),target.label])]);
      const all=[{spreadsheetId:current,label:'File gốc'},...targets.map(t=>({...t,spreadsheetId:spreadsheetId(t.spreadsheetId)}))];
      const rows=all.flatMap(target=>{
        const states=(data.states||[]).filter(item=>item.spreadsheet_id===target.spreadsheetId);
        return states.length?states.map(item=>({...target,...item})):[target];
      });
      table('#sheet-target-states',rows,item=>[
        (names.get(item.spreadsheet_id||item.spreadsheetId)||item.label)+' · '+(item.spreadsheet_id||item.spreadsheetId),
        item.entity||'Chưa phân bổ',Number(item.exhausted)?'Đã đầy':item.enabled===false?'Tắt nhận bản ghi mới':item.entity?'Đang chứa dữ liệu':'Sẵn sàng / Dự phòng',
        item.next_row||'—',item.last_error||'—',button('Kiểm tra file',async()=>{
          const result=await api('/admin/sheets/test',{method:'POST',body:JSON.stringify({spreadsheetId:item.spreadsheet_id||item.spreadsheetId})});
          notice('Kết nối thành công: '+result.title);
        })]);
      $('#sheet-target-status').textContent='Một lượt đồng bộ cập nhật các file có dữ liệu đang chờ. File đã đầy vẫn giữ dữ liệu lịch sử.';
    }catch(error){$('#sheet-target-status').textContent='Chưa tải được trạng thái file.';throw error;}
  }
  $('#add-sheet-target').addEventListener('click',()=>{
    if(targets.length>=20)return;targets.push({label:'File dự phòng '+(targets.length+1),spreadsheetId:'',enabled:true,editing:true});renderTargets();
  });
  $('#add-drive-credential').addEventListener('click',()=>{
    if(!driveLoaded||credentials.length>=100)return;
    credentials.push({label:'Tài khoản Drive '+(credentials.length+1),clientId:'',folderId:'',refreshToken:'',enabled:true,editing:true});dirty=true;renderCredentials();
  });
  $('#reload-drive-credentials').addEventListener('click',event=>busy(event.currentTarget,()=>loadDrive()));
  $('#refresh-drive-issuance').addEventListener('click',event=>busy(event.currentTarget,()=>loadDrive(false)));
  $('#refresh-sheet-targets').addEventListener('click',event=>busy(event.currentTarget,loadDestinations));
  $('#drive-credentials-form').addEventListener('submit',event=>{
    event.preventDefault();if(!driveLoaded)return;
    busy(event.submitter,async()=>{
      const payload=credentials.map(({id,label,clientId,clientSecret,refreshToken,folderId,enabled})=>({...(id?{id}:{}),label:label.trim(),...(clientId?{clientId:clientId.trim(),clientSecret,folderId:folderId.trim()}:{}),refreshToken,enabled}));
      const data=await api('/admin/drive-credentials',{method:'PUT',body:JSON.stringify({revision,credentials:payload})});
      credentials=data.credentials.map(item=>({...item,clientSecret:'',refreshToken:''}));revision=data.revision;dirty=false;renderCredentials();renderIssuance(data);
      notice('Đã lưu danh sách Drive. Các dịch vụ giữ cấu hình đã nhận cho đến lần chuyển tiếp theo.');
    });
  });
  return {
    setSettings(settings){
      targets=(settings.spreadsheetTargets||[]).map(target=>({...target}));$('#sheet-targets-form').elements.autoRollover.checked=settings.autoRollover!==false;statusLoaded=false;renderTargets();
    },
    payload:()=>({spreadsheetTargets:targets.map(target=>({label:target.label.trim(),spreadsheetId:spreadsheetId(target.spreadsheetId),enabled:target.enabled!==false})),autoRollover:$('#sheet-targets-form').elements.autoRollover.checked}),
    open(){
      if(opening)return opening;
      const work=[!driveLoaded?loadDrive():null,!statusLoaded?loadDestinations():null].filter(Boolean);
      opening=Promise.allSettled(work).then(results=>{for(const result of results)if(result.status==='rejected')notice(result.reason.message,true);}).finally(()=>opening=null);return opening;
    },
    clear(){
      credentials=[];targets=[];revision=0;driveLoaded=false;statusLoaded=false;dirty=false;
      $('#drive-credentials-editor').replaceChildren();$('#sheet-target-editor').replaceChildren();
      $('#save-drive-credentials').disabled=true;$('#add-drive-credential').disabled=true;
      table('#drive-consumers',[],()=>[]);table('#drive-credential-events',[],()=>[]);
    }
  };
}
