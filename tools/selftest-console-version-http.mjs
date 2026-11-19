// Real local HTTP and recreated console instances; no game connection or real data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(root,'cw-console-version-'));
process.env.CW_DATA_DIR=directory;process.env.CW_CONFIG_PACK=path.join(directory,'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK,'[]');
const {GameClient}=await import('../src/client.mjs');
let connections=0;
GameClient.prototype.connect=async()=>{connections++;throw Error('Test must not connect to a game');};
const {saveStore}=await import('../src/accounts.mjs');
const {createConsole}=await import('./fixtures/console-server.mjs');
const {settingsFile,loadAutomationSettings}=await import('../src/automation-settings.mjs');
saveStore({activeId:'version-test',accounts:[{id:'version-test',label:'版本测试',url:'wss://fixture.invalid',login:{},automation:{enabled:false,autoStart:false,paused:true}}]});
let app,base,passed=0;
const open=async()=>{app=createConsole({port:0,protocol:{}});base=await app.listen();};
const close=async()=>{app.server.closeAllConnections();await app.close();};
const api=async(route,body,version,browser=false)=>{
 const headers={...(browser?{origin:base,referer:base+'/'}:{}),...(version===undefined?{}:{'X-CW-Console-Version':version})};
 const response=await fetch(base+'/api/'+route+'?account=version-test',{headers,
  ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
 return {status:response.status,version:response.headers.get('x-cw-console-version'),data:await response.json()};
};
const ok=result=>{assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
const blocked=result=>{assert.equal(result.status,409,JSON.stringify(result.data));assert.equal(result.data.code,'CLIENT_VERSION_MISMATCH');assert.match(result.data.fields.revision,/刷新/);};
const test=async(name,run)=>{await run();passed++;console.log('通过：'+name);};
try{
 await open();
 const page=await fetch(base),html=await page.text(),version=page.headers.get('x-cw-console-version'),etag=page.headers.get('etag');
 let settings=ok(await api('settings'));
 await test('HTML固定启动版本，页面和API响应版本一致，浏览器必须带当前版本保存',async()=>{
  assert(version);assert(html.includes('name="cw-console-version" content="'+version+'"'));
  assert.equal((await api('settings')).version,version);
  const payload={settings:settings.settings,revision:settings.revision,baseRevision:settings.baseRevision};
  blocked(await api('settings',payload,undefined,true));blocked(await api('settings',payload,'old-version',true));
  assert.equal(fs.existsSync(settingsFile()),false,'旧页面请求不能创建设置');
  settings=ok(await api('settings',payload,version,true));assert.equal(settings.revision,1);
 });
 const original=fs.readFileSync(settingsFile());
 await close();await open();
 const newPage=await fetch(base,{headers:{'if-none-match':etag}}),newHtml=await newPage.text(),newVersion=newPage.headers.get('x-cw-console-version');
 await test('后台重建后旧页面与旧ETag失效，读取可发现更新但不能以旧版本写入',async()=>{
  assert.equal(newPage.status,200);assert.notEqual(newVersion,version);assert.notEqual(newPage.headers.get('etag'),etag);
  assert(newHtml.includes('name="cw-console-version" content="'+newVersion+'"'));
  const read=await api('loop',undefined,version,true);assert.equal(read.status,200);assert.equal(read.version,newVersion);
  const changed=structuredClone(settings.settings);changed.resources.diamondDailyLimit=1234;
  blocked(await api('settings',{settings:changed,revision:settings.revision},version,true));
  blocked(await api('settings',{settings:changed,revision:settings.revision},undefined,true));
  blocked(await api('login-settings',{settings:{},revision:1},version,true));
  blocked(await api('loop/control',{confirm:true,key:'cityWar.enabled',enabled:true,revision:1},version,true));
  blocked(await api('accounts/pause',{confirm:true,paused:false,start:true},version,true));
  assert.deepEqual(fs.readFileSync(settingsFile()),original,'所有过期写入都应在业务处理前拒绝');
 });
 await test('旧页面仍能停止挂机或断开，刷新后新版本保存继续校验配置修订号',async()=>{
  ok(await api('loop/stop',{confirm:true},version,true));ok(await api('disconnect',{confirm:true},version,true));
  const current=ok(await api('settings',undefined,newVersion,true));
  const changed=structuredClone(current.settings);changed.resources.diamondDailyLimit=1234;
  const saved=ok(await api('settings',{settings:changed,revision:current.revision},newVersion,true));
  assert.equal(saved.settings.resources.diamondDailyLimit,1234);assert.equal(saved.revision,current.revision+1);
  const conflict=await api('settings',{settings:changed,revision:current.revision},newVersion,true);
  assert.equal(conflict.status,400);assert(conflict.data.fields.revision);
 });
 await test('无浏览器标记的本地脚本API兼容，显式旧版本仍拒绝且不会连接游戏',async()=>{
  const current=loadAutomationSettings('version-test');
  ok(await api('settings',{settings:current.settings,revision:current.revision}));
  blocked(await api('settings',{settings:current.settings,revision:current.revision},version));
  assert.equal(connections,0);
 });
 console.log(`控制台页面版本 HTTP 专项 ${passed}/${passed} 通过（零游戏连接）`);
}finally{if(app)await close();assert.equal(path.dirname(path.resolve(directory)),root);fs.rmSync(directory,{recursive:true,force:true});}
