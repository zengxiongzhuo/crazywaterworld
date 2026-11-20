// 原生滑块没有已填充轨道，用变量画出 shadcn Slider 的进度。
function setMapZoomInput(value){const input=$('world-map-zoom');input.value=String(value);input.style.setProperty('--range-fill',(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min))*100+'%');}
let worldMapAutoRefresh=true;
let worldMapOwner=null,worldMapData=null,worldMapSerial=0,worldMapLoading=false,worldMapPainted=null,worldMapSelected=null;
let worldMapView={x:0,y:0,zoom:1},worldMapDrag=null,worldMapDraggedAt=0,worldMapAllNames=false;
let worldMapReceivedAt=0,worldMapLastAttempt=0,worldMapRefreshEvery=10,worldMapMovingNodes=[],worldMapJourneyNodes=[],worldMapDrawnPoints=[];
let worldCityAction=null;
let worldMapPopupPlacement=null;
let worldMapOverviewRead=null;
const worldCitySending=new Set();
const worldFleetSpeedBusy=new Set();
const mapModalScreen=matchMedia('(max-width:700px), (hover:none) and (pointer:coarse)');
const worldLayerNames={regions:'领地',cities:'城池',cityWar:'城战',fleets:'我的舰队',traffic:'已同步行军',fields:'资源田',treasure:'货轮',pirates:'海盗',radar:'情报',boss:'Boss'};
const worldLayerColors={regions:'#69b3a5',cities:'#526f7a',cityWar:'#b5483e',fleets:'#2866cc',traffic:'#8653a0',fields:'#4b91b7',treasure:'#c18a12',pirates:'#bc4747',radar:'#b7672d',boss:'#8653a0'};
const worldLayers=new Set(['regions','cities','cityWar','fleets','traffic','treasure','radar','boss']);
const mapNode=(tag,attrs={})=>{const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))node.setAttribute(k,String(v));return node;};
bindConsoleSlice('worldMap', { worldMapOwner, worldMapData, worldMapLoading, worldMapSelected, worldMapView, worldMapAllNames, worldMapReceivedAt, worldMapAutoRefresh, worldMapRefreshEvery }, state => {
  worldMapOwner = state.worldMapOwner;
  worldMapData = state.worldMapData;
  worldMapLoading = state.worldMapLoading;
  worldMapSelected = state.worldMapSelected;
  worldMapView = state.worldMapView;
  worldMapAllNames = state.worldMapAllNames;
  worldMapReceivedAt = state.worldMapReceivedAt;
  worldMapAutoRefresh = state.worldMapAutoRefresh;
  worldMapRefreshEvery = state.worldMapRefreshEvery;
});

