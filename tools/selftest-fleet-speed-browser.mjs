// 隔离账号与本机临时HTTP端口；只测试配置，不建立游戏连接。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cw-speed-browser-'));
process.env.CW_DATA_DIR=directory;process.env.CW_CONFIG_PACK=path.join(directory,'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK,JSON.stringify([
  [1,'BuildingUnlockCfg',{data:[1,2,3].map(i=>({buildingType:'远征船',buildingId:i+'远征船'}))}],
  [1,'1_CityCfg',{data:[{id:1,name:'城市甲'},{id:2,name:'城市乙'}]}],
]));
const {saveStore}=await import('../src/accounts.mjs');
const {defaultSettings,saveAutomationSettings,loadAutomationSettings}=await import('../src/automation-settings.mjs');
const {createConsole}=await import('../src/server.mjs');
const {observeOwnedFleets}=await import('../src/fleet-catalog.mjs');
const {cityWarFleetStrategy}=await import('../src/city-war-settings.mjs');
saveStore({activeId:'speed-browser',accounts:[{id:'speed-browser',label:'加速界面测试',url:'ws://invalid.invalid',login:{},automation:{enabled:false,paused:true}}]});
const settings=defaultSettings();settings.cityWar.enabled=true;settings.cityWar.fleetIds=['1远征船','2远征船'];settings.cityWar.defenceFleetIds=['2远征船'];
settings.fleetSpeed.enabled=true;for(const fleet of settings.fleetSpeed.fleets)Object.assign(fleet,{repairSmartSave:true,marchSmartSave:true});Object.assign(settings.fleetSpeed.fleets[0],{repair:true,march:true});
saveAutomationSettings('speed-browser',settings,{revision:0});
const app=createConsole({port:0,protocol:{}}),base=await app.listen();let browser;const errors=[];
const executablePath=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
try{
  await fetch(base+'/api/settings?account=speed-browser');const session=app.sessions.get('speed-browser');session.player={playerId:123,worldId:1001001};
  observeOwnedFleets(session,[{buildingId:'1远征船'},{buildingId:'2远征船'}],{complete:true});
  browser=await chromium.launch({executablePath,headless:true});fs.mkdirSync('output/fleet-speed',{recursive:true});fs.mkdirSync('output/playwright',{recursive:true});
  for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
    const before=loadAutomationSettings('speed-browser');
    Object.assign(before.settings.cityWar,{fleetStrategies:{},defenceFleetIds:['2远征船'],targetMode:'alliance',targetPriority:'fewestAllied',cityRefs:[],defenceTargetMode:'alliance',defenceTargetPriority:'fewestAllied',defenceCityRefs:[]});
    before.settings.fleetSpeed.enabled=false;before.settings.resources.allowDiamonds=false;
    before.settings.resources.diamondDailyLimit=2000;
    Object.assign(before.settings.fleetSpeed.fleets[0],{repair:true,march:true,repairDailyDiamonds:0,marchDailyDiamonds:0});
    saveAutomationSettings('speed-browser',before.settings,{revision:before.revision});
    const context=await browser.newContext({viewport,deviceScaleFactor:1}),page=await context.newPage();
    let settingsWrites=0;
    page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/settings')settingsWrites++;});
    page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
    await page.locator('#tabs [data-tab=settings]').click();await page.locator('[data-config-tab=world]').click();await page.locator('[data-config-group=cityWar]').click();
    const city=page.locator('#config-group-cityWar');
    const globals=page.locator('#config-section-cityWar-targetMode');
    const globalSummary=globals.locator(':scope > summary');
    assert.equal(await page.locator('#config-field-fleetSpeed-dailyDiamondLimit').count(),0,'城战加速合计上限已移除');
    assert.equal(Object.hasOwn(loadAutomationSettings('speed-browser').settings.fleetSpeed,'dailyDiamondLimit'),false);
    assert.equal(await city.locator('[data-config-number$="MaxDiamonds"]').count(),0,'维修和派遣不再显示单次或整段航程上限');
    for(const fleet of loadAutomationSettings('speed-browser').settings.fleetSpeed.fleets){
      assert.equal(Object.hasOwn(fleet,'repairMaxDiamonds'),false);assert.equal(Object.hasOwn(fleet,'marchMaxDiamonds'),false);
    }
    assert.equal(await city.locator('details.config-field-section').count(),1);
    assert.equal(await globals.evaluate(section=>section.tagName),'DETAILS');
    assert.equal(await globalSummary.count(),1);
    assert.equal(await page.locator('#config-field-cityWar-targetMode').isVisible(),false,'全局策略默认收起');
    assert.equal(await page.locator('#config-field-cityWar-defenceTargetMode').isVisible(),false);
    assert.equal(await globals.evaluate(section=>!!(document.getElementById('config-field-fleetSpeed-enabled').compareDocumentPosition(section)&Node.DOCUMENT_POSITION_FOLLOWING)),true,'全局策略位于逐队加速总开关之后');
    assert.equal(await page.locator('#config-fields .config-disclosure[aria-expanded=true]').count(),0);
    assert.equal(await page.locator('[id^=config-field-fleetSpeed-fleets-2-]').count(),0);
    await city.screenshot({path:path.resolve('output/fleet-speed/default-levels-'+name+'.png')});
    const participants=city.locator('[data-config-branch="cityWar.fleetIds"]');
    const speedMaster=page.locator('#config-field-fleetSpeed-enabled');
    assert.equal(await speedMaster.getAttribute('aria-label'),'维修及派遣钻石加速总开关');
    assert.equal(await participants.evaluate(node=>!!(document.getElementById('config-field-fleetSpeed-enabled').compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)),true,'加速总开关在逐队配置前展示');
    const participantDisclosure=participants.locator(':scope > .config-row .config-disclosure');
    const fleet=number=>city.locator('.config-war-fleet[data-fleet-id="'+number+'远征船"]');
    const disclosure=number=>fleet(number).locator('.config-war-role .config-disclosure');
    const role=number=>fleet(number).locator('.config-war-role select');
    const strategy=(number,key)=>page.locator('[id="config-field-cityWar-fleetStrategies-'+number+'远征船-'+key+'"]');
    const error=(number,key)=>page.locator('[id="config-field-cityWar-fleetStrategies-'+number+'远征船-'+key+'-error"]');
    const saved=()=>page.locator('#config-state').filter({hasText:'配置已同步'}).waitFor();
    const open=async number=>{
      if(await participantDisclosure.getAttribute('aria-expanded')!=='true')await participantDisclosure.click();
      if(await disclosure(number).getAttribute('aria-expanded')!=='true')await disclosure(number).click();
    };
    const close=async number=>{if(await disclosure(number).getAttribute('aria-expanded')==='true')await disclosure(number).click();};
    assert.equal(await city.getByRole('button',{name:'配置策略',exact:true}).count(),0);
    assert.equal(await page.locator('#config-field-cityWar-targetMode, #config-field-cityWar-defenceTargetMode, #config-field-cityWar-targetPriority, #config-field-cityWar-defenceTargetPriority, #config-field-cityWar-cityRefs, #config-field-cityWar-defenceCityRefs').count(),6);
    assert.equal(await globalSummary.textContent(),'全局策略');
    assert.equal(await fleet(1).count(),1);assert.equal(await fleet(2).count(),1);assert.equal(await fleet(3).count(),0);
    await saved();const writesBefore=settingsWrites;
    await globalSummary.click();
    assert.equal(await page.locator('#config-field-cityWar-targetMode').isVisible(),true);
    assert.equal(await page.locator('#config-field-cityWar-defenceTargetMode').isVisible(),true);
    await globalSummary.press('Enter');
    assert.equal(await page.locator('#config-field-cityWar-targetMode').isVisible(),false,'Enter 可以收起全局策略');
    await globalSummary.press('Space');
    assert.equal(await page.locator('#config-field-cityWar-targetMode').isVisible(),true,'空格可以展开全局策略');
    await globalSummary.click();
    assert.equal(await participants.locator('#config-field-cityWar-defenceFleetIds').count(),1);
    assert.equal(await participantDisclosure.count(),1);
    assert.equal(await participantDisclosure.textContent(),'展开设置');
    assert.equal(await participantDisclosure.getAttribute('aria-expanded'),'false');
    assert.equal(await participants.locator('#config-field-cityWar-defenceFleetIds').isVisible(),false);
    await participantDisclosure.click();
    assert.equal(await participantDisclosure.textContent(),'收起设置');
    assert.equal(await participantDisclosure.getAttribute('aria-expanded'),'true');
    assert.equal(await participants.locator('#config-field-cityWar-defenceFleetIds').isVisible(),true);
    assert.equal(await page.locator('#config-field-cityWar-defenceFleetIds-label').isVisible(),false);
    assert.equal(await city.locator('[id^="config-section-fleetSpeed-fleets-"]').count(),0);
    for(const number of [1,2])for(const mode of ['repair','march']){
      const selector='#config-field-fleetSpeed-fleets-'+(number-1)+'-'+mode;
      assert.equal(await page.locator(selector).count(),1,'每队加速开关只有一个入口');
      assert.equal(await fleet(number).locator(selector).count(),1,'加速开关属于对应舰队');
      assert.equal(await fleet(number).locator(selector).isVisible(),false,'逐队设置默认收起');
    }
    await open(1);assert.equal(await strategy(1,'strategyMode').inputValue(),'global');
    assert.equal(await strategy(1,'targetMode').isVisible(),false);
    await close(1);assert.equal(await strategy(1,'targetMode').isVisible(),false);
    await page.waitForTimeout(700);assert.equal(settingsWrites,writesBefore,'展开收起不写入配置');

    // 保存的逐队开关不会绕过显式关闭的总开关；每项阻断都可定位到相应配置。
    await open(1);
    const speedStatus=mode=>page.locator('#config-field-fleetSpeed-fleets-0-'+mode+'-status');
    const returnToCity=async()=>{await page.locator('[data-config-tab=world]').click();await page.locator('[data-config-group=cityWar]').click();};
    for(const mode of ['repair','march'])assert.match(await speedStatus(mode).textContent(),/尚未生效：.*钻石加速总开关已关闭/);
    await fleet(1).screenshot({path:path.resolve('output/fleet-speed/blocked-'+name+'.png')});
    await speedStatus('repair').getByRole('button').click();
    assert.equal(await speedMaster.evaluate(node=>node===document.activeElement),true);
    assert.equal(await speedMaster.isChecked(),false,'前往设置只定位，不自动授权');
    await page.waitForTimeout(700);assert.equal(settingsWrites,writesBefore);
    await speedMaster.check();await saved();
    assert.match(await speedStatus('repair').textContent(),/全局自动钻石消耗已关闭/);
    await speedStatus('repair').getByRole('button').click();
    const globalDiamonds=page.locator('#config-field-resources-allowDiamonds');
    assert.equal(await globalDiamonds.evaluate(node=>node===document.activeElement),true);
    assert.equal(await globalDiamonds.isChecked(),false);
    await globalDiamonds.check();await saved();
    await returnToCity();
    // 全局预算与逐队预算各自生效，且修正提示会立即更新。
    await page.locator('[data-config-tab=base]').click();await page.locator('[data-config-family=foundation]').click();
    await page.locator('[data-config-group=resources]').click();
    const globalBudget=page.locator('#config-field-resources-diamondDailyLimit');
    const resourceDisclosure=page.locator('[data-config-branch="resources.allowDiamonds"] > .config-row .config-disclosure');
    if(await resourceDisclosure.getAttribute('aria-expanded')!=='true')await resourceDisclosure.click();
    await globalBudget.fill('0');await globalBudget.blur();await saved();await returnToCity();
    assert.match(await speedStatus('repair').textContent(),/全局每日钻石预算为 0/);
    await speedStatus('repair').getByRole('button').click();
    assert.equal(await globalBudget.evaluate(node=>node===document.activeElement),true);
    await globalBudget.fill('2000');await globalBudget.blur();await saved();await returnToCity();
    for(const [mode,dailyLimit] of [['repair',100],['march',300]]){
      assert.match(await speedStatus(mode).textContent(),/本项每日钻石上限为 0/);
      await speedStatus(mode).getByRole('button').click();
      const daily=page.locator('#config-field-fleetSpeed-fleets-0-'+mode+'DailyDiamonds');
      assert.equal(await daily.evaluate(node=>node===document.activeElement),true);
      await daily.fill(String(dailyLimit));await daily.blur();await saved();
      assert.equal(loadAutomationSettings('speed-browser').settings.fleetSpeed.fleets[0][mode+'DailyDiamonds'],dailyLimit);
      assert.equal(await speedStatus(mode).isVisible(),false,'允许加速时不显示常态说明');
      assert.equal(await speedStatus(mode).getByRole('button').isVisible(),false);
      assert.doesNotMatch(await page.locator('#config-field-fleetSpeed-fleets-0-'+mode+'DailyDiamonds-help').textContent(),/城战加速日上限|本项单次上限/);
    }
    const cityMaster=page.locator('#config-field-cityWar-enabled');
    await cityMaster.uncheck();await saved();
    for(const mode of ['repair','march'])assert.match(await speedStatus(mode).textContent(),/城战接续总开关已关闭/);
    await cityMaster.check();await speedMaster.uncheck();await saved();
    await page.reload();await page.locator('#tabs [data-tab=settings]').click();await returnToCity();await open(1);
    assert.equal(await speedMaster.isChecked(),false,'刷新保留显式关闭');
    for(const [mode,dailyLimit] of [['repair',100],['march',300]]){
      assert.equal(await page.locator('#config-field-fleetSpeed-fleets-0-'+mode).isChecked(),true,'暂停保留逐队选项');
      assert.match(await speedStatus(mode).textContent(),/钻石加速总开关已关闭/);
      assert.equal(await page.locator('#config-field-fleetSpeed-fleets-0-'+mode+'DailyDiamonds').inputValue(),String(dailyLimit),'刷新保留维修与派遣各自的每日上限');
      assert.equal(await page.locator('#config-field-fleetSpeed-fleets-0-'+mode+'MaxDiamonds').count(),0);
    }
    await speedMaster.check();await saved();await close(1);

    // 每队编辑各自的攻守目标，返回已保存值后立即清理旧错误。
    for(const [number,mode,refs] of [[1,'targetMode','cityRefs'],[2,'defenceTargetMode','defenceCityRefs']]){
      await open(number);assert.equal(await strategy(number,'strategyMode').inputValue(),'global');
      await strategy(number,'strategyMode').selectOption('custom');await saved();
      await strategy(number,mode).selectOption('selected');await error(number,refs).waitFor({state:'visible'});
      assert.match(await error(number,refs).textContent(),/请至少选择一座/);
      await strategy(number,mode).selectOption('alliance');
      assert.equal(await error(number,refs).isVisible(),false);assert.equal(await strategy(number,refs).isVisible(),false);
      assert.equal(await page.locator('#config-message').isVisible(),false);await saved();
    }
    // 自动保存发现隐藏错误时，重新展开对应舰队并显示可修正的字段。
    await open(1);await strategy(1,'targetMode').selectOption('selected');await close(1);
    await error(1,'cityRefs').waitFor({state:'visible'});
    assert.equal(await disclosure(1).getAttribute('aria-expanded'),'true');
    await strategy(1,'targetMode').selectOption('alliance');await saved();

    // 同为进攻的两队保存不同来源、城市与优先规则，修改一队不覆盖另一队。
    await open(2);await role(2).selectOption('attack');await saved();
    await strategy(2,'targetPriority').selectOption('original');await saved();
    await strategy(2,'targetPriority').selectOption('fewestAllied');await saved();
    await open(1);await strategy(1,'targetPriority').selectOption('original');
    await strategy(1,'targetMode').selectOption('selected');
    const cities=strategy(1,'cityRefs');await cities.locator('summary').click();
    await cities.getByRole('checkbox',{name:/城市甲/}).check();await cities.locator('summary').click();await saved();
    assert.equal(await strategy(2,'targetMode').inputValue(),'alliance');
    assert.equal(await strategy(2,'targetPriority').inputValue(),'fewestAllied');
    let policies=loadAutomationSettings('speed-browser').settings.cityWar.fleetStrategies;
    assert.equal(policies['1远征船'].targetMode,'selected');assert.deepEqual(policies['1远征船'].cityRefs,['1:1']);
    assert.equal(policies['1远征船'].targetPriority,'original');
    assert.equal(policies['2远征船']?.targetMode??'alliance','alliance');
    assert.equal(loadAutomationSettings('speed-browser').settings.cityWar.targetMode,'alliance','逐队修改不覆盖旧共享值');

    // 同一队切换职责只显示对应策略，回到进攻时恢复该队的城市与优先规则。
    await role(1).selectOption('defence');await strategy(1,'defenceTargetMode').waitFor({state:'visible'});
    assert.equal(await strategy(1,'targetMode').isVisible(),false);
    assert.equal(await strategy(1,'defenceTargetMode').inputValue(),'alliance');
    assert.equal(await strategy(1,'defenceTargetPriority').inputValue(),'fewestAllied');
    await strategy(1,'defenceTargetMode').selectOption('selected');
    const defenceCities=strategy(1,'defenceCityRefs');await defenceCities.locator('summary').click();
    await defenceCities.getByRole('checkbox',{name:/城市乙/}).check();await defenceCities.locator('summary').click();await saved();
    await role(1).selectOption('attack');await saved();
    assert.equal(await strategy(1,'targetMode').inputValue(),'selected');
    assert.equal(await strategy(1,'targetPriority').inputValue(),'original');
    assert.match(await strategy(1,'cityRefs').locator('summary').textContent(),/城市甲/);
    assert.equal(await strategy(2,'targetMode').inputValue(),'alliance');
    assert.equal(await strategy(2,'targetPriority').inputValue(),'fewestAllied');
    await page.reload();await page.locator('#tabs [data-tab=settings]').click();
    await page.locator('[data-config-tab=world]').click();await page.locator('[data-config-group=cityWar]').click();
    assert.equal(await disclosure(1).getAttribute('aria-expanded'),'false');
    await open(1);await open(2);
    assert.equal(await strategy(1,'targetMode').inputValue(),'selected');
    assert.equal(await strategy(1,'targetPriority').inputValue(),'original');
    assert.match(await strategy(1,'cityRefs').locator('summary').textContent(),/城市甲/);
    assert.equal(await strategy(2,'targetMode').inputValue(),'alliance');
    assert.equal(await strategy(2,'targetPriority').inputValue(),'fewestAllied');
    await role(1).selectOption('defence');await saved();
    assert.equal(await strategy(1,'defenceTargetMode').inputValue(),'selected');
    assert.match(await strategy(1,'defenceCityRefs').locator('summary').textContent(),/城市乙/);
    await role(1).selectOption('attack');await saved();
    // 一队独立、一队跟随全局；全局变更即时生效，不覆盖任何队伍缓存的独立配置。
    await strategy(2,'targetPriority').selectOption('original');await saved();
    const ownSecond=structuredClone(loadAutomationSettings('speed-browser').settings.cityWar.fleetStrategies['2远征船']);
    await strategy(2,'strategyMode').selectOption('global');await saved();
    assert.equal(await strategy(2,'targetMode').isVisible(),false);
    await globalSummary.click();
    await page.locator('#config-field-cityWar-targetMode').selectOption('selected');
    const globalCities=page.locator('#config-field-cityWar-cityRefs');await globalCities.locator('summary').click();
    await globalCities.getByRole('checkbox',{name:/城市乙/}).check();await globalCities.locator('summary').click();await saved();
    const configured=loadAutomationSettings('speed-browser').settings.cityWar;
    assert.deepEqual(cityWarFleetStrategy(configured,'1远征船').cityRefs,['1:1']);
    assert.deepEqual(cityWarFleetStrategy(configured,'2远征船').cityRefs,['1:2']);
    assert.equal(cityWarFleetStrategy(configured,'2远征船').targetMode,'selected');
    assert.equal(cityWarFleetStrategy(configured,'2远征船').targetPriority,'fewestAllied');
    assert.equal(configured.fleetStrategies['2远征船'].targetMode,ownSecond.targetMode);
    assert.equal(configured.fleetStrategies['2远征船'].targetPriority,ownSecond.targetPriority);
    assert.deepEqual(configured.fleetStrategies['2远征船'].cityRefs,ownSecond.cityRefs);
    assert.equal(await fleet(2).locator('.config-war-inherited').count(),0,'跟随全局不再显示重复策略说明');
    assert.equal(await strategy(1,'targetMode').inputValue(),'selected');
    assert.match(await strategy(1,'cityRefs').locator('summary').textContent(),/城市甲/);
    await page.reload();await page.locator('#tabs [data-tab=settings]').click();
    await page.locator('[data-config-tab=world]').click();await page.locator('[data-config-group=cityWar]').click();
    await open(1);await open(2);
    assert.equal(await strategy(1,'strategyMode').inputValue(),'custom');
    assert.equal(await strategy(2,'strategyMode').inputValue(),'global');
    assert.equal(await strategy(2,'targetMode').isVisible(),false);
    await strategy(2,'strategyMode').selectOption('custom');await saved();
    assert.equal(await strategy(2,'targetMode').inputValue(),ownSecond.targetMode);
    assert.equal(await strategy(2,'targetPriority').inputValue(),ownSecond.targetPriority);
    assert.deepEqual(loadAutomationSettings('speed-browser').settings.cityWar.fleetStrategies['2远征船'].cityRefs,ownSecond.cityRefs);
    await strategy(2,'strategyMode').selectOption('global');await saved();
    await globalSummary.click();
    await globals.screenshot({path:path.resolve('output/playwright/city-war-global-strategy-'+name+'.png')});
    await fleet(1).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.resolve('output/fleet-speed/fleet-strategies-'+name+'.png'),fullPage:true});
    await page.locator('#config-field-cityWar-defenceFleetIds').screenshot({path:path.resolve('output/playwright/city-war-fleet-strategies-'+name+'.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const fleetSection=fleet(1);
    const branch=mode=>fleetSection.locator('[data-config-branch="fleetSpeed.fleets.0.'+mode+'"]');
    const expand=async mode=>{await branch(mode).locator(':scope > .config-row .config-disclosure').click();};
    await open(1);
    await expand('repair');await expand('march');
    const repair=page.locator('#config-field-fleetSpeed-fleets-0-repairSmartSave'),march=page.locator('#config-field-fleetSpeed-fleets-0-marchSmartSave');
    assert.equal(await repair.isVisible(),true);assert.equal(await march.isVisible(),true);
    assert.equal(await page.locator('#config-field-fleetSpeed-fleets-0-repairSmartWaitSeconds').isVisible(),false);
    if(name==='desktop'){
      await repair.uncheck();assert.equal(await march.isChecked(),true);
      await expand('marchSmartSave');await page.locator('#config-field-fleetSpeed-fleets-0-marchSmartWaitSeconds').fill('3');
      await page.locator('#config-field-fleetSpeed-fleets-0-marchSmartWaitSeconds').blur();
      await page.waitForFunction(()=>document.querySelector('#config-state')?.textContent.includes('配置已同步'));
      const saved=loadAutomationSettings('speed-browser').settings.fleetSpeed.fleets;
      assert.equal(saved[0].repairSmartSave,false);assert.equal(saved[0].marchSmartSave,true);assert.equal(saved[0].marchSmartWaitSeconds,3);
      assert.equal(saved[1].repairSmartSave,true);assert.equal(saved[1].marchSmartWaitSeconds,5);
      await page.reload();await page.locator('#tabs [data-tab=settings]').click();await page.locator('[data-config-tab=world]').click();await page.locator('[data-config-group=cityWar]').click();
      assert.equal(await city.locator('details.config-field-section').count(),1);
      assert.equal(await page.locator('#config-field-cityWar-targetMode').isVisible(),false,'刷新后全局策略默认收起');
      await open(1);
      await expand('repair');await expand('march');
      assert.equal(await repair.isChecked(),false);assert.equal(await march.isChecked(),true);
      // 开启功能与展开配置是两件事；重新启用维修不会自动显示其参数。
      await expand('repair');const enable=page.locator('#config-field-fleetSpeed-fleets-0-repair');await enable.uncheck();await enable.check();
      assert.equal(await repair.isVisible(),false);await expand('repair');
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await fleetSection.scrollIntoViewIfNeeded();await page.screenshot({path:path.resolve('output/fleet-speed/independent-'+name+'.png'),fullPage:true});
    await context.close();console.log('通过：'+name+' 全局/独立策略切换、缓存恢复、逐队攻守、隐藏错误定位、保存刷新及独立省钻，无横向溢出');
  }
  // 已保存的旧目标不再出现在目录中时，隐藏舰队和非当前职责都必须能就地修正。
  for(const [number,field,unavailable] of [[3,'cityRefs',true],[1,'defenceCityRefs',false]]){
    const before=loadAutomationSettings('speed-browser');
    const policy={targetMode:'alliance',targetPriority:'fewestAllied',cityRefs:[],
      defenceTargetMode:'alliance',defenceTargetPriority:'fewestAllied',defenceCityRefs:[]};
    policy[field]=['1:99'];
    before.settings.cityWar.fleetStrategies={[number+'远征船']:policy};
    before.settings.cityWar.defenceFleetIds=[];
    saveAutomationSettings('speed-browser',before.settings,{revision:before.revision});
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
    await page.locator('#tabs [data-tab=settings]').click();await page.locator('[data-config-tab=world]').click();
    await page.locator('[data-config-group=cityWar]').click();
    const participantDisclosure=page.locator('[data-config-branch="cityWar.fleetIds"] > .config-row .config-disclosure');
    const roles=page.locator('#config-field-cityWar-defenceFleetIds');
    const fleet=roles.locator('.config-war-fleet[data-fleet-id="'+number+'远征船"]');
    const disclosure=fleet.locator('.config-war-role .config-disclosure');
    const picker=page.locator('[id="config-field-cityWar-fleetStrategies-'+number+'远征船-'+field+'"]');
    const error=page.locator('[id="config-field-cityWar-fleetStrategies-'+number+'远征船-'+field+'-error"]');
    assert.equal(await participantDisclosure.getAttribute('aria-expanded'),'false');
    assert.equal(await roles.isVisible(),false);assert.equal(await fleet.isVisible(),false);assert.equal(await picker.isVisible(),false);
    const interval=page.locator('#config-field-cityWar-checkEverySeconds');
    await interval.fill(String(Number(await interval.inputValue())+1));
    await error.waitFor({state:'visible'});
    assert.match(await error.textContent(),/不存在的选项/);
    assert.equal(await participantDisclosure.getAttribute('aria-expanded'),'true','隐藏的逐队错误自动展开参与舰队设置');
    assert.equal(await fleet.isVisible(),true);assert.equal(await disclosure.getAttribute('aria-expanded'),'true');
    assert.equal(await fleet.locator('.config-war-role select').isDisabled(),unavailable);
    assert.equal(await fleet.locator('.config-war-role select').inputValue(),'attack');
    if(unavailable)assert.match(await fleet.locator('.config-order-name').textContent(),/未同步/);
    await picker.locator('summary').click();
    assert.equal(await picker.getByRole('checkbox',{name:/1:99/}).isChecked(),true);
    // 用键盘在控件仍持有焦点时清空，验证隐藏之后焦点回到可见入口。
    const clear=picker.getByRole('button',{name:'清空选择',exact:true});await clear.focus();
    await page.keyboard.press('Enter');
    await picker.waitFor({state:'hidden'});assert.equal(await error.isVisible(),false);
    const focusTarget=unavailable?roles:disclosure;
    assert.equal(await focusTarget.evaluate(node=>node===document.activeElement),true);
    assert.equal(await fleet.isVisible(),!unavailable);
    await page.locator('#config-state').filter({hasText:'配置已同步'}).waitFor();
    assert.deepEqual(loadAutomationSettings('speed-browser').settings.cityWar.fleetStrategies[number+'远征船'][field],[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await context.close();
    console.log('通过：'+(unavailable?'未同步舰队':'非当前攻守职责')+'的过期城市策略可展开修正，清空后恢复显隐与焦点');
  }
  assert.deepEqual(errors,[]);assert.equal(session.client,null);assert.equal(session.loop.running,false);
  console.log('通过：全程零游戏连接与写入');
}finally{
  await browser?.close();app.server.closeAllConnections();await app.close();
  if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('cw-speed-browser-'))throw Error('拒绝清理意外目录');
  fs.rmSync(directory,{recursive:true,force:true});
}
