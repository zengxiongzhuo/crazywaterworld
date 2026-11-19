const giftBatchLabels={success:'成功',used:'已兑换',rejected:'拒绝',unknown:'待确认',skipped:'未发送'};
const giftLabels={queued:'待兑换',sending:'兑换中',success:'兑换成功',used:'已兑换',rejected:'服务器拒绝',unknown:'待确认',skipped:'未发送'};
let giftAccounts=[],giftSelected=new Set(),giftChosen=false,giftStarting=false,giftNote='';
let giftInitial=null,giftLoading=false,giftInitialVersion=0,giftInitialError='';
let giftViewed='',giftRows=[],giftPage=1,giftPageSize=10,giftPages=1,giftTotal=0,giftStatus='exclude-invalid';
let giftExporting=false,giftRecordsLoading=false,giftRecordsVersion=0,giftBatchSaving=false;
let giftTimer,giftVersion=0,giftContext=0;
const giftRetrying=new Set(),giftAutoBusy=new Set();
const giftVisible=()=>!$('tab-giftcodes').classList.contains('hidden');
const giftRecordQuery=()=>new URLSearchParams({account:giftViewed,status:giftStatus,page:String(giftPage),pageSize:String(giftPageSize)});
function giftCanStart(account){return !account.paused&&!account.running&&!account.error;}
function giftTargets(){return giftAccounts.filter(account=>giftSelected.has(account.id)&&giftCanStart(account)).map(account=>account.id);}
function giftAccountNote(account){
  if(account.error)return account.error;
  if(account.paused)return '已暂停';
  if(account.running)return '兑换中 '+(account.total-(account.counts?.queued??0)-(account.counts?.sending??0))+' / '+account.total;
  const last=Object.entries(giftBatchLabels).filter(([status])=>account.counts?.[status]).map(([status,label])=>label+' '+account.counts[status]);
  return (account.connected?'已连接':'未连接')+' · 可兑换 '+(account.available??0)+' 条'+(last.length?' · 上批：'+last.join('，'):'');
}
function paintGiftState(){
  const running=giftAccounts.filter(account=>account.running).length;
  $('gift-code-state').textContent=[running?'正在兑换，剩余 '+running+' 个账号':'',giftNote||(!giftAccounts.length?'请先添加账号':'')].filter(Boolean).join('；');
}
function paintGiftAccounts(){
  const box=$('gift-account-list'),key=giftAccounts.map(account=>account.id+'\n'+account.title).join('\n');
  if(box.accountsKey!==key){
    box.accountsKey=key;clear(box);
    for(const account of giftAccounts){
      const input=el('input');input.type='checkbox';
      input.onchange=()=>{
        giftChosen=true;
        if(input.checked)giftSelected.add(account.id);else giftSelected.delete(account.id);
        paintGiftAccounts();void refreshGiftInitial();
      };
      const automatic=el('button');automatic.type='button';
      automatic.onclick=async event=>{
        event.preventDefault();
        if(giftAutoBusy.has(account.id))return;
        const enabled=!giftAccounts.find(item=>item.id===account.id)?.autoRedeem,context=giftContext;
        giftAutoBusy.add(account.id);automatic.disabled=true;
        try{
          const result=await call('/api/gift-codes/auto?'+new URLSearchParams({account:account.id}),{method:'POST',body:JSON.stringify({confirm:true,enabled})});
          if(context===giftContext)giftNote=result.syncError?'自动兑换已开启，码库同步失败：'+result.syncError:enabled?'已开启自动兑换':'已关闭自动兑换';
        }catch(error){if(context===giftContext)giftNote=error.message;}
        finally{giftAutoBusy.delete(account.id);if(context===giftContext)await refreshGiftCodes();}
      };
      const row=el('label','gift-account');row.append(input,el('span','',account.title),automatic,el('span','dim'));box.append(row);
    }
  }
  giftAccounts.forEach((account,index)=>{
    const row=box.children[index];row.firstChild.checked=giftSelected.has(account.id);row.firstChild.disabled=!giftCanStart(account);
    const automatic=row.children[2];automatic.textContent=account.autoRedeem?'关闭自动兑换':'开启自动兑换';
    automatic.disabled=giftAutoBusy.has(account.id);automatic.setAttribute('aria-pressed',String(Boolean(account.autoRedeem)));
    automatic.setAttribute('aria-label',account.title+'：'+automatic.textContent);
    row.lastChild.textContent=giftAccountNote(account);
  });
  $('gift-selected-count').textContent='已选 '+giftTargets().length+' / '+giftAccounts.length;
  $('gift-code-start').disabled=giftStarting||!giftTargets().length;
  $('gift-select-all').disabled=giftStarting||!giftAccounts.some(giftCanStart);
  $('gift-select-none').disabled=giftStarting||!giftSelected.size;
  const picker=$('gift-record-account');
  if(picker.options.length!==giftAccounts.length||giftAccounts.some((account,index)=>picker.options[index]?.value!==account.id||picker.options[index]?.text!==account.title)){
    picker.replaceChildren(...giftAccounts.map(account=>new Option(account.title,account.id)));
  }
  picker.value=giftViewed;picker.disabled=!giftAccounts.length;
}
function paintGiftInitial(){
  $('gift-load-initial').disabled=giftLoading;
  $('gift-load-initial').textContent=giftLoading?'正在载入…':'载入未兑换码';
  const note=$('gift-code-initial-note');
  if(giftInitialError)note.textContent=giftInitialError;
  else if(!giftInitial)note.textContent='正在读取码库…';
  else{
    const rows=giftInitial.displayRows??[];
    const summary=['码库 '+rows.length+' 条'];
    if(giftSelected.size)summary.push('所选账号可兑换 '+(giftInitial.available??giftInitial.tryCodes?.length??0)+' 条');
    if(giftInitial.lastSyncedAt)summary.push('上次同步 '+when(giftInitial.lastSyncedAt));
    if(giftInitial.lastError)summary.push('同步失败，使用缓存：'+giftInitial.lastError);
    note.textContent=summary.join(' · ');
  }
  const body=clear($('gift-code-library-rows'));
  for(const entry of giftInitial?.displayRows??[]){
    const pending=entry.usage?.some(row=>['queued','sending'].includes(row.status));
    if(!entry.eligible&&!pending&&!$('gift-show-processed').checked)continue;
    const status=entry.eligible?(entry.expiresAt?'未到期':'有效期待确认'):pending?'处理中':entry.usage?.some(row=>row.status==='unknown')?'待确认':'已处理';
    const tr=el('tr');
    [entry.code,status,entry.expiresAt||'未注明'].forEach((value,index)=>{
      const cell=el('td','',value);cell.setAttribute('data-label',['礼包码','可用状态','到期日期'][index]);tr.append(cell);
    });
    body.append(tr);
  }
  if(!body.children.length){const row=el('tr'),cell=el('td','',giftInitial?'暂无符合条件的礼包码':'正在读取码库…');cell.colSpan=3;row.append(cell);body.append(row);}
}
async function refreshGiftInitial(){
  const version=++giftInitialVersion,context=giftContext;
  const query=new URLSearchParams({accounts:JSON.stringify([...giftSelected])});
  try{
    const data=await call('/api/gift-codes/initial?'+query);
    if(version!==giftInitialVersion||context!==giftContext)return;
    giftInitial=data;giftInitialError='';paintGiftInitial();
  }catch(error){if(version===giftInitialVersion&&context===giftContext){giftInitialError='读取码库失败：'+error.message;paintGiftInitial();}}
}
$('gift-load-initial').onclick=async()=>{
  if(giftLoading)return;
  giftLoading=true;giftInitialError='';paintGiftInitial();
  const version=++giftInitialVersion,context=giftContext;
  try{
    const data=await call('/api/gift-codes/load',{method:'POST',body:JSON.stringify({confirm:true,accounts:[...giftSelected]})});
    if(version===giftInitialVersion&&context===giftContext){giftInitial=data;giftNote='已载入礼包码';}
  }catch(error){if(version===giftInitialVersion&&context===giftContext)giftInitialError='载入失败：'+error.message;}
  finally{
    giftLoading=false;paintGiftInitial();paintGiftState();
    if(version!==giftInitialVersion||context!==giftContext)void refreshGiftInitial();
  }
};
$('gift-show-processed').onchange=paintGiftInitial;
$('gift-select-all').onclick=()=>{giftChosen=true;giftSelected=new Set(giftAccounts.filter(giftCanStart).map(account=>account.id));paintGiftAccounts();void refreshGiftInitial();};
$('gift-select-none').onclick=()=>{giftChosen=true;giftSelected.clear();paintGiftAccounts();void refreshGiftInitial();};
function paintGiftPage(){
  $('gift-prev').disabled=giftRecordsLoading||giftPage<=1;
  $('gift-next').disabled=giftRecordsLoading||giftPage>=giftPages;
  $('gift-record-export').disabled=giftExporting||giftRecordsLoading||!giftViewed||!giftTotal;
  $('gift-page').textContent=giftPage+' / '+giftPages+' 页，共 '+giftTotal+' 条';
  const body=clear($('gift-code-history'));
  for(const record of giftRows){
    const tr=el('tr');
    [record.code,giftLabels[record.status]||record.status,record.detail,when(record.at)].forEach((value,index)=>{
      const cell=el('td','',value);cell.setAttribute('data-label',['礼包码','状态','结果','时间'][index]);tr.append(cell);
    });
    const action=el('td');action.setAttribute('data-label','操作');
    if(record.retryable){
      const account=giftViewed,key=account+'\n'+record.code;
      const retry=el('button',null,'重试');retry.type='button';retry.disabled=giftRetrying.has(key)||giftAccounts.find(item=>item.id===account)?.running;
      retry.onclick=async()=>{
        if(giftRetrying.has(key)||!confirm('重试礼包码 '+record.code+'？'))return;
        giftRetrying.add(key);retry.disabled=true;const context=giftContext;
        try{
          await call('/api/gift-codes/retry?'+new URLSearchParams({account}),{method:'POST',body:JSON.stringify({confirm:true,code:record.code})});
          if(context===giftContext&&account===giftViewed)$('gift-record-notice').textContent='已提交重试';
        }catch(error){if(context===giftContext&&account===giftViewed)$('gift-record-notice').textContent=error.message;}
        finally{giftRetrying.delete(key);if(context===giftContext)await refreshGiftCodes();}
      };action.append(retry);
    }else action.textContent='—';
    tr.append(action);body.append(tr);
  }
  if(!giftRows.length){const row=el('tr'),cell=el('td','',giftRecordsLoading?'正在读取兑换记录…':'暂无符合条件的兑换记录');cell.colSpan=5;row.append(cell);body.append(row);}
}
function giftRecordsReset(){
  ++giftRecordsVersion;giftRecordsLoading=false;giftPage=1;giftRows=[];giftTotal=0;giftPages=1;
  $('gift-record-notice').textContent='';paintGiftPage();
}
async function refreshGiftRecords(){
  const version=++giftRecordsVersion,context=giftContext,viewed=giftViewed;
  if(!viewed){giftRecordsReset();return;}
  giftRecordsLoading=true;paintGiftPage();
  try{
    const data=await call('/api/gift-codes?'+giftRecordQuery());
    if(version!==giftRecordsVersion||context!==giftContext||viewed!==giftViewed)return;
    giftRows=data.rows;giftPage=data.page;giftPages=data.pages;giftTotal=data.total;
    if($('gift-record-notice').textContent.startsWith('读取记录失败：'))$('gift-record-notice').textContent='';
  }catch(error){
    if(version===giftRecordsVersion&&context===giftContext){giftRows=[];giftTotal=0;giftPages=1;giftPage=1;$('gift-record-notice').textContent='读取记录失败：'+error.message;}
  }finally{if(version===giftRecordsVersion&&context===giftContext){giftRecordsLoading=false;paintGiftPage();}}
}
$('gift-prev').onclick=()=>{if(giftPage>1&&!giftRecordsLoading){giftPage--;void refreshGiftRecords();}};
$('gift-next').onclick=()=>{if(giftPage<giftPages&&!giftRecordsLoading){giftPage++;void refreshGiftRecords();}};
$('gift-page-size').onchange=()=>{giftPageSize=Number($('gift-page-size').value);giftRecordsReset();void refreshGiftRecords();};
$('gift-record-status').onchange=()=>{giftStatus=$('gift-record-status').value;giftRecordsReset();void refreshGiftRecords();};
$('gift-record-account').onchange=()=>{giftViewed=$('gift-record-account').value;giftRecordsReset();void refreshGiftRecords();};
$('gift-record-export').onclick=async()=>{
  if(giftExporting||!giftViewed||!giftTotal)return;
  const viewed=giftViewed,status=giftStatus,context=giftContext,path='/api/gift-codes/export',query=giftRecordQuery();
  const guard=typeof window==='undefined'?null:window.cwConsoleVersion;
  const assertCurrent=response=>{
    if(guard?.check(response)===false||guard?.isStale?.())throw Error('控制台已更新，请刷新后重新导出');
  };
  giftExporting=true;paintGiftPage();
  try{
    assertCurrent();
    const response=await fetch(path+'?'+query,{headers:guard?.version?{'X-CW-Console-Version':guard.version}:{}});
    assertCurrent(response);
    if(!response.ok){const data=await response.json();if(guard?.check(response,data)===false)throw Error('控制台已更新，请刷新后重新导出');throw Error(data.error||'导出失败');}
    const blob=await response.blob();assertCurrent(response);
    if(context!==giftContext||status!==giftStatus||viewed!==giftViewed)return;
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='礼包兑换记录.csv';document.body.append(link);
    try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
    $('gift-record-notice').textContent='已导出兑换记录';
  }catch(error){if(context===giftContext&&status===giftStatus&&viewed===giftViewed)$('gift-record-notice').textContent='导出失败：'+error.message;}
  finally{giftExporting=false;paintGiftPage();}
};
function giftBatchBusy(busy){
  giftBatchSaving=busy;
  for(const id of ['gift-batch-save','gift-batch-cancel','gift-batch-input','gift-batch-expiry'])$(id).disabled=busy;
}
$('gift-batch-add').onclick=()=>{
  if(giftBatchSaving)return;
  $('gift-batch-input').value='';$('gift-batch-expiry').value='';$('gift-batch-error').textContent='';
  $('gift-batch-dialog').showModal();$('gift-batch-input').focus();
};
$('gift-batch-cancel').onclick=()=>{if(!giftBatchSaving)$('gift-batch-dialog').close();};
$('gift-batch-dialog').oncancel=event=>{event.preventDefault();if(!giftBatchSaving)$('gift-batch-dialog').close();};
$('gift-batch-save').onclick=async()=>{
  if(giftBatchSaving)return;
  const codes=[...new Set($('gift-batch-input').value.split(/\r?\n/).map(code=>code.trim()).filter(Boolean))];
  if(!codes.length){$('gift-batch-error').textContent='请至少输入一条礼包码';$('gift-batch-input').focus();return;}
  if(codes.length>500){$('gift-batch-error').textContent='单次最多保存 500 条礼包码';return;}
  const expiresAt=$('gift-batch-expiry').value||null;
  giftBatchBusy(true);$('gift-batch-error').textContent='';
  try{
    const result=await call('/api/gift-codes/manual',{method:'POST',body:JSON.stringify({confirm:true,codes,expiresAt})});
    $('gift-batch-dialog').close();giftNote='已保存 '+(result.saved??result.codes)+' 条礼包码';
    await refreshGiftCodes();
  }catch(error){$('gift-batch-error').textContent=error.message;}
  finally{giftBatchBusy(false);}
};
function giftAccountChanged(){
  ++giftContext;++giftVersion;++giftInitialVersion;clearTimeout(giftTimer);
  giftNote='';giftInitial=null;giftInitialError='';giftViewed=current||'';giftRecordsReset();
  if(!giftChosen)giftSelected=new Set(current?[current]:[]);
  if(giftVisible())void refreshGiftCodes();
}
async function refreshGiftCodes(){
  const version=++giftVersion,context=giftContext;clearTimeout(giftTimer);
  if(!giftChosen)giftSelected=new Set(current?[current]:[]);
  try{
    const list=await call('/api/gift-codes/accounts');
    if(version!==giftVersion||context!==giftContext)return;
    giftAccounts=list.accounts;
    for(const id of [...giftSelected])if(!giftAccounts.some(account=>account.id===id))giftSelected.delete(id);
    if(!giftAccounts.some(account=>account.id===giftViewed)){
      giftViewed=giftAccounts.some(account=>account.id===current)?current:giftAccounts[0]?.id||'';giftRecordsReset();
    }
    paintGiftAccounts();paintGiftState();
    await Promise.all([refreshGiftInitial(),refreshGiftRecords()]);
  }catch(error){if(version===giftVersion&&context===giftContext){giftNote=error.message;paintGiftState();}}
  finally{
    if(version===giftVersion&&context===giftContext&&giftVisible())giftTimer=setTimeout(refreshGiftCodes,giftAccounts.some(account=>account.running)?750:15000);
  }
}
$('gift-code-start').onclick=async()=>{
  if(giftStarting)return;
  const targets=giftTargets(),context=giftContext;
  if(!targets.length){giftNote='请至少选择一个可兑换账号';paintGiftState();return;}
  if(!giftInitial?.tryCodes?.length){giftNote='暂无可兑换礼包码，请载入或批量新增';paintGiftState();return;}
  ++giftVersion;clearTimeout(giftTimer);giftStarting=true;giftNote='';paintGiftAccounts();paintGiftState();
  try{
    const data=await call('/api/gift-codes/redeem',{method:'POST',body:JSON.stringify({confirm:true,library:true,accounts:targets})});
    if(context===giftContext){const refused=data.results.filter(result=>!result.accepted);giftNote=refused.length?'未开始：'+refused.map(result=>result.title+'（'+result.error+'）').join('、'):'已开始兑换';}
  }catch(error){if(context===giftContext)giftNote=error.message;}
  finally{giftStarting=false;await refreshGiftCodes();}
};