function resetWorldMap(){
 closeWorldMapDetail();
 worldMapOverviewRead=null;
 if($('modal').open && $('m-body').querySelector('[data-fleet-speed-confirm]'))closeModal();
 setFleetSpeedFeedback('');
 setConsoleValue('worldMap', 'worldMapOwner', null);setConsoleValue('worldMap', 'worldMapData', null);worldMapPainted=null;setConsoleValue('worldMap', 'worldMapSelected', null);worldMapSerial++;setConsoleValue('worldMap', 'worldMapLoading', false);
 setConsoleValue('worldMap', 'worldMapReceivedAt', 0);worldMapLastAttempt=0;worldMapMovingNodes=[];worldMapJourneyNodes=[];worldMapDrawnPoints=[];
 $('world-map-refresh').disabled=false;for(const id of ['world-map','world-map-fleets','world-map-wars','world-map-treasures','world-map-resources','world-map-layers','world-map-legend','world-map-state-legend','world-map-notes'])clear($(id));
 $('world-map-time').textContent='尚未读取';$('world-map-detail').hidden=true;setConsoleValue('worldMap', 'worldMapView', {x:0,y:0,zoom:1});setMapZoomInput(1);
}
const mapNumber=value=>Number.isSafeInteger(value)&&value>=0?fmt(value):'未同步';
const mapElapsed=()=>worldMapReceivedAt?(Date.now()-worldMapReceivedAt)/1000:0;
const mapStale=()=>mapElapsed()>Math.max(30,worldMapRefreshEvery*3);
const mapServerNow=()=>worldMapData?worldMapData.checkedAt+Math.min(mapElapsed(),Math.max(30,worldMapRefreshEvery*3)):Date.now()/1000;
function mapDuration(seconds){if(!Number.isFinite(seconds))return '时间未同步';seconds=Math.max(0,Math.ceil(seconds));const minutes=Math.floor(seconds/60);return minutes?minutes+'分'+seconds%60+'秒':seconds+'秒';}
function mapJourney(journey){if(!journey)return '—';const remaining=Math.max(0,Math.ceil(journey.endAt-mapServerNow()));return journey.from+' → '+journey.to+'（'+(mapStale()?'待同步':remaining?'剩余'+mapDuration(remaining):'到达待同步')+'）';}
function journeyNode(journey){const node=el('span','world-journey',mapJourney(journey));if(journey){node.title='全程 '+mapDuration(journey.endAt-journey.startAt);worldMapJourneyNodes.push({node,journey});}return node;}
function locateOwnFleet(fleet){
 const point=worldMapData?.points.find(p=>p.key==='fleet-'+fleet.id);
 if(!point)return;
 if(!worldLayers.has('fleets'))$('world-map-layers').querySelector('input[aria-label="我的舰队图层"]')?.click();
 const position=mapMotionPosition(point,mapServerNow());
 setConsoleValue('worldMap','worldMapView',{x:position.x,y:position.y,zoom:4});
 setMapZoomInput(4);
 $('world-map-scroll').scrollIntoView({block:'center',behavior:'instant'});
 void showWorldMapTarget(point,false,'locate');
}
function setFleetSpeedFeedback(message){
 const feedback=$('world-fleet-speed-feedback');
 feedback.textContent=message;
 feedback.hidden=!message;
}
function fleetSpeedTargetCurrent(account,fleet){
 const latest=worldMapData?.fleets.find(row=>row.id===fleet.id);
 return account===current && account===worldMapOwner && snapshot.connected && !snapshot.paused &&
  !disconnected.has(account) && JSON.stringify(latest?.speedTarget)===JSON.stringify(fleet.speedTarget);
}
function updateFleetSpeedButtons(){
 for(const button of $('world-map-fleets').querySelectorAll('[data-fleet-speed]')){
  button.disabled=worldFleetSpeedBusy.has(current);
 }
}
async function submitFleetSpeed(account,fleet,quote,label){
 if(worldFleetSpeedBusy.has(account) || current!==account)return;
 if(!fleetSpeedTargetCurrent(account,fleet) || Date.now()>=quote.expiresAt){
  setFleetSpeedFeedback('舰队状态或报价已变化，请重新选择加速。');
  return;
 }
 worldFleetSpeedBusy.add(account);
 updateFleetSpeedButtons();
 setFleetSpeedFeedback(fleet.name+' · '+label+'中…');
 try{
  const result=await call('/api/world/fleet-speed/action?account='+encodeURIComponent(account),{
   method:'POST',body:JSON.stringify({confirm:true,token:quote.token,confirmedCost:quote.maxCost})
  });
  if(current===account && worldMapOwner===account)setFleetSpeedFeedback(result.message);
 }catch(error){
  if(current===account && worldMapOwner===account)setFleetSpeedFeedback(error.message);
 }finally{
  if(current===account && worldMapOwner===account){
   // 已在途的地图读可能早于加速回执，等它落地后再取最终舰队状态。
   if(worldMapOverviewRead)await worldMapOverviewRead.catch(()=>{});
   if(current===account && worldMapOwner===account)await refreshWorldMap();
  }
  worldFleetSpeedBusy.delete(account);
  if(current===account)updateFleetSpeedButtons();
 }
}
async function previewFleetSpeed(account,fleet,label){
 if(worldFleetSpeedBusy.has(account) || !fleetSpeedTargetCurrent(account,fleet))return;
 worldFleetSpeedBusy.add(account);
 updateFleetSpeedButtons();
 setFleetSpeedFeedback('正在核对'+fleet.name+'的加速费用…');
 try{
  const quote=await call('/api/world/fleet-speed/preview?account='+encodeURIComponent(account),{
   method:'POST',body:JSON.stringify(fleet.speedTarget)
  });
  if(current!==account || worldMapOwner!==account)return;
  if(!fleetSpeedTargetCurrent(account,fleet)){setFleetSpeedFeedback('舰队状态已变化，请重新选择加速。');return;}
  if(!quote.token || !Number.isSafeInteger(quote.maxCost) || quote.maxCost<0){
   setFleetSpeedFeedback(quote.reason || '无法取得加速费用，请刷新舰队后重试。');return;
  }
  setFleetSpeedFeedback('');
  const prompt=el('p','','将本次'+(fleet.speedTarget.mode==='march'?'行军':'维修')+'加速至完成，最多消耗 '+fmt(quote.maxCost)+' 钻石。');
  prompt.dataset.fleetSpeedConfirm='true';
  openConfirm(label+' · '+fleet.name,[prompt],()=>submitFleetSpeed(account,fleet,quote,label),'确认加速');
 }catch(error){
  if(current===account && worldMapOwner===account)setFleetSpeedFeedback(error.message);
 }finally{
  worldFleetSpeedBusy.delete(account);
  if(current===account)updateFleetSpeedButtons();
 }
}
function worldFleetSpeedButton(account,fleet){
 const target=fleet.speedTarget;
 if(target?.buildingId!==fleet.id || !['march','repair'].includes(target?.mode))return '—';
 const label=target.mode==='march'?'派遣加速':'维修加速',button=smallButton(label);
 button.dataset.fleetSpeed=fleet.id;
 button.disabled=worldFleetSpeedBusy.has(account);
 button.onclick=()=>previewFleetSpeed(account,fleet,label);
 return button;
}
function mapFacts(panel,entries){
 const list=el('dl','world-city-facts');
 for(const [label,value]of entries)list.append(el('dt','',label),el('dd','',value));
 panel.append(list);
 return list;
}
function worldFleetCard(point,showName=true){
 const card=el('article','world-fleet-card');
 card.setAttribute('aria-label',point.name);
 if(showName)card.append(el('h4','',point.name));
 const fleet=point.fleetInfo;
 if(fleet){
  mapFacts(card,[['状态',fleet.state||'未同步'],['耐久',mapNumber(fleet.durability)+'/'+mapNumber(fleet.maxDura)],['任务',fleet.task||'未同步']]);
 }else if(point.detail)card.append(el('p','',point.detail));
 const journey=fleet?.journey??point.motion;
 if(journey)card.append(journeyNode(journey));
 return card;
}
function worldFleetCards(fleets){
 const grid=el('div','world-fleet-grid');
 for(const fleet of fleets)grid.append(worldFleetCard(fleet));
 return grid;
}
function paintWorldCityFacts(panel,point){
 const city=point.cityInfo,declared=city.declared??[],fighters=city.fighters??[];
 const entries=[['当前归属',city.owner],['城战',city.status]];
 if(city.assemble)entries.push(['集结','本盟集结城市']);
 if(declared.length)entries.push(['宣战',declared.map(row=>row.attack+' → '+row.defence).join('；')]);
 if(declared.length || fighters.length || city.attack>0 || city.priorityAttack>0){
  entries.push(['进攻','优先 '+mapNumber(city.priorityAttack)+' + 排队 '+mapNumber(city.attack)]);
 }
 entries.push(['驻防','优先 '+mapNumber(city.priorityDefence)+' + 普通 '+mapNumber(city.defence)]);
 const facts=mapFacts(panel,entries);
 if(fighters.length){
  panel.append(table(['交战位','进攻方','防守方'],fighters.map((row,i)=>[String(i+1),row.attack,row.defence])));
 }
 const radius=12*mapViewBox().width/Math.max(1,$('world-map-scroll').clientWidth),now=mapServerNow();
 const nearby=worldMapData.points.filter(fleet=>{
  if(fleet.layer!=='fleets' && fleet.layer!=='traffic')return false;
  const {x,y}=mapMotionPosition(fleet,now);
  return Math.hypot(x-point.x,y-point.y)<radius;
 });
 if(!nearby.length)return;
 if(nearby.length>1 && entries.length===3)facts.classList.add('world-city-summary');
 const section=el('section','world-nearby-fleets');
 section.append(el('h3','','附近舰队 · '+nearby.length),worldFleetCards(nearby));
 panel.append(section);
}
function paintWorldFuel(data){
 const box=clear($('world-map-resources')),usage=data.fuelUsage,stock=usage?.stock??data.resources?.find(r=>r.id==='汽油')?.value??null,summary=el('div','world-fuel-summary');
 for(const [label,value]of [['库存',stock],['今日耗油',usage?.confirmed],['待确认',usage?.pending]]){const item=el('span','',label);item.append(el('strong','',mapNumber(value)));summary.append(item);}box.append(summary);
 if(usage?.activities)box.append(table(['活动','今日已确认','待确认'],usage.activities.map(r=>[r.name,mapNumber(r.confirmed),mapNumber(r.pending)])));
 box.append(el('p','dim','统计本工具记录的派遣与维修用油。万吨用量已含维修。'));
}
function mapViewBox(){
 const box=$('world-map-scroll'),data=worldMapData,ratio=Math.max(.1,box.clientWidth/Math.max(1,box.clientHeight));
 const width=Math.max(data.width,data.height*ratio)/worldMapView.zoom,height=width/ratio;
 mutateConsoleValue('worldMap', 'worldMapView', nextStateValue => (nextStateValue.x=width>=data.width?data.width/2:Math.max(width/2,Math.min(data.width-width/2,worldMapView.x))));
 mutateConsoleValue('worldMap', 'worldMapView', nextStateValue => (nextStateValue.y=height>=data.height?data.height/2:Math.max(height/2,Math.min(data.height-height/2,worldMapView.y))));
 return {x:worldMapView.x-width/2,y:worldMapView.y-height/2,width,height};
}
function applyMapView(){if(!worldMapData)return;const v=mapViewBox();$('world-map').setAttribute('viewBox',[v.x,v.y,v.width,v.height].join(' '));}
function mapZoom(value,anchor){
 if(!worldMapData)return;const before=mapViewBox();mutateConsoleValue('worldMap', 'worldMapView', nextStateValue => (nextStateValue.zoom=Math.max(1,Math.min(8,value))));setMapZoomInput(worldMapView.zoom);
 if(anchor){const after=mapViewBox();mutateConsoleValue('worldMap', 'worldMapView', nextStateValue => (nextStateValue.x=before.x+before.width*anchor.x+(0.5-anchor.x)*after.width));mutateConsoleValue('worldMap', 'worldMapView', nextStateValue => (nextStateValue.y=before.y+before.height*anchor.y+(0.5-anchor.y)*after.height));}
 drawWorldMap();
}
function mapFullView(){if(!worldMapData)return;closeWorldMapDetail();setConsoleValue('worldMap', 'worldMapView', {x:worldMapData.width/2,y:worldMapData.height/2,zoom:1});setMapZoomInput(1);drawWorldMap();}

