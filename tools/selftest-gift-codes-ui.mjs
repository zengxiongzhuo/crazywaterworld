import assert from 'node:assert/strict';
import fs from 'node:fs';

const script=fs.readFileSync(new URL('../src/gift-codes-ui.js',import.meta.url),'utf8');
const page=fs.readFileSync(new URL('../src/ui/pages.tsx',import.meta.url),'utf8').split('export function giftCodesPage() {')[1].split('export function overviewPage()')[0];
assert(page.indexOf('id="gift-code-start"')<page.indexOf('id="gift-code-library-rows"'));
assert(page.indexOf('id="gift-code-library-rows"')<page.indexOf('id="gift-code-history"'));
for(const removed of ['gift-add-row','gift-code-manual-rows','使用状态','来源 / 操作','手动添加的礼包码全部账号共享','自动兑换默认关闭','失效/不可用包含'])assert(!page.includes(removed),removed+' 应已移除');
assert(!script.includes('gift-add-row'));
assert(!script.includes('gift-auto-toggle'));
assert(!script.includes('gift-record-retry'));
assert.match(script,/el\('button',null,'重试'\)/,'重试按钮沿用无class原生按钮主题');

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const record=code=>({code,status:'success',detail:'金币 ×10',at:'2026-11-19T00:00:00Z',retryable:false});
function fixture(accountList=[{id:'a',title:'账号A',paused:false,running:false,connected:false,counts:{},total:0,available:2,autoRedeem:false}]){
  const env={nodes:new Map(),accounts:accountList,calls:[],downloads:[],timers:[],csvVersion:'page-1',csvError:null,blobReads:0};
  class Node{
    constructor(tag='div'){this.tagName=tag;this.textContent='';this.children=[];this.attributes={};this.value='';this.disabled=false;this.checked=false;this.open=false;this.classList={contains:()=>false};}
    append(...items){this.children.push(...items);for(const item of items)item.parent=this;}
    appendChild(item){this.append(item);return item;}
    replaceChildren(...items){this.children=[];this.append(...items);}
    setAttribute(name,value){this.attributes[name]=value;}
    getAttribute(name){return this.attributes[name];}
    get firstChild(){return this.children[0];}
    get lastChild(){return this.children.at(-1);}
    get options(){return this.children;}
    focus(){env.focused=this;}
    showModal(){this.open=true;}
    close(){this.open=false;}
    click(){if(this.tagName==='a')env.downloads.push({href:this.href,download:this.download});}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(item=>item!==this);}
  }
  env.node=id=>{if(!env.nodes.has(id))env.nodes.set(id,new Node());return env.nodes.get(id);};
  env.element=(tag,className,text)=>{const node=new Node(tag);node.className=className||'';node.textContent=text??'';return node;};
  env.clear=node=>{node.replaceChildren();return node;};
  env.library=[{code:'FIRST',eligible:true,expiresAt:null,usage:[]}];
  env.records=()=>({rows:[record('ROW')],total:1,pages:1,page:1});
  env.body=new Node('body');
  env.guard={version:'page-1',stale:false,isStale(){return this.stale;},check(response,data){const version=response?.headers.get('X-CW-Console-Version');if(version&&version!==this.version||data?.code==='CLIENT_VERSION_MISMATCH')this.stale=true;return !this.stale;}};
  env.call=async(path,options={})=>{
    const url=new URL(path,'http://fixture'),body=options.body?JSON.parse(options.body):null;
    env.calls.push({path:url.pathname,query:url.searchParams,body});
    if(url.pathname==='/api/gift-codes/accounts')return {accounts:env.accounts};
    if(url.pathname==='/api/gift-codes/initial'||url.pathname==='/api/gift-codes/load'){
      if(env.initialGate)await env.initialGate;
      return {displayRows:env.library,tryCodes:env.library.filter(row=>row.eligible).map(row=>row.code),available:env.library.length,total:env.library.length};
    }
    if(url.pathname==='/api/gift-codes/manual'){
      if(env.manualGate)await env.manualGate;
      if(env.manualError)throw Error(env.manualError);
      env.library.push(...body.codes.map(code=>({code,expiresAt:body.expiresAt,eligible:true,usage:[]})));
      return {saved:body.codes.length,codes:body.codes.length};
    }
    if(url.pathname==='/api/gift-codes/auto'){
      if(env.autoGate)await env.autoGate;
      env.accounts.find(account=>account.id===url.searchParams.get('account')).autoRedeem=body.enabled;
      return {enabled:body.enabled};
    }
    if(url.pathname==='/api/gift-codes')return env.records(url.searchParams);
    if(url.pathname==='/api/gift-codes/redeem')return {accepted:body.accounts.length,results:body.accounts.map(id=>({id,title:id,accepted:true}))};
    if(url.pathname==='/api/gift-codes/retry')return {accepted:true};
    throw Error('unexpected '+path);
  };
  env.fetch=async(path,options)=>{
    env.exportRequest={path,options};
    if(env.fetchGate)await env.fetchGate;
    return {ok:!env.csvError,headers:{get:()=>env.csvVersion},json:async()=>({error:env.csvError,code:env.csvCode}),blob:async()=>{env.blobReads++;if(env.blobGate)await env.blobGate;return {};}};
  };
  env.api=new Function('env',`
    const $=env.node,el=env.element,clear=env.clear,when=value=>value||'';
    const call=env.call,fetch=env.fetch,confirm=()=>true;
    const window={cwConsoleVersion:env.guard};
    const document={body:env.body,createElement:env.element};
    const Option=function(text,value){const node=env.element('option');node.text=text;node.value=value;return node;};
    const URL={createObjectURL:()=>{env.objectUrls=(env.objectUrls||0)+1;return 'blob:fixture';},revokeObjectURL:()=>{}};
    const setTimeout=(fn,ms)=>{env.timers.push({fn,ms});return env.timers.length;},clearTimeout=()=>{};
    let current=env.accounts[0]?.id||'';
    ${script}
    return {refresh:refreshGiftCodes,refreshRecords:refreshGiftRecords,refreshLibrary:refreshGiftInitial,
      switchAccount(id){current=id;giftAccountChanged();},
      state:()=>({giftViewed,giftStatus,giftPage,giftTotal,rows:giftRows,library:giftInitial,loading:giftRecordsLoading})};
  `)(env);
  return env;
}
let passed=0;
const test=async(name,work)=>{await work();passed++;console.log('通过：'+name);};
await test('没有账号也能批量保存，去重后全库共享且不发送兑换请求',async()=>{
  const e=fixture([]);await e.api.refresh();
  assert.equal(e.node('gift-code-start').disabled,true);
  e.node('gift-batch-add').onclick();assert(e.node('gift-batch-dialog').open);
  e.node('gift-batch-input').value=' ALPHA \nBETA\nALPHA\n';
  await e.node('gift-batch-save').onclick();
  const writes=e.calls.filter(row=>row.path==='/api/gift-codes/manual');
  assert.equal(writes.length,1);assert.deepEqual(writes[0].body,{confirm:true,codes:['ALPHA','BETA'],expiresAt:null});
  assert.equal(e.node('gift-batch-dialog').open,false);
  assert.equal(e.node('gift-code-library-rows').children.length,3);
  assert.equal(e.calls.some(row=>row.path.endsWith('/redeem')||row.path.endsWith('/auto')),false);
});
await test('空批次不提交，保存失败保留原输入并恢复按钮',async()=>{
  const e=fixture();e.node('gift-batch-add').onclick();await e.node('gift-batch-save').onclick();
  assert.equal(e.calls.length,0);assert.match(e.node('gift-batch-error').textContent,/至少/);
  e.node('gift-batch-input').value='INVALID!';e.manualError='礼包码格式无效';await e.node('gift-batch-save').onclick();
  assert.equal(e.node('gift-batch-input').value,'INVALID!');assert(e.node('gift-batch-dialog').open);
  assert.equal(e.node('gift-batch-save').disabled,false);assert.match(e.node('gift-batch-error').textContent,/格式/);
});
await test('批量保存单飞，等待期间取消与Escape不能关闭弹窗',async()=>{
  const e=fixture([]),gate=deferred();e.manualGate=gate.promise;
  e.node('gift-batch-add').onclick();e.node('gift-batch-input').value='ONE';
  const job=e.node('gift-batch-save').onclick();await tick();
  await e.node('gift-batch-save').onclick();e.node('gift-batch-cancel').onclick();
  let prevented=false;e.node('gift-batch-dialog').oncancel({preventDefault(){prevented=true;}});
  assert(prevented);assert(e.node('gift-batch-dialog').open);assert.equal(e.calls.filter(row=>row.path.endsWith('/manual')).length,1);
  gate.resolve();await job;assert.equal(e.node('gift-batch-dialog').open,false);
});
await test('码库仅显示三列，并可切换已处理记录',async()=>{
  const e=fixture();e.library.push({code:'DONE',eligible:false,expiresAt:'2026-12-01',usage:[{status:'success'}]});await e.api.refresh();
  let rows=e.node('gift-code-library-rows').children;assert.equal(rows.length,1);assert.equal(rows[0].children.length,3);
  assert.deepEqual(rows[0].children.map(cell=>cell.attributes['data-label']),['礼包码','可用状态','到期日期']);
  e.node('gift-show-processed').checked=true;e.node('gift-show-processed').onchange();assert.equal(e.node('gift-code-library-rows').children.length,2);
});
await test('自动兑换只在显式点击后写入，暂停账号仍可修改开关且不重复发送',async()=>{
  const e=fixture([{id:'a',title:'账号A',paused:true,running:false,counts:{},available:1,autoRedeem:false}]);await e.api.refresh();
  assert.equal(e.calls.some(row=>row.path.endsWith('/auto')),false);
  const row=e.node('gift-account-list').children[0],button=row.children[2];assert(row.firstChild.disabled);assert(!button.disabled);assert.equal(button.className,'','自动兑换沿用无class原生按钮主题');
  const gate=deferred();e.autoGate=gate.promise;const job=button.onclick({preventDefault(){}});await tick();
  await button.onclick({preventDefault(){}});assert.equal(e.calls.filter(item=>item.path.endsWith('/auto')).length,1);
  assert.deepEqual(e.calls.find(item=>item.path.endsWith('/auto')).body,{confirm:true,enabled:true});
  gate.resolve();await job;assert.equal(button.attributes['aria-pressed'],'true');assert.equal(e.node('gift-code-start').disabled,true);
});
await test('记录筛选的晚到响应不能覆盖新筛选结果',async()=>{
  const e=fixture();await e.api.refresh();const gate=deferred();
  e.records=query=>query.get('status')==='all'?gate.promise:{rows:[record('SUCCESS')],total:1,pages:1,page:1};
  e.node('gift-record-status').value='all';e.node('gift-record-status').onchange();await tick();
  e.node('gift-record-status').value='success';e.node('gift-record-status').onchange();await tick();
  assert.equal(e.api.state().rows[0].code,'SUCCESS');
  gate.resolve({rows:[record('LATE')],total:5,pages:1,page:1});await tick();
  assert.equal(e.api.state().rows[0].code,'SUCCESS');assert.equal(e.api.state().giftTotal,1);
});
await test('切换账号后晚到的旧账号记录不能显示',async()=>{
  const e=fixture([{id:'a',title:'A',counts:{},available:1},{id:'b',title:'B',counts:{},available:1}]);await e.api.refresh();const gate=deferred();
  e.records=query=>query.get('account')==='a'?gate.promise:{rows:[record('B-ROW')],total:1,pages:1,page:1};
  const job=e.api.refreshRecords();await tick();e.api.switchAccount('b');await tick();
  gate.resolve({rows:[record('A-LATE')],total:1,pages:1,page:1});await job;await tick();
  assert.equal(e.api.state().giftViewed,'b');assert.equal(e.api.state().rows[0].code,'B-ROW');
});
await test('CSV使用独立导出接口并携带页面版本及筛选条件',async()=>{
  const e=fixture();await e.api.refresh();e.node('gift-record-status').value='success';e.node('gift-record-status').onchange();await tick();
  await e.node('gift-record-export').onclick();
  assert.equal(e.exportRequest.options.headers['X-CW-Console-Version'],'page-1');
  const query=new URL(e.exportRequest.path,'http://fixture').searchParams;assert.equal(query.get('account'),'a');assert.equal(query.get('status'),'success');
  assert.equal(e.downloads.length,1);assert.equal(e.downloads[0].download,'礼包兑换记录.csv');
});
await test('CSV返回新版本或读blob期间页面失效时不能下载',async()=>{
  const e=fixture();await e.api.refresh();e.csvVersion='page-2';await e.node('gift-record-export').onclick();
  assert.equal(e.downloads.length,0);assert.equal(e.blobReads,0);assert.match(e.node('gift-record-notice').textContent,/刷新/);
  const second=fixture();await second.api.refresh();const gate=deferred();second.blobGate=gate.promise;
  const job=second.node('gift-record-export').onclick();await tick();second.guard.stale=true;gate.resolve();await job;
  assert.equal(second.downloads.length,0);assert.equal(second.objectUrls??0,0);
});
await test('读取CSV期间改变筛选条件时丢弃旧导出',async()=>{
  const e=fixture();await e.api.refresh();const gate=deferred();e.blobGate=gate.promise;
  const job=e.node('gift-record-export').onclick();await tick();
  e.node('gift-record-status').value='success';e.node('gift-record-status').onchange();await tick();gate.resolve();await job;
  assert.equal(e.downloads.length,0);
});
await test('兑换只在点击后提交共享码库及选择账号',async()=>{
  const e=fixture();await e.api.refresh();assert.equal(e.calls.some(row=>row.path.endsWith('/redeem')),false);
  await e.node('gift-code-start').onclick();
  assert.deepEqual(e.calls.find(row=>row.path.endsWith('/redeem')).body,{confirm:true,library:true,accounts:['a']});
});
console.log(`礼包码界面专项 ${passed}/${passed} 通过（离线模拟，零游戏请求）`);