function selectedMapMarker(key=worldMapSelected){
 return key && $('world-map-markers')?.querySelector('[data-world-target="'+CSS.escape(key)+'"]');
}
function hasAnchoredMapDetail(point){
 return !!point.cityInfo || point.layer==='fleets' || point.layer==='traffic';
}
function closeWorldMapDetail({restoreFocus=false,redraw=false}={}){
 const dialog=$('world-map-detail'),key=worldMapSelected;
 const fleetButton=restoreFocus && dialog.hasAttribute('data-located-fleet') && key
  && $('world-map-fleets').querySelector('[data-locate-fleet="'+CSS.escape(key)+'"]');
 worldCityAction?.readController?.abort();worldCityAction=null;
 if($('modal').open && $('m-body').querySelector('[data-city-confirm]'))closeModal();
 setConsoleValue('worldMap','worldMapSelected',null);
 if(dialog.open)dialog.close();
 dialog.hidden=true;delete dialog.dataset.city;delete dialog.dataset.anchorKey;delete dialog.dataset.locatedFleet;worldMapPopupPlacement=null;
 if(redraw)drawWorldMap();
 if(restoreFocus)(fleetButton||selectedMapMarker(key))?.focus({preventScroll:true});
}
function placeWorldMapPopup(){
 const dialog=$('world-map-detail');
 const key=dialog.dataset.anchorKey;
 if(!dialog.open || !key || key!==worldMapSelected || dialog.matches(':modal'))return;
 const anchor=selectedMapMarker(key)?.lastElementChild;
 if(!anchor){closeWorldMapDetail();return;}
 const stage=$('world-map-scroll').getBoundingClientRect(),mark=anchor.getBoundingClientRect();
 const cx=(mark.left+mark.right)/2-stage.left,cy=(mark.top+mark.bottom)/2-stage.top;
 if(cx<0 || cx>stage.width || cy<0 || cy>stage.height || mark.top>window.innerHeight || mark.bottom<0){closeWorldMapDetail({redraw:true});return;}
 const gutter=8;
 const topLimit=Math.max(gutter,gutter-stage.top),bottomLimit=Math.min(stage.height,window.innerHeight-stage.top)-gutter;
 const below=mark.bottom-stage.top+4,above=mark.top-stage.top-4;
 const belowRoom=bottomLimit-below,aboveRoom=above-topLimit;
 if(worldMapPopupPlacement?.key!==key){
  dialog.style.removeProperty('--city-max-height');
  dialog.style.removeProperty('--city-room');
  dialog.style.removeProperty('--city-min-width');
  let initialHeight=dialog.offsetHeight;
  if(dialog.dataset.city && !$('world-map-city-actions').childElementCount){
   // 只在地图上给可能出现的按钮留出空间，空操作区本身不占高。
   const style=getComputedStyle($('world-map-city-actions'));
   initialHeight+=parseFloat(style.minHeight)+parseFloat(style.marginTop);
  }
  worldMapPopupPlacement={key,below:belowRoom>=aboveRoom,fromRight:cx>stage.width/2,
   initialWidth:dialog.offsetWidth,initialHeight};
 }
 // 本次打开只按标记与视口选边。舰队列表的加载、刷新和换行均不参与定位。
 const placement=worldMapPopupPlacement;
 // 滚动或调整窗口后，原来的一侧可能连标题都放不下。
 const headingHeight=$('world-map-detail-close').offsetHeight+2*gutter;
 if((placement.below?belowRoom:aboveRoom)<headingHeight && (placement.below?aboveRoom:belowRoom)>=headingHeight)
  placement.below=!placement.below;
 const top=placement.below?Math.max(topLimit,below):Math.max(topLimit,above-placement.initialHeight);
 const bottom=placement.below?bottomLimit:Math.min(bottomLimit,above);
 dialog.style.setProperty('--city-max-height',Math.max(0,bottom-top)+'px');
 // 固定靠标记的一条边，新增操作向地图内侧展开。
 const distance=placement.fromRight?stage.width-cx:cx;
 const inset=Math.max(gutter,distance-placement.initialWidth/2);
 dialog.style.setProperty('--city-left',placement.fromRight?'auto':inset+'px');
 dialog.style.setProperty('--city-right',placement.fromRight?inset+'px':'auto');
 dialog.style.setProperty('--city-room',Math.max(0,stage.width-inset-gutter)+'px');
 dialog.style.setProperty('--city-top',top+'px');
}
function presentWorldMapDetail(point,source){
 const dialog=$('world-map-detail'),wasModal=dialog.matches(':modal');
 const anchored=hasAnchoredMapDetail(point);
 const modal=anchored && (mapModalScreen.matches || source==='touch' || (source==='refresh' && wasModal));
 if(dialog.open && wasModal!==modal)dialog.close();
 if(!anchored || modal)worldMapPopupPlacement=null;
 dialog.hidden=false;
 if(anchored)dialog.dataset.anchorKey=point.key;else delete dialog.dataset.anchorKey;
 if(point.cityInfo)dialog.dataset.city=point.key;else delete dialog.dataset.city;
 if(source!=='refresh')dialog.toggleAttribute('data-located-fleet',source==='locate');
 if(!dialog.open){
  if(modal)dialog.showModal();
  else dialog.setAttribute('open','');
 }
 placeWorldMapPopup();
 if(anchored && source!=='refresh')$('world-map-detail-close').focus({preventScroll:true});
}

function worldCityIsCurrent(view){
 return worldCityAction===view && current===view.account && worldMapOwner===view.account &&
  worldMapData?.scenario===view.scenario && worldMapSelected===view.point.key && !$('world-map-detail').hidden;
}
function worldCityOwnerName(view,owner){
 if(owner===0)return '未占领';
 return worldMapData.owners?.find(item=>item.id===owner)?.name ||
  (owner===view.point.owner?view.point.cityInfo.owner:Number.isSafeInteger(owner)?'联盟 '+owner:'未同步');
}
function cityCommandButton(view,quote,key,label,lines,danger=false){
 const button=smallButton(label);
 if(danger)button.classList.add('text-destructive');
 button.onclick=()=>{
  if(!worldCityIsCurrent(view)||view.quote!==quote)return;
  if(refreshExpiredCityQuote(view,quote))return;
  const text=lines.map((line,index)=>el('p',index?'dim':'',line));
  text[0].dataset.cityConfirm='true';
  openConfirm(label+' · '+view.point.name,text,()=>submitWorldCityAction(view,quote,key),'确定');
 };
 return button;
}
function refreshExpiredCityQuote(view,quote){
 if(!quote.expiresAt||Date.now()<quote.expiresAt)return false;
 view.message='上次选择已过期，请重新确认。';
 void loadWorldCityActions(view);
 return true;
}
function paintWorldCityActions(view){
 if(!worldCityIsCurrent(view))return;
 const root=$('world-map-city-actions');
 root.setAttribute('aria-busy',String(view.loading));
 if(view.loading && root.querySelector('.world-city-buttons')){
  for(const control of root.querySelectorAll('select,button'))control.disabled=true;
  return;
 }
 clear(root);
 const controls=el('div','world-city-buttons');
 const status=el('p','dim');status.setAttribute('role','status');
 if(view.message){const feedback=el('p','',view.message);feedback.setAttribute('role','status');root.append(feedback);}
 if(worldCitySending.has(view.account)){
  status.textContent='正在提交…';root.append(status);return;
 }
 if(view.loading)return;
 if(!view.quote){
  status.textContent=view.readError||'尚未读取城池操作';
  const retry=smallButton('重试');retry.onclick=()=>loadWorldCityActions(view);
  root.append(status,retry);return;
 }
 const quote=view.quote,dispatch=quote?.dispatch,declare=quote?.declare,cancel=quote?.cancelDeclare,assemble=quote?.assemble,recruit=quote?.recruit;
 if(dispatch?.fleets?.length && !dispatch.reason && quote.token){
  const select=el('select');select.setAttribute('aria-label','请选择空闲舰队');
  const availableIds=new Set(dispatch.fleets.map(fleet=>fleet.buildingId));
  for(const fleet of dispatch.fleetChoices??dispatch.fleets){
   const available=availableIds.has(fleet.buildingId) && fleet.available!==false;
   const status=fleet.status||(available?'空闲':'不可派遣');
   const option=new Option((fleet.name||fleet.buildingId)+' · '+status,fleet.buildingId);
   option.disabled=!available;
   select.add(option);
  }
  // 仍在列表中的舰队即使变忙也保留选中，避免在刷新时把指令改派给另一队。
  select.value=view.fleetId;
  if(select.selectedIndex<0)select.value=select.querySelector('option:enabled')?.value??'';
  const send=component('ui-confirm');
  // 游戏城池菜单对己方城池统一显示「前往」，包含已宣战城市的增援。
  send.textContent=dispatch.intent==='attack'?'进攻':'前往';
  const selectFleet=()=>{
   view.fleetId=select.value;
   send.disabled=select.selectedOptions[0]?.disabled!==false;
  };
  selectFleet();select.onchange=selectFleet;
  send.onclick=()=>{if(!send.disabled && select.value===view.fleetId)void submitWorldCityAction(view,quote,'dispatch',select.value);};
  controls.append(select,send);
 }
 const name=view.point.name;
 if(recruit?.pending && quote.token){
  const check=smallButton('核对募兵结果');check.onclick=()=>submitWorldCityAction(view,quote,'checkRecruit');controls.append(check);
 }else if(recruit?.allowed && quote.token){
  controls.append(cityCommandButton(view,quote,'recruit','高级募兵',[
   '高级募兵每次消耗'+mapNumber(recruit.cost)+'个“'+recruit.itemId+'”，为城市征召'+mapNumber(recruit.gain)+'个城防军',
   '持有：'+mapNumber(recruit.stock)
  ]));
 }
 if(assemble?.allowed && quote.token){
  const lines=['确认向城市'+name+'集结'];
  if(assemble.currentCityId)lines.push('当前集结城市：'+assemble.currentName);
  controls.append(cityCommandButton(view,quote,'assemble','集结',lines));
 }
 if(cancel?.pending && quote.token){
  const check=smallButton('核对取消宣战结果');check.onclick=()=>submitWorldCityAction(view,quote,'checkCancel');controls.append(check);
 }else if(cancel?.allowed && quote.token){
  controls.append(cityCommandButton(view,quote,'cancelDeclare','取消宣战',[
   '取消宣战后，将不可再向目标城派遣部队，是否确定？','当前角色消耗 '+mapNumber(cancel.cost)+' 钻石'
  ],true));
 }else if(declare?.allowed && quote.token){
  const lines=['确认向城市'+name+'宣战','当前归属 · '+worldCityOwnerName(view,declare.owner)];
  if(Number.isSafeInteger(declare.count)&&Number.isSafeInteger(declare.limit))lines.push('本盟已宣战 '+declare.count+' / '+declare.limit+' 城');
  controls.append(cityCommandButton(view,quote,'declare','宣战',lines,true));
 }
 if(controls.childElementCount){
  root.append(controls);
  const dialog=$('world-map-detail');
  if(controls.querySelector('select') && !dialog.matches(':modal')){
   // 舰队全部变忙时保留本次选队行的宽度，归队后可以原位恢复。
   const style=getComputedStyle(dialog);
   const padding=parseFloat(style.paddingLeft)+parseFloat(style.paddingRight);
   const border=parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth);
   dialog.style.setProperty('--city-min-width',Math.ceil(controls.getBoundingClientRect().width+padding+border)+'px');
  }
 }
}
async function loadWorldCityActions(view){
 if(!worldCityIsCurrent(view)||view.loading)return;
 view.mapState=cityActionMapState(view.point);
 view.readController?.abort();
 view.readController=new AbortController();
 view.quote=null;view.readError='';
 if(worldCitySending.has(view.account)){paintWorldCityActions(view);return;}
 view.loading=true;paintWorldCityActions(view);
 try{
  const params=new URLSearchParams({account:view.account,scenarioId:view.scenario,cityId:view.point.cityId,includeDefenders:'0'});
  const quote=await call('/api/world/city-actions?'+params,{signal:view.readController.signal});
  if(worldCityIsCurrent(view))view.quote=quote;
 }catch(error){if(!view.readController.signal.aborted)view.readError='城池操作未同步：'+error.message;}
 finally{view.loading=false;paintWorldCityActions(view);}
}
function cityActionMapState(point){
 const fleets=worldMapData.fleets.map(fleet=>[fleet.id,fleet.state,fleet.task,fleet.grid]);
 return JSON.stringify([point.owner,point.assemble,point.warRole,point.fighting,point.cityInfo.declared,worldMapData.war?.inWindow,fleets]);
}
async function submitWorldCityAction(view,quote,action,buildingId){
 if(!worldCityIsCurrent(view)||quote!==view.quote||worldCitySending.has(view.account))return;
 if(!snapshot.connected||snapshot.paused||disconnected.has(view.account)){view.readError='请连接当前账号后重试';view.quote=null;paintWorldCityActions(view);return;}
 if(refreshExpiredCityQuote(view,quote))return;
 view.quote=null;view.readController?.abort();worldCitySending.add(view.account);paintWorldCityActions(view);
 try{
  const confirmedCost=action==='cancelDeclare'||action==='recruit'?quote[action].cost:undefined;
  const result=await call('/api/world/city-actions?account='+encodeURIComponent(view.account),{
   method:'POST',body:JSON.stringify({confirm:true,token:quote.token,cityId:view.point.cityId,action,buildingId,confirmedCost})
  });
  view.message=result.message;if(action==='dispatch')view.fleetId='';
 }catch(error){view.message=error.message;}
 finally{
  worldCitySending.delete(view.account);
  if(current===view.account){
   if(worldCityAction && worldCityIsCurrent(worldCityAction))void loadWorldCityActions(worldCityAction);
   void refreshWorldMap();
  }
 }
}
async function showWorldMapTarget(point,refresh=false,source='click'){
 if(!refresh&&Date.now()-worldMapDraggedAt<180)return;
 setConsoleValue('worldMap', 'worldMapSelected', point.key);if(!refresh)drawWorldMap();
 const panel=$('world-map-target-facts'),dialog=$('world-map-detail');
 const scrollTop=refresh?dialog.scrollTop:0;
 clear(panel);
 const isFleet=point.layer==='fleets'||point.layer==='traffic';
 if(point.cityInfo)paintWorldCityFacts(panel,point);
 else if(isFleet){
  if(point.cluster)panel.append(worldFleetCards(point.cluster));
  else panel.append(worldFleetCard(point,false));
 }
 $('world-map-target-name').textContent=point.name;
 const actions=$('world-map-city-actions');
 if(point.cityInfo && dialog.dataset.city!==point.key)clear(actions);
 actions.hidden=!point.cityInfo;
 presentWorldMapDetail(point,refresh?'refresh':source);
 dialog.scrollTop=scrollTop;
 if(!point.cityInfo){worldCityAction?.readController?.abort();worldCityAction=null;}
 if(point.cityInfo){
  if(!worldCityAction||!worldCityIsCurrent(worldCityAction)){
   worldCityAction?.readController?.abort();
   worldCityAction={account:worldMapOwner,scenario:worldMapData.scenario,point,quote:null,fleetId:'',message:'',loading:false};
   void loadWorldCityActions(worldCityAction);
  }else{
   const view=worldCityAction;view.point=point;
   if(refresh && view.quote && !$('modal').open && (view.mapState!==cityActionMapState(point) || Date.now()>=view.quote.expiresAt))
    void loadWorldCityActions(view);
  }
  return;
 }
 if(isFleet)return;
 panel.append(el('p','',point.detail));
 if(['treasure','radar','pirates'].includes(point.layer)){const link=el('a','','查看参数与独立预览');link.href='#config-group-'+({treasure:'treasure',radar:'radar',pirates:'pirate-hunt'})[point.layer];panel.append(link);}
 const detail=el('div','dim','正在核对目标条件…');panel.append(detail);const owner=current;
 try{
  const info=await call('/api/world/target?layer='+encodeURIComponent(point.layer)+'&key='+encodeURIComponent(point.key));if(owner!==current||!detail.isConnected)return;clear(detail);
  if(info.fuel!==null&&info.fuel!==undefined)detail.append(el('p','','汽油库存 '+fmt(info.fuel)+(info.cost!==null&&info.cost!==undefined?' · 单队费用 '+fmt(info.cost):'')));
  for(const note of info.notes??[])if(note)detail.append(el('p','',note));
  if(info.fleets?.length)detail.append(table(['舰队','当前条件'],info.fleets.map(f=>[f.name||f.buildingId,f.reason||'基础条件符合，仍需核对目标与可用资源'])));
  for(const action of info.actions??[])detail.append(el('p','',action.label+' · '+(action.costs??[]).map(c=>(c.name||c.id)+' '+c.num).join('、')));
 }catch(error){if(detail.isConnected)detail.textContent='目标详情未同步：'+error.message;}
}
function mapWarIcon(kind){
 const paths={attack:'M6 4 17 15 M6 4 6 8 M6 4 10 4 M5 13 11 19 M8 16 4 20 M18 4 7 15 M18 4 14 4 M18 4 18 8 M13 19 19 13 M16 16 20 20',defence:'M12 3 20 6 V12 C20 17 16 20 12 22 C8 20 4 17 4 12 V6 Z M12 7 V16 M8 12 12 16 16 12',fight:'M13 2 C14 8 21 9 20 15 A8 8 0 0 1 4 15 C3 11 6 8 8 6 C7 11 11 11 13 2 Z M12 12 C15 15 15 18 12 20 C9 19 9 16 12 12 Z',assemble:'M5 21 V3 M6 4 H19 L16 8 19 12 H6 M3 21 H9'};
 const colors={attack:'#b14538',defence:'#226b9a',fight:'#bf5924',assemble:'#8b642b'};
 const badge=mapNode('g',{'pointer-events':'none','data-war-icon':kind});badge.append(mapNode('rect',{x:1,y:1,width:22,height:22,rx:5,fill:'#fffdf7',stroke:colors[kind],'stroke-width':1}),mapNode('path',{d:paths[kind],fill:kind==='fight'?'#fff0d4':'none',stroke:colors[kind],'stroke-width':1.7,'stroke-linecap':'round','stroke-linejoin':'round'}));return badge;
}
function cityBadge(group,point,x,y,unit,r){
 const kinds=point.fighting?['fight']:point.declared?[point.warRole==='defence'?'defence':'attack']:[];if(point.assemble)kinds.push('assemble');
 if(point.fighting)group.append(mapNode('circle',{cx:x,cy:y,r:r+3*unit,fill:'none',stroke:'#c05a24','stroke-width':1.5,'vector-effect':'non-scaling-stroke'}));
 kinds.forEach((kind,index)=>{const badge=mapWarIcon(kind);badge.setAttribute('transform','translate('+(x+(index?11:-10)*unit)+' '+(y-23*unit)+') scale('+(unit*.53)+')');group.append(badge);});
}
// 图例使用图标自身的坐标，不带地图角标的偏移或交战光圈。
function paintMapStateLegend(){const root=clear($('world-map-state-legend'));for(const [label,kind]of [['我盟宣战','attack'],['我盟受攻','defence'],['交战','fight'],['集结','assemble']]){const item=el('span'),svg=mapNode('svg',{viewBox:'0 0 24 24','aria-hidden':'true'});svg.append(mapWarIcon(kind));item.append(svg,el('span','',label));root.append(item);}root.append(el('span','','攻/守数字：优先 + 普通队列'));}
function drawWorldMap(){
 const data=worldMapData;if(!data||!$('world-map-scroll').clientWidth)return;const svg=$('world-map');
 if(worldMapPainted!==data){
  clear(svg);const territory=mapNode('g',{id:'world-map-regions'});
  for(const region of data.regions??[])territory.append(mapNode('path',{d:region.path,fill:region.color,stroke:'#e9f0f2','stroke-width':.6,'vector-effect':'non-scaling-stroke','fill-rule':'evenodd'}));
  svg.append(territory,mapNode('g',{id:'world-map-routes'}),mapNode('g',{id:'world-map-markers'}),mapNode('g',{id:'world-map-labels','pointer-events':'none'}));worldMapPainted=data;
 }
 const v=mapViewBox();applyMapView();const unit=v.width/Math.max(1,$('world-map-scroll').clientWidth),markers=clear($('world-map-markers')),labels=clear($('world-map-labels')),routes=clear($('world-map-routes'));
 worldMapMovingNodes=[];const movingByKey=new Map();
 $('world-map-regions').style.display=worldLayers.has('regions')?'':'none';
 for(const route of data.routes){
  const layer=route.layer||'fleets';if(!worldLayers.has(layer))continue;
  const color=route.color||worldLayerColors[layer],line=mapNode('line',{x1:route.start.x,y1:route.start.y,x2:route.end.x,y2:route.end.y,stroke:'color-mix(in srgb, '+color+' 55%, #101c28)','stroke-width':1.8,'stroke-dasharray':'4 3','vector-effect':'non-scaling-stroke'}),tip=mapNode('title');tip.textContent=route.name+(route.target?' → '+route.target:'');line.append(tip);routes.append(line);
 }
 const all=[],fleets=new Map();
 for(const p of data.points){if(!worldLayers.has(p.layer)&&!(p.layer==='cities'&&worldLayers.has('cityWar')&&(p.declared||p.fighting||p.assemble)))continue;if(p.layer==='fleets'&&!p.motion){const group=fleets.get(p.grid)??[];group.push(p);fleets.set(p.grid,group);}else all.push(p);}
 for(const cluster of fleets.values()){
  const anchor=cluster.find(fleet=>fleet.key===worldMapSelected)??cluster[0];
  all.push(cluster.length===1?anchor:{...anchor,name:cluster.length+'支舰队（同位置）',cluster});
 }
 // 城池在到达箭头之上，避免箭头终点遮住城池点击。
 all.sort((a,b)=>Number(a.layer==='cities')-Number(b.layer==='cities'));
 worldMapDrawnPoints=all;
 const named=[];
 for(const point of all){
  const layer=point.layer,{x,y}=mapMotionPosition(point,mapServerNow()),selected=point.key===worldMapSelected,r=(layer==='cities'?(point.capital||point.cityType===5?7:4):layer==='fleets'?7:layer==='fields'?2.7:layer==='treasure'?({1:7,2:10,3:14})[point.size]||7:5)*unit;
  const group=mapNode('g',{role:'button',tabindex:0,'data-world-target':point.key,'aria-label':worldLayerNames[layer]+'：'+point.name+'，查看详情'});
  if(hasAnchoredMapDetail(point)){group.setAttribute('aria-haspopup','dialog');group.setAttribute('aria-controls','world-map-detail');}
  const title=mapNode('title');
  if(!point.cityInfo){title.textContent=point.name+' · '+(point.motion?mapJourney(point.motion):point.detail);group.append(title);}
  let shape,fill=point.routeColor||worldLayerColors[layer];
  if(point.motion){const m=point.motion,a=Math.atan2(m.end.y-m.start.y,m.end.x-m.start.x),vertices=[[r,0],[-r*.75,-r*.6],[-r*.25,0],[-r*.75,r*.6]].map(([dx,dy])=>[x+dx*Math.cos(a)-dy*Math.sin(a),y+dx*Math.sin(a)+dy*Math.cos(a)]);shape=mapNode('polygon',{points:vertices.map(p=>p.join(',')).join(' ')});}
  else if(layer==='cities'){
   fill='#f5fafb';
   if(point.capital||point.cityType===5){const star=Array.from({length:10},(_,i)=>{const a=-Math.PI/2+i*Math.PI/5,d=i%2?r*.45:r;return[x+Math.cos(a)*d,y+Math.sin(a)*d].join(',');});shape=mapNode('polygon',{points:star.join(' ')});}
   else if(point.cityType===1)shape=mapNode('rect',{x:x-r*.8,y:y-r*.8,width:r*1.6,height:r*1.6});
   else if(point.cityType>=3)shape=mapNode('polygon',{points:[[x,y-r],[x+r,y],[x,y+r],[x-r,y]].map(p=>p.join(',')).join(' ')});
   else shape=mapNode('circle',{cx:x,cy:y,r});
  }else if(layer==='fleets')shape=mapNode('circle',{cx:x,cy:y,r});
  else if(layer==='treasure'){shape=mapNode('path',{d:'M-10 1 H10 L6 6 H-6 Z M-7 0 V-4 H-1 V0 M0 0 V-4 H5 V0 M5 -4 V-7 H8 V0',transform:'translate('+x+' '+y+') scale('+(r/10)+')','stroke-linejoin':'round','data-ship-size':point.size||1});}
  else if(layer==='boss')shape=mapNode('polygon',{points:[[x,y-r],[x+r,y],[x,y+r],[x-r,y]].map(p=>p.join(',')).join(' ')});
  else if(layer==='fields'||layer==='radar')shape=mapNode('rect',{x:x-r,y:y-r,width:r*2,height:r*2});
  else shape=mapNode('circle',{cx:x,cy:y,r});
  for(const[k,value]of Object.entries({fill,stroke:layer==='cities'?'#5e7884':'#f6fcfe','stroke-width':1.25,'vector-effect':'non-scaling-stroke',class:'map-symbol'}))shape.setAttribute(k,value);group.append(shape);
  if(layer==='cities'&&worldLayers.has('cityWar')&&(point.declared||point.fighting||point.assemble))cityBadge(group,point,x,y,unit,r);
  if(layer==='fleets'&&!point.motion){const count=mapNode('text',{x,y:y+3*unit,'text-anchor':'middle','font-size':9*unit,class:'map-fleet-count'});count.textContent=point.cluster?String(point.cluster.length):point.name.match(/\d+/)?.[0]||'舟';group.append(count);}
  if(selected)group.append(mapNode('circle',{cx:x,cy:y,r:r+4*unit,fill:'none',stroke:'#1166a7','stroke-width':2,'vector-effect':'non-scaling-stroke'}));
  group.append(mapNode('circle',{cx:x,cy:y,r:Math.max(r,8*unit),fill:'transparent',stroke:'none'}));
  group.onclick=e=>showWorldMapTarget(point,false,e.pointerType||'click');group.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();showWorldMapTarget(point);$('world-map-detail-close').focus({preventScroll:true});}};markers.append(group);
  if(point.motion){group.setAttribute('data-motion-key',point.key);const moving={point,node:group,title,x,y,labels:[]};worldMapMovingNodes.push(moving);movingByKey.set(point.key,moving);}
  if(selected||layer==='fleets'||layer==='boss'||layer==='traffic'&&worldMapView.zoom>=2.5||layer==='cities'&&(point.capital||point.cityType===5||worldMapAllNames||worldMapView.zoom>=2.5||worldLayers.has('cityWar')&&(point.declared||point.assemble)))named.push({...point,x,y,r,priority:selected?0:layer==='fleets'?1:point.capital?2:3});
 }
 const occupied=all.filter(p=>p.layer==='cities'&&worldLayers.has('cityWar')&&(p.declared||p.fighting||p.assemble)).map(p=>({x:p.x-16*unit,y:p.y-22*unit,w:36*unit,h:25*unit}));
 for(const p of named.sort((a,b)=>a.priority-b.priority)){
  if(p.x<v.x||p.y<v.y||p.x>v.x+v.width||p.y>v.y+v.height)continue;
  const text=p.layer==='fleets'?(p.cluster?'舰队×'+p.cluster.length:p.name.replace('远征舰队 ','舰队').replace(' 队','')):p.name;
  const q=p.cityInfo,queue=q&&worldLayers.has('cityWar')&&worldMapView.zoom>=2.5&&(p.declared||p.fighting||p.key===worldMapSelected)?'攻'+(q.priorityAttack??'?')+'+'+(q.attack??'?')+' 守'+(q.priorityDefence??'?')+'+'+(q.defence??'?'):'';
  const width=t=>[...t].reduce((n,c)=>n+(c.charCodeAt(0)>255?1:.6),0);
  const w=Math.max(width(text)*11+6,width(queue)*10+6)*unit,h=(queue?29:16)*unit;
  const above=[p.x-w/2,p.y-p.r-h-3*unit],below=[p.x-w/2,p.y+p.r+3*unit];
  const choices=[...(p.declared||p.fighting||p.assemble?[below,above]:[above,below]),[p.x+p.r+4*unit,p.y-h/2],[p.x-p.r-w-4*unit,p.y-h/2]];
  const box=choices.map(([x,y])=>({x,y,w,h})).find(b=>b.x>=v.x&&b.y>=v.y&&b.x+w<=v.x+v.width&&b.y+h<=v.y+v.height&&!occupied.some(a=>b.x<a.x+a.w&&b.x+b.w>a.x&&b.y<a.y+a.h&&b.y+b.h>a.y));if(!box)continue;occupied.push(box);
  const background=mapNode('rect',{x:box.x,y:box.y,width:w,height:h,rx:2*unit,fill:'#f4fafc','fill-opacity':.9});labels.append(background);const label=mapNode('text',{x:box.x+3*unit,y:box.y+11.5*unit,'font-size':11*unit,'font-weight':p.capital||p.layer==='fleets'?600:400});label.textContent=text;labels.append(label);movingByKey.get(p.key)?.labels.push(background,label);
  if(queue){const counts=mapNode('text',{x:box.x+3*unit,y:box.y+24*unit,'font-size':10*unit,fill:'#9b4138'});counts.textContent=queue;labels.append(counts);}
 }
 placeWorldMapPopup();
}
async function refreshWorldMap(){
 if(!current||snapshot.paused||disconnected.has(current)||worldMapLoading)return;const account=current,serial=++worldMapSerial;setConsoleValue('worldMap', 'worldMapLoading', true);worldMapLastAttempt=Date.now();$('world-map-refresh').disabled=true;$('world-map-time').textContent='正在同步…';
 try{
  worldMapOverviewRead=call('/api/world/overview');
  const data=await worldMapOverviewRead;if(current!==account||serial!==worldMapSerial)return;
  const fresh=worldMapOwner!==account||worldMapData?.scenario!==data.scenario;setConsoleValue('worldMap', 'worldMapOwner', account);setConsoleValue('worldMap', 'worldMapData', data);setConsoleValue('worldMap', 'worldMapReceivedAt', Date.now());worldMapJourneyNodes=[];
  if(fresh){closeWorldMapDetail();setConsoleValue('worldMap', 'worldMapView', {x:data.width/2,y:data.height/2,zoom:1});setMapZoomInput(1);}
  $('world-map-time').textContent='更新 '+new Date(data.checkedAt*1000).toLocaleTimeString('zh-CN');
  paintWorldFuel(data);
  const number=value=>Number.isSafeInteger(value)?String(value):'未同步';
  clear($('world-map-fleets')).append(table(['舰队','耐久','状态','征程','操作'],data.fleets.map(fleet=>{
   const name=fleet.name.replace('远征舰队 ','舰队').replace(' 队',''),button=el('button','inline-link',name);
   button.type='button';button.dataset.locateFleet='fleet-'+fleet.id;button.setAttribute('aria-label','定位'+name);button.onclick=()=>locateOwnFleet(fleet);
   return [button,number(fleet.durability)+'/'+number(fleet.maxDura),fleet.state,journeyNode(fleet.journey),worldFleetSpeedButton(account,fleet)];
  })));
  const wars=clear($('world-map-wars'));wars.append(el('strong','','城战'));
  if(data.cityWars?.length)wars.append(table(['城市 / 状态','宣战','进攻队列','防守队列','交战 / 行军'],data.cityWars.map(w=>[w.name+' · '+w.status,w.declared.map(d=>d.attack+' → '+d.defence).join('；')||'未同步',number(w.attack)+' + 优先'+number(w.priorityAttack),number(w.defence)+' + 优先'+number(w.priorityDefence),number(w.battles)+' 点 / '+number(w.inbound)+' 队'])));
  else wars.append(el('p','dim',data.layers.cityWar==='未同步'?'宣战状态未同步':'当前没有已同步的宣战或交战城市'));
  const treasures=clear($('world-map-treasures'));treasures.append(el('strong','','货轮'));
  if(data.treasures?.length)treasures.append(table(['货轮','归属 / 进度','守军 / 已出发','正在交战'],data.treasures.map(t=>[t.name,t.owner+' · '+number(t.progress)+'%',number(t.defenders)+' / '+number(t.inbound)+' 队',t.fighters.join(' / ')||'—'])));
  else treasures.append(el('p','dim',data.layers.treasure==='未同步'?'货轮状态未同步':'当前没有已同步的货轮'));
  const layers=$('world-map-layers');
  const layerKey=JSON.stringify([worldMapOwner,data.layers,[...worldLayers],worldMapAllNames]);
  if(layers.layerKey!==layerKey||!layers.childElementCount){
  layers.layerKey=layerKey;clear(layers);
  for(const [key,name]of Object.entries(worldLayerNames)){
   const label=el('label'),check=el('input'),swatch=el('i','map-swatch');swatch.style.background=worldLayerColors[key];check.type='checkbox';check.checked=worldLayers.has(key);check.setAttribute('aria-label',name+'图层');label.title=key==='regions'?'真实城池区域与已同步归属':data.layers[key]||'未同步';check.onchange=()=>{if(check.checked)worldLayers.add(key);else worldLayers.delete(key);drawWorldMap();};label.append(check,swatch,el('span','',name+(data.layers[key]==='未同步'?'（未同步）':'')));layers.append(label);
  }
  const label=el('label'),names=el('input');names.type='checkbox';names.checked=worldMapAllNames;names.setAttribute('aria-label','全部城名');names.onchange=()=>{setConsoleValue('worldMap', 'worldMapAllNames', names.checked);drawWorldMap();};label.append(names,el('span','','全部城名'));layers.append(label);
  }
  const legend=clear($('world-map-legend'));for(const owner of [{name:'未占领',color:'#c4d7df'},...((data.regions??[]).some(r=>r.owner===null)?[{name:'归属未同步',color:'#e1e7e8'}]:[]),...(data.owners??[])]){const item=el('span'),color=el('i','map-swatch');color.style.background=owner.color;if(owner.defaultName)item.title='当前按游戏主城默认名显示';item.append(color,el('span','',owner.name));legend.append(item);}
  paintMapStateLegend();$('world-map-notes').textContent=data.notes.join(' ');drawWorldMap();
  if(worldMapSelected && mapDetailDialog.open){
   const marker=!mapDetailDialog.hasAttribute('data-located-fleet') && worldMapDrawnPoints.find(point=>point.key===worldMapSelected);
   const selected=marker || data.points.find(point=>point.key===worldMapSelected);
   if(selected)void showWorldMapTarget(selected,true);else closeWorldMapDetail();
  }
 }catch(error){if(current===account&&serial===worldMapSerial)$('world-map-time').textContent='未同步：'+error.message;}
 finally{if(serial===worldMapSerial){worldMapOverviewRead=null;setConsoleValue('worldMap', 'worldMapLoading', false);worldMapLastAttempt=Date.now();$('world-map-refresh').disabled=false;}}
}
function maybeRefreshWorldMap(){
 if(!worldMapAutoRefresh||document.hidden||$('tab-overview').classList.contains('hidden'))return;
 if(!current||snapshot.paused||disconnected.has(current)){if(worldMapData)resetWorldMap();return;}
 if(worldMapOwner&&worldMapOwner!==current)resetWorldMap();
 if(!worldMapLoading&&Date.now()-worldMapLastAttempt>=worldMapRefreshEvery*1000)void refreshWorldMap();
}
function updateWorldMapMotion(){
 if(!worldMapData||document.hidden||$('tab-overview').classList.contains('hidden'))return;
 if(!worldMapDrag&&!mapStale())for(const record of worldMapMovingNodes){
  const p=mapMotionPosition(record.point,mapServerNow()),transform='translate('+(p.x-record.x)+' '+(p.y-record.y)+')';record.node.setAttribute('transform',transform);for(const label of record.labels)label.setAttribute('transform',transform);record.title.textContent=record.point.name+' · '+mapJourney(record.point.motion);
  if(record.point.key===mapDetailDialog.dataset.anchorKey)placeWorldMapPopup();
 }
 worldMapJourneyNodes=worldMapJourneyNodes.filter(r=>r.node.isConnected);for(const r of worldMapJourneyNodes){const text=mapJourney(r.journey);if(r.node.textContent!==text)r.node.textContent=text;}
}
setInterval(maybeRefreshWorldMap,1000);setInterval(updateWorldMapMotion,250);
$('world-map-refresh-seconds').onchange=()=>{const input=$('world-map-refresh-seconds'),value=Number(input.value);if(!Number.isInteger(value)||value<5||value>300){input.setCustomValidity('请填写5到300之间的整数');input.reportValidity();return;}input.setCustomValidity('');setConsoleValue('worldMap', 'worldMapRefreshEvery', value);worldMapLastAttempt=0;maybeRefreshWorldMap();};
$('world-map-auto-refresh').onclick=()=>{setConsoleValue('worldMap', 'worldMapAutoRefresh', !worldMapAutoRefresh);const button=$('world-map-auto-refresh');button.setAttribute('aria-pressed',String(worldMapAutoRefresh));button.textContent='自动刷新：'+(worldMapAutoRefresh?'开':'关');if(worldMapAutoRefresh){worldMapLastAttempt=0;maybeRefreshWorldMap();}};
$('world-map-refresh').onclick=refreshWorldMap;$('world-map-reset').onclick=mapFullView;
const mapDetailDialog=$('world-map-detail');
$('world-map-detail-close').onclick=()=>closeWorldMapDetail({restoreFocus:true,redraw:true});
mapDetailDialog.oncancel=event=>{event.preventDefault();closeWorldMapDetail({restoreFocus:true,redraw:true});};
mapDetailDialog.onclick=event=>{
 if(event.target!==mapDetailDialog || !mapDetailDialog.matches(':modal'))return;
 const r=mapDetailDialog.getBoundingClientRect();
 if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom)
  closeWorldMapDetail({restoreFocus:true,redraw:true});
};
document.addEventListener('pointerdown',event=>{
 if(!mapDetailDialog.dataset.anchorKey || mapDetailDialog.matches(':modal') || $('modal').open ||
  mapDetailDialog.contains(event.target) || event.target.closest?.('[data-world-target]'))return;
 closeWorldMapDetail({redraw:true});
});
document.addEventListener('keydown',event=>{
 if(event.key==='Escape' && mapDetailDialog.dataset.anchorKey && !mapDetailDialog.matches(':modal') && !$('modal').open){
  event.preventDefault();closeWorldMapDetail({restoreFocus:true,redraw:true});
 }
});
mapModalScreen.addEventListener('change',()=>{if(mapDetailDialog.dataset.anchorKey)closeWorldMapDetail({redraw:true});});
window.addEventListener('scroll',placeWorldMapPopup,{passive:true,capture:true});
window.addEventListener('resize',placeWorldMapPopup);
$('world-map-zoom').oninput=()=>mapZoom(Number($('world-map-zoom').value));
setMapZoomInput(1);
$('world-map-home').onclick=()=>{const p=worldMapData?.points.find(p=>p.layer==='fleets')||worldMapData?.home;if(!p)return;closeWorldMapDetail();const position=mapMotionPosition(p,mapServerNow());setConsoleValue('worldMap', 'worldMapSelected', p.key);setConsoleValue('worldMap', 'worldMapView', {x:position.x,y:position.y,zoom:4});setMapZoomInput(4);drawWorldMap();};
let worldMapTouchPan=false;
bindConsoleSlice('worldMapTouch', { worldMapTouchPan }, state => { worldMapTouchPan=state.worldMapTouchPan; });
$('world-map-pan').onclick=()=>{setConsoleValue('worldMapTouch', 'worldMapTouchPan', !worldMapTouchPan);const button=$('world-map-pan');button.setAttribute('aria-pressed',String(worldMapTouchPan));button.textContent=worldMapTouchPan?'完成移动':'移动地图';$('world-map').classList.toggle('touch-pan',worldMapTouchPan);};
$('world-map').addEventListener('pointerdown',e=>{if(e.button!==0||!worldMapData)return;if(e.pointerType==='touch'&&!worldMapTouchPan)return;worldMapDrag={id:e.pointerId,x:e.clientX,y:e.clientY,cx:worldMapView.x,cy:worldMapView.y,view:mapViewBox(),moved:false};});
$('world-map').addEventListener('pointermove',e=>{const d=worldMapDrag;if(!d||d.id!==e.pointerId)return;const dx=e.clientX-d.x,dy=e.clientY-d.y;if(!d.moved&&Math.hypot(dx,dy)<4)return;if(!d.moved&&mapDetailDialog.dataset.anchorKey)closeWorldMapDetail();d.moved=true;$('world-map').setPointerCapture(e.pointerId);$('world-map').classList.add('is-dragging');mutateConsoleValue('worldMap', 'worldMapView', nextStateValue => (nextStateValue.x=d.cx-dx*d.view.width/$('world-map-scroll').clientWidth));mutateConsoleValue('worldMap', 'worldMapView', nextStateValue => (nextStateValue.y=d.cy-dy*d.view.height/$('world-map-scroll').clientHeight));applyMapView();});
const endMapDrag=e=>{if(!worldMapDrag||worldMapDrag.id!==e.pointerId)return;const moved=worldMapDrag.moved;if(moved)worldMapDraggedAt=Date.now();worldMapDrag=null;$('world-map').classList.remove('is-dragging');if($('world-map').hasPointerCapture(e.pointerId))$('world-map').releasePointerCapture(e.pointerId);if(moved)drawWorldMap();};
window.addEventListener('pointerup',endMapDrag,true);window.addEventListener('pointercancel',endMapDrag,true);
$('world-map').addEventListener('wheel',e=>{if(!e.ctrlKey||!worldMapData)return;e.preventDefault();const rect=$('world-map').getBoundingClientRect();mapZoom(worldMapView.zoom*(e.deltaY<0?1.15:1/1.15),{x:(e.clientX-rect.left)/rect.width,y:(e.clientY-rect.top)/rect.height});},{passive:false});
new ResizeObserver(()=>{if(worldMapData)drawWorldMap();}).observe($('world-map-scroll'));
