// 游戏配置编辑器：按账号合并连续输入，校验后自动保存，预览仍使用独立只读接口。
const configEditor = { owner: null, data: null, draft: null, baseline: null, recoveryBlocked: false, category: 'base', busy: false, loading: false, serial: 0, saveTimer: null, savePromise: null, saving: false, saveError: null, saveRetries: 0, fields: new Map(), widgets: new Map(), groups: new Map(), selectedGroups: {}, errors: {}, playerData: null, playerRequest: null, playerError: '', playerWidgets: [] };
// 排行是独立的只读视图，不参与配置草稿、版本和自动保存。
const configWeeklyRanking = { owner: null, serial: 0, data: null, error: '', pending: null, at: 0 };
bindConsoleObject('configuration', configEditor, ['owner', 'data', 'draft', 'baseline', 'category', 'busy', 'loading', 'saving', 'saveError', 'saveRetries', 'selectedGroups', 'errors', 'playerData', 'playerError', 'previewSummary']);
const configCategories = { base: '基地', world: '世界', heroes: '英雄', antique: '藏品', equipment: '装备', daily: '日常与活动' };
const activityOwnedSettings = new Set(['weekOrder.enabled', 'schedule.weekOrderSubmit', 'weekOrder.allowDiamonds', 'schedule.weekOrderFinal',
  'schedule.beautyVotes', 'schedule.beautyGift',
  'heroRaid.enabled', 'heroRaid.challenge', 'heroRaid.retryTimes', 'heroRaid.orders', 'heroRaid.lottery', 'heroRaid.rewards']);
const baseFamilies = [
  { id: 'construction', title: '建筑', groups: ['building'] },
  { id: 'production', title: '生产', groups: ['factory', 'farm', 'gather'] },
  { id: 'events', title: '事件', groups: ['resident', 'cargo', 'events'] },
  { id: 'foundation', title: '基础', groups: ['pet', 'museum', 'resources', 'gold'] },
];
const configLegacyGroups = new Map();
const familyGroups = new Map();
const configCollapsed = new Set();
const configDisclosureSeen = new Set();
const configCollapsedSections = new Set();
const configField = (key, label, kind = 'switch', options = {}) => ({ key, label, kind, ...options });
const museumFactorOptions = [[1, '1倍'], [2, '2倍'], [3, '3倍']];
function configPlacePanel(root, panel) {
  if (!root.open || !panel || !root.isConnected) return;
  const summary = root.querySelector('summary');
  if (!summary.getClientRects().length) { root.open = false; return; }
  const rect = summary.getBoundingClientRect(), viewport = window.visualViewport;
  const left = (viewport?.offsetLeft ?? 0) + 8;
  let top = (viewport?.offsetTop ?? 0) + 8;
  let bottom = top + (viewport?.height ?? innerHeight) - 16;
  const right = left + (viewport?.width ?? document.documentElement.clientWidth) - 16;
  // 避开吸顶工具栏和手机底栏，软键盘出现时使用实际可视区域。
  for (const bar of [document.querySelector('header'), root.closest('#config-root')?.querySelector('.config-toolbar')]) {
    if (bar && getComputedStyle(bar).position === 'sticky') top = Math.max(top, bar.getBoundingClientRect().bottom + 4);
  }
  const tabs = $('tabs');
  if (tabs && getComputedStyle(tabs).position === 'fixed') bottom = Math.min(bottom, tabs.getBoundingClientRect().top - 8);
  if (rect.bottom <= top || rect.top >= bottom) { root.open = false; return; }
  // 原地保留 DOM 和表单事件，通过浏览器顶层摆脱卡片裁切和层叠上下文。
  if (typeof panel.showPopover === 'function') {
    panel.setAttribute('popover', 'manual');
    if (!panel.matches(':popover-open')) panel.showPopover();
  }
  const floating = panel.hasAttribute('popover');
  if (floating) panel.style.width = Math.max(0, Math.min(rect.width, right - left)) + 'px';
  const height = Math.min(panel.scrollHeight + 2, 420);
  const below = Math.max(0, bottom - rect.bottom - 4), above = Math.max(0, rect.top - top - 4);
  const up = height > below && above > below;
  if (root.classList.contains('open-up') !== up) root.classList.toggle('open-up', up);
  panel.style.maxHeight = Math.min(420, up ? above : below) + 'px';
  if (floating) {
    panel.style.left = Math.max(left, Math.min(rect.left, right - panel.getBoundingClientRect().width)) + 'px';
    panel.style.top = (up ? rect.top - 4 - panel.getBoundingClientRect().height : rect.bottom + 4) + 'px';
  }
}
const configZeroHints={
 'gather.fishingGoldReserve':'0 表示不保留强化金币。','forge.materialReserve':'0 表示不保留普通材料。','forge.universalReserve':'0 表示不保留万能材料。','forge.goldReserve':'0 表示不保留金币。',
 'museum.stockThreshold':'0 表示关闭库存条件。','resources.keepAccelerators':'0 表示不保留加速器。','resources.diamondThreshold':'0 表示不保留钻石。','gold.times':'0 表示不自动付费点金。',
 'treasure.minDurabilityPercent':'0 表示不设比例门槛，零耐久仍需维修。','radar.minDurabilityPercent':'0 表示不设比例门槛，仍须有耐久。',
 'pirateHunt.minDurabilityPercent':'0 表示不设比例门槛，仍须有耐久。','heroes.keepExp':'0 表示不保留英雄经验。',
 'trials.maxSingleCost':'0 表示禁止付费扫荡。','trials.dailyDiamondBudget':'0 表示禁止付费扫荡。'
};
const merchantActivityFields = [
    configField('merchant.enabled','开启自动挂机'),
    configField('schedule.merchantTrade','按整船收益自动走商','switch',{help:'周期活动。按批次成本、资金、舱位和本港库存规划多商品组合，比较整船预期收益选港；没有成员共享紧缺货也可选择已知普通港口，本港盈利出售不依赖商情。远端价格可能是估算，到港重新核价；临近结束停止无法及时卖出的采购。'}),
    configField('merchant.autoShareIntel','到港自动共享情报','switch',{help:'默认关闭，手动开启后随已开启的走商及所属分组执行。确认到港后共享本港尚未共享的紧缺情报，已有共享直接跳过；每日紧缺更新后重新检查，不按每次价格刷新重复发送。回读确认后才记为已共享，未知结果保留防重记录，失败不阻塞买卖；达到利润上限仍可共享当前港口。'}),
    configField('schedule.tradeTasks','领取海商王联盟任务奖励','switch',{help:'保留原联盟任务领奖开关，按本期联盟任务达成进度自动领取。'}),
    configField('schedule.merchantRewards','领取战令、利润和联盟奖励','switch',{help:'按本期利润、战令分数、联盟任务进度和当日商情贡献领取已达成档。'}),
    configField('merchant.quoteMaxAgeSeconds','报价最长参考时间','number',{unit:'秒',help:'默认300秒。记录采集时间，过期或跨刷新时点的报价不能当作有效报价；到港仍须重新读取当前报价。'}),
    configField('merchant.monitorSeconds','港口监控间隔','number',{unit:'秒',help:'默认60秒。监测本港价格和联盟共享库存，推送可提前唤醒串行检查；刷新时刻和到港时刻单独安排检查。异地港口没有实时价格接口，仍以到港读取为准。'}),
    configField('merchant.estimateDiscountPercent','估算卖价风险折扣','number',{unit:'%',help:'默认10%。没有可用远端报价时，以商品基准价扣除此比例估算，日志标明估算；实际成交价和收益以到港回读为准。'}),
    configField('merchant.minExpectedProfit','最低预期整船利润','number',{unit:'商会币',help:'采购与选港需达到的风险调整后预期利润，默认1。资金、容量和可购库存同时限制采购数量。'}),
    configField('merchant.refreshWaitSeconds','刷新前最多等待','number',{unit:'秒',help:'默认120秒，0关闭。仅在等待后的预计收益优于立即出航且能及时成交时等待；刷新后重新读取价格和库存。刷新时刻使用游戏配置。'}),
    configField('merchant.liquidationMinutes','活动结束前清仓窗口','number',{unit:'分钟',help:'默认120分钟，0关闭提前清仓。窗口内优先处理持货；无论此值多少，都不采购无法在交易截止前卖出的货物。'}),
    configField('merchant.maxLossPercent','清仓最大亏损率','number',{unit:'%',help:'默认0，不自动亏损卖出。大于0时，清仓可按各批次买价接受此比例以内的亏损，仍须符合来源港出售限制。'}),
    configField('merchant.autoSpeedUp','允许使用商会指针','switch',{help:'默认关闭。遵守每日用量、保留数量和每程上限。购买指针必须另开购买开关及钻石预算。'}),
    configField('merchant.speedUpMode','跑船与加速策略','choice',{options:[['deadline','稳定模式：免费跑船，临近截止才补救'],['refresh','刷新窗口加速：不卡点到港'],['arrival','刷新窗口加速：每刷新最多一程'],['profit','原有策略：周转增益及截止补救']],help:'新策略仍按本港实时报价和目的港保守估值决策。卡点模式用持久航程记录限制同一刷新周期的出航次数。'}),
    configField('merchant.refreshWindowMinutes','刷新后加速窗口','number',{ parent: 'merchant.speedUpMode',unit:'分钟',when:d=>['refresh','arrival'].includes(d.merchant.speedUpMode),help:'仅在真实配置刷新时刻之后的此窗口内加速，窗口外等待；交易截止前仍可补救。'}),
    configField('merchant.dailyPointerLimit','每日指针使用上限','number',{ parent: 'merchant.autoSpeedUp',unit:'根',when:d=>d.merchant.autoSpeedUp,help:'默认28，0 禁止使用；跨重启保留已用和未确认用量。'}),
    configField('merchant.autoBuyPointers','自动购买缺少的商会指针','switch',{ parent: 'merchant.autoSpeedUp',when:d=>d.merchant.autoSpeedUp,help:'仅补足当前有效加速方案所缺数量，受游戏日购买上限、全局钻石及本项预算限制。'}),
    configField('merchant.pointerDailyDiamondLimit','每日购买指针钻石上限','number',{ parent: 'merchant.autoBuyPointers',when:d=>d.merchant.autoBuyPointers,help:'0 禁止购买；还需开启全局钻石消费。'}),
    configField('merchant.profitLimit','本期累计利润上限','number',{unit:'商会币',help:'0 表示不额外限制。50000万元对应500000000商会币；达到后停止新增买卖、升级与加速，仍可按开关共享当前港口情报，领奖独立。不是收益保证。'}),
    configField('merchant.firstDepartureMode','每日首趟出发','choice',{options:[['smart','自行判定：先找盈利商品'],['time','指定最早时间']]}),
    configField('merchant.firstDepartureTime','首趟最早出发时间','time',{ parent: 'merchant.firstDepartureMode',when:d=>d.merchant.firstDepartureMode==='time',help:'北京时间。到点后仍需满足报价、舱位、交易时段和预计成交条件。'}),
    configField('merchant.firstDepartureWaitMinutes','首趟无盈利商情最多等待','number',{ parent: 'merchant.firstDepartureMode',unit:'分钟',when:d=>d.merchant.firstDepartureMode==='smart',help:'默认29分钟。已有盈利路线直接执行；信息不足先等，超时后才使用已知普通港口有限寻价。'}),
    configField('merchant.speedUpMaxPerLeg','每程最多使用指针','number',{ parent: 'merchant.autoSpeedUp',unit:'根',when:d=>d.merchant?.autoSpeedUp,help:'默认4，按整段航程累计，分轮执行也不能超过上限。指针不足时只在部分加速仍有可核验收益依据时使用。'}),
    configField('merchant.speedUpMinProfit','每根指针最低估算收益增量','number',{ parent: 'merchant.autoSpeedUp',unit:'商会币',when:d=>d.merchant?.autoSpeedUp,help:'默认1000。只加速能产生足够预期增益的航程，无法确认有效交易机会时不使用。'}),
    configField('merchant.keepPointers','保留指针数量','number',{ parent: 'merchant.autoSpeedUp',unit:'根',when:d=>d.merchant?.autoSpeedUp,help:'自动加速后至少保留此数量，默认0。'}),
    configField('merchant.autoUpgrade','允许回本评估后升级商船','switch',{help:'默认关闭。需同时开启全局钻石消费。仅用可执行航次、已观察库存与新船增量收益保守评估；没有足够回本证据时不升级。'}),
    configField('merchant.upgradeCoinValuePerDiamond','每钻石要求的商会币价值','number',{ parent: 'merchant.autoUpgrade',unit:'商会币',when:d=>d.merchant?.autoUpgrade,help:'默认100，是你用于评估的价值假设，不是游戏兑换汇率。升级需同时满足下方回本比例。'}),
    configField('merchant.upgradeMinReturnPercent','升级最低预期回本比例','number',{ parent: 'merchant.autoUpgrade',unit:'%',when:d=>d.merchant?.autoUpgrade,help:'默认150%。保守增量收益至少达到钻石成本折算值的此比例；活动结束重置船级，不能跨期摊销。'}),
    configField('merchant.upgradeMaxLevel','自动升级最高船级','number',{ parent: 'merchant.autoUpgrade',when:d=>d.merchant?.autoUpgrade,help:'默认2级。达到后不继续自动升级。'}),
    configField('merchant.upgradeDailyDiamondLimit','商船升级每日钻石上限','number',{ parent: 'merchant.autoUpgrade',unit:'钻石',when:d=>d.merchant?.autoUpgrade,help:'默认300，0禁止。与全局钻石预算和钻石保留量同时生效；未知结果保留占用，重连也不重复扣款。'}),
];
for (const field of merchantActivityFields) activityOwnedSettings.add(field.key);
const guildShipActivityFields = [
    configField('guildShip.enabled','开启自动挂机'),configField('guildShip.crew','自动成为船员'),configField('guildShip.captain','自动成为船长'),
    configField('guildShip.mode','上船策略','choice',{options:[['redFirst','红船优先'],['mediumLarge','中船和大船，优先红船'],['full','尽量满船（20分钟后补位）'],['small','仅小船'],['mediumSmall','中船和小船']],help:'按游戏当前赛季批次和实际航程预留名额。满船补位可临时尝试两种角色；禁用物料、库存预留和服务器名额始终有效。'}),
    configField('guildShip.coinFilter','按水姆币奖励筛选'),
    configField('guildShip.minCoinsSmall','小船最低水姆币','number',{ parent: 'guildShip.coinFilter',when:d=>d.guildShip.coinFilter}),
    configField('guildShip.minCoinsMedium','中船最低水姆币','number',{ parent: 'guildShip.coinFilter',when:d=>d.guildShip.coinFilter}),
    configField('guildShip.minCoinsLarge','红船最低水姆币','number',{ parent: 'guildShip.coinFilter',when:d=>d.guildShip.coinFilter,help:'0 表示不限制；这是船只奖励的最低数量，不是支付价格。'}),
    configField('guildShip.rewardFilter','按奖励物品筛选'),
    configField('guildShip.rewardItems','期望奖励物品','multi',{ parent: 'guildShip.rewardFilter',catalog:'materials',when:d=>d.guildShip.rewardFilter}),
    configField('guildShip.disabledMaterials','禁止消耗物料','multi',{catalog:'materials'}),
    configField('guildShip.produceMissing','红船缺料自动备料','switch',{help:'与工厂开关联动；只为符合当前策略的红船备料，不购买材料。'}),
    configField('guildShip.redStartEnabled','指定红船申请船长时间'),
    configField('guildShip.redStartTime','红船申请船长时间','time',{ parent: 'guildShip.redStartEnabled',when:d=>d.guildShip.redStartEnabled,help:'北京时间。只控制申请船长的最早时间，满员或准备结束后由游戏服务器开船。'}),
];
for (const field of guildShipActivityFields) activityOwnedSettings.add(field.key);
const weeklyActivityFields = [
  configField('weeklyActivity.enabled','活动总开关','switch',{help:'总挂机运行时，已选分项按服务器当日主题独立执行，即使对应普通自动化开关关闭也可参与。普通任务始终按自身开关运行；积分达标只停止本活动。各分项沿用已选对象、目标、材料保留和每日预算，不修改保存配置。停止总挂机会同时暂停军备竞赛。'}),
  configField('schedule.armsRaceRewards','自动领奖','switch',{help:'按本人积分、房间等级、当日主题判断5档奖励；独立补给页只领标价为零的礼包。此领奖开关独立保存。'}),
  ...[
    ['farm','周一 · 种田发育','活动日独立收获和种植，不受普通农田开关限制；已选自定义种植时沿用作物目标，否则智能种植。普通联盟城市募兵按本页次数参与。种田加速仍遵守加速器保留量和消费权限。'],
    ['pet','周二 · 海兽培养','按基地 → 海兽中已选的物种范围和最高品质参与培育，按本页品质顺序选择可执行方案。未选物种时等待。'],
    ['antique','周三 · 藏品培养','活动日独立执行藏品升星和套装经验养成，不要求开启普通养成开关。复用藏品配置中已选的升星与套装品质及目标，未选品质时等待，继续遵守金币预算及万能材料权限。'],
    ['order','周四 · 基地订单','复用基地 → 居民订单的材料过滤、最低奖励及每日次数限制；货船和工厂加速仅按原有开关、目标及预算参与。'],
    ['forge','周五 · 装备打造','装备打造主题当天独立领取和制造，即使普通自动锻造、领取或续产开关关闭也可执行。复用已选工厂、配方、材料保留和每日预算，按本页品质顺序选配方。其他日子或活动达标后，普通锻造仍按自身开关运行。游戏原生模式由游戏处理。'],
    ['hero','周日 · 英雄培养','英雄培养主题当天独立执行指定英雄升星，不要求开启普通英雄养成或升星开关。复用英雄名单、星级目标及材料权限；未选择英雄时等待。普通用券招募按自身开关运行。'],
  ].flatMap(([kind, label, help]) => {
    const prefix = 'weeklyActivity.' + kind;
    const fields = [configField(prefix + 'Enabled',label,'switch',{help})];
    if (kind === 'farm') fields.push(
      configField('weeklyActivity.farmRecruitTimes','临时募兵次数','number',{parent:prefix+'Enabled',unit:'次/日',help:'普通联盟城市募兵，默认10次，0表示不参与。由本活动分项授权，仍遵守服务器次数、材料过滤、资源保留及预算限制。'}),
      configField('weeklyActivity.farmSpeedUp','种田加速','switch',{parent:prefix+'Enabled',help:'默认关闭。只在当日种田主题及积分目标内使用已授权的加速资源。'}),
    );
    if (kind === 'pet' || kind === 'forge') fields.push(configField(prefix+'QualityOrder',kind === 'pet' ? '培育品质顺序' : '打造品质顺序','radio',{
      parent:prefix+'Enabled',options:[['asc','从低到高'],['desc','从高到低']],help:'只调整已配置且材料充足的候选方案顺序，不扩大可用物种、配方或材料范围。',
    }));
    fields.push(
      configField(prefix+'Stop','停止条件','radio',{parent:prefix+'Enabled',collapsible:false,options:[['allDay','全天参与'],['score','达到积分值时']],help:'当日对应主题开放时全天参与；积分模式达到目标后停止新增消耗，积分无法确认时等待。'}),
      configField(prefix+'Score','目标积分','number',{parent:prefix+'Stop',unit:'分',when:d=>d.weeklyActivity[kind+'Stop']==='score',help:'填写本日活动的累计目标积分，达到后停止新增消耗。单次动作可能使积分超过目标。'}),
    );
    return fields;
  }),
];
const configGroups = [
  {id:'weekly-activities',title:'军备竞赛',category:'daily',fields:weeklyActivityFields},
  {id:'alliance',title:'联盟 · 募兵与互助',category:'world',fields:[
    configField('alliance.enabled','联盟自动化总开关','switch',{help:'开启后接管联盟募兵、互助和福利任务；关闭保留本组细项并停止全部自动互助。旧版独立互助开关已停用，不会在关闭本组后恢复执行。'}),
    configField('alliance.recruit','自动在联盟城市募兵'),
    configField('alliance.recruitDailyLimit','每日募兵上限','number',{ parent: 'alliance.recruit',help:'0 表示不额外限制，仍遵守游戏按赛季和等级配置的每日次数。'}),
    configField('alliance.recruitProduction','募兵缺料自动备料','switch',{ parent: 'alliance.recruit',help:'独立于按需优先生产；仍需开启工厂生产。次数用完或上次募兵结果未知时停止下一次备料。'}),
    configField('alliance.mutual','联盟互助总开关','switch',{help:'与联盟自动化总开关同时开启后，自动收取已收到的援助；赠送与求助按下方开关执行。关闭本项停止全部自动收取、赠送和求助。属于普通联盟互助，与城战无关。'}),
    configField('alliance.mutualMode','互助模式','choice',{ parent: 'alliance.mutual',options:[['custom','自定义'],['exchange','刷贡献互助']],when:d=>d.alliance.mutual,help:'贡献模式按当前赛季选择对应已解锁物料，并按每日求助次数连续发起。切换模式保留自定义选择。'}),
    configField('alliance.autoHelp','自动送出物料','switch',{ parent: 'alliance.mutual',when:d=>d.alliance.mutual,help:'响应盟友的求助，从自己的库存中送出物料，遵守下方赠送限制。关闭只停止送出，自动求助和已收到援助的领取仍独立执行。'}),
    configField('alliance.allowedMaterials','允许赠送物料','multi',{ parent: 'alliance.autoHelp',catalog:'materials',empty:'未选择，按库存与禁用物料筛选',when:d=>d.alliance.mutual&&d.alliance.mutualMode==='custom'}),
    configField('alliance.blockedMaterials','禁止赠送物料','multi',{ parent: 'alliance.autoHelp',catalog:'materials',when:d=>d.alliance.mutual}),
    configField('alliance.memberKeywords','盟友昵称筛选','names',{ parent: 'alliance.autoHelp',when:d=>d.alliance.mutual,help:'每行一个关键词，忽略大小写；空表示不限制。每次赠送均遵守筛选。'}),
    configField('alliance.stockReserve','赠送后物料保留','number',{ parent: 'alliance.autoHelp',unit:'件',when:d=>d.alliance.mutual}),
    configField('alliance.helpDailyLimit','每日赠送上限','number',{ parent: 'alliance.autoHelp',unit:'次',when:d=>d.alliance.mutual,help:'连续处理符合物料、昵称和库存限制的盟友求助，直到达到本工具每日赠送上限；暂无可赠送求助时等待后续检查。0 表示不赠送。'}),
    configField('alliance.autoAsk','自动求助物料','switch',{ parent: 'alliance.mutual',when:d=>d.alliance.mutual,help:'向盟友发布物料求助，等待盟友赠送。与自动送出物料独立；收到的援助由联盟互助总开关控制自动领取。'}),
    configField('alliance.askDailyLimit','每日求助次数','number',{ parent: 'alliance.autoAsk',unit:'次',when:d=>d.alliance.mutual,help:'同一轮连续发起求助，直到游戏今日已用次数达到设定值，包含手动求助；超过游戏每日上限时按游戏上限执行。设为20且今日已求助5次时，再发起15次。0 表示不发起求助。'}),
    configField('alliance.requestMaterials','主动求助物料','multi',{ parent: 'alliance.autoAsk',catalog:'materials',empty:'未选择，按当前缺料请求',when:d=>d.alliance.mutual&&d.alliance.mutualMode==='custom',help:'选定后可在当前不缺料时请求；仍遵守服务器共享的每日求助次数。'}),
    configField('alliance.collectGifts','自动领取联盟福利'),
    configField('alliance.autoTech','自动升级联盟科技'),
    configField('alliance.techIds','允许升级科技','multi',{ parent: 'alliance.autoTech',catalog:'guildTech',empty:'未选择，按可升级科技顺序检查',when:d=>d.alliance.autoTech}),
    configField('alliance.techDailyLimit','每日科技升级上限','number',{ parent: 'alliance.autoTech',when:d=>d.alliance.autoTech}),
  ]},
  {id:'guildFort',title:'联盟 · 工事捐赠',category:'world',fields:[
    configField('guildFort.enabled','自动捐赠工事','switch',{gates:['alliance.enabled'],help:'同时需要联盟自动化总开关。只捐现有库存；不购买、不兑换，不创建或拆除工事。'}),
    configField('guildFort.materials','捐赠物料','multi',{catalog:'materials',empty:'未选择，使用联盟互助允许物料；两处均为空则不捐赠'}),
    configField('guildFort.reserve','捐赠后库存保留','number'),configField('guildFort.dailyLimit','每日捐赠上限','number',{help:'0 表示不额外限制，仍遵守游戏日上限。'}),
  ]},
  {id:'resourceFields',title:'资源田',category:'world',fields:[
    configField('resourceFields.enabled','自动占领资源田','switch'),
    configField('resourceFields.refillAfterLoss','失地后自动补齐','switch',{help:'已占田从本人列表消失，或因城池失守而停产时，开启此项会按当前比例或配额重新占田。关闭时保留失地造成的缺口，仍可首次占田或使用新增名额。'}),
    configField('resourceFields.allocationMode','名额分配','radio',{
      options:[['ratio','按比例'],['quota','按配额']],
      help:'按比例时，三种资源按权重分配总名额，取整后剩余名额优先分给权重较高的资源。按配额时，分别设置每种资源要占的块数。',
    }),
    ...[['fuel','汽油'],['seeds','种子'],['tech','科技点']].flatMap(([key, label]) => [
      configField('resourceFields.ratios.' + key, label + '比例', 'number', {
        when: draft => draft.resourceFields.allocationMode === 'ratio',
        help:'填写相对权重。设为 0 时，此资源的名额由其他有权重的资源分配。',
      }),
      configField('resourceFields.quotas.' + key, label + '配额', 'number', {
        when: draft => draft.resourceFields.allocationMode === 'quota', unit:'块',
        help:'填写此资源的目标块数。设为 0 时不再派遣舰队占领此类田地。',
      }),
    ]),
    configField('resourceFields.fleetIds','参与舰队','multi',{catalog:'expeditionFleets',empty:'请选择参与占领的舰队，空选不派遣',help:'只使用已编队、空闲且没有待确认任务的舰队，遵守舰队调度顺序与城战预留。'}),
    configField('resourceFields.minDurabilityPercent','最低耐久','number',{unit:'%',help:'占领需要战斗；舰队需达到耐久门槛及田地推荐战力。出征返航后仍未确认占领时，当日暂停自动占田。'}),
    configField('resourceFields.reserveFleetCount','保留空闲舰队','number',{unit:'队',help:'派遣后至少保留此数量的可用空闲舰队给其他任务。设为 0 可使用所有符合条件的舰队。'}),
    configField('resourceFields.minLevel','最低资源田等级','number',{help:'从最高等级开始选田，高级田不足时逐级向下选择，直到此等级。'}),
    configField('resourceFields.checkEverySeconds','检查间隔','number',{unit:'秒',help:'每次检查都会查找可占的高级田。需要更换时，先放弃旧田，再派舰队占领新田。'}),
  ]},
  {id:'silicon',title:'硅矿',category:'world',fields:[
    configField('silicon.enabled','硅矿自动化总开关','switch',{help:'按真实赛季与功能解锁条件运行。奖励由服务器自动结算；一般每10分钟检查，追击或追杀每2分钟，相关推送提前唤醒。'}),
    configField('silicon.dailyRewardLimit','每日奖励结算次数上限','number',{help:'0 表示不额外限制；同时遵守服务端周期上限。达限停止派遣并在游戏允许撤回时撤回；首次缺少当日基线时按当前周期累计次数保守计数。'}),
    configField('silicon.windows','占矿时段','names',{placeholder:'08:00-12:00\n18:00-23:00',help:'北京时间，每行 HH:mm-HH:mm；允许跨午夜，空表示全天。'}),
    configField('silicon.dailyDiamondLimit','每日加速钻石预算','number',{help:'0 禁止加速花钻。还需开启全局钻石消费并满足全局日预算。'}),
    configField('silicon.pursuitMinutes','三日奖励周期重置后追击窗口','number',{unit:'分钟',help:'按服务器三日奖励周期起点计算。只追击黑名单中已在本账号确认击败的对手，不换空矿或新对手；低等矿与只占空位时不追击。'}),
    ...[0,1,2].flatMap(i=>{
      const key='silicon.fleets.'+i+'.',label='舰队'+(i+1)+' · ',when=d=>d.silicon.fleets[i].enabled;
      return [configField(key+'enabled',label+'启用'),
        configField(key+'tier',label+'硅矿等级','choice',{options:[['BLUE','初等'],['PURPLE','中等'],['ORANGE','高等']],parent:key+'enabled',when}),
        configField(key+'emptyOnly',label+'只占空位','switch',{parent:key+'enabled',when,help:'启用后不攻击占领者，也不追击；初等矿始终不攻击占领者。'}),
        configField(key+'opponentOrder',label+'对手战力排序','choice',{options:[['powerDesc','战力从高到低'],['powerAsc','战力从低到高']],parent:key+'enabled',when}),
        configField(key+'maxPowerRatio',label+'敌我最高战力比例','number',{unit:'%',parent:key+'enabled',when}),
        configField(key+'failureLimit',label+'同一对手每日失败上限','number',{parent:key+'enabled',when}),configField(key+'dailyAttackLimit',label+'每日进攻上限','number',{parent:key+'enabled',when,help:'0 表示不额外限制，仍受服务器每日抢占次数及失败限制。'}),
        configField(key+'pursuit',label+'追击已击败对手','switch',{parent:key+'enabled',when,help:'仅在三日奖励重置窗口追击已击败且在游戏黑名单中的对手。开启指定玩家追杀后，优先使用追杀名单。'}),
        configField(key+'huntEnabled',label+'追杀指定玩家','switch',{parent:key+'enabled',when,help:'优先攻击追杀名单中的完整昵称，不需要先击败或添加游戏黑名单；没有合规目标时可占空位，不攻击名单外玩家。仍遵守只占空位、矿级、安全名单、战力、次数和实际汽油库存。'}),
        configField(key+'huntPlayers',label+'追杀名单','names',{parent:key+'huntEnabled',when:d=>when(d)&&d.silicon.fleets[i].huntEnabled,help:'每行一个完整昵称，忽略大小写，不做包含匹配。矿位没有玩家ID，同名玩家无法进一步区分；安全名单与同盟保护优先。'}),
        configField(key+'huntRetreat',label+'追杀撤退策略','choice',{parent:key+'huntEnabled',options:[['never','持续采集'],['afterReward','采一次矿就撤回'],['onTarget','发现名单目标先撤再打']],when:d=>when(d)&&d.silicon.fleets[i].huntEnabled,help:'采一次后撤回：每次占矿首次产奖后撤回，下轮重新寻找名单目标或空位。发现目标后撤回：仅有符合限制的名单目标时撤回，回港确认后重新核对再攻打。游戏要求首轮15分钟产矿完成后才能撤回；返航期间不强行出征。'}),
        configField(key+'safePlayers',label+'安全玩家','names',{parent:key+'enabled',when,help:'完整昵称，每行一个，忽略大小写；不主动攻击这些玩家。'}),configField(key+'safeGuilds',label+'安全联盟编号','names',{parent:key+'enabled',when,help:'游戏显示的联盟数字编号，每行一个；矿位协议不包含联盟名称。'}),
        configField(key+'minDurabilityPercent',label+'最低耐久','number',{unit:'%',parent:key+'enabled',when}),configField(key+'autoRepair',label+'自动维修','switch',{parent:key+'enabled',when}),
        configField(key+'repairSpeedUp',label+'允许加速维修','switch',{parent:key+'enabled',when}),
        configField(key+'marchSpeedUp',label+'允许行军加速','switch',{parent:key+'enabled',when}),configField(key+'marchTargetSeconds',label+'行军剩余目标','number',{unit:'秒',parent:key+'marchSpeedUp',when})].map(field=>({...field,fleetIndex:i,fleetGroup:'silicon'}));
    }),
  ]},
  {id:'ad-rewards',title:'广告奖励',category:'daily',fields:[
    configField('ads.waitSeconds','广告申请后等待','number',{unit:'秒',help:'无免广告权益时默认申请并等待后领取；有权益时立即领取。默认15秒，是挂机收益、英雄招募、工厂加速、藏品招募、广告商店、节庆礼包和雪球礼包都实测成功过的时长。5秒只在藏品招募上测通，广告商店3秒被拒。等待会占用账号操作队列，挂机每轮最多处理1次；服务器返回未完成时跳过该入口并冷却5分钟。'}),
    configField('schedule.afkAd','闯关挂机广告收益','switch',{help:'每天1次。游戏只在普通领取后的60秒内提供此入口，因此需同时开启“闯关挂机收益”，普通领取后立即执行。无免广告权益时按设置的等待时间领取。'}),
    configField('schedule.adShop','广告商店资源','switch',{help:'按商品每日次数领取。无免广告权益时按设置的等待时间领取。'}),
    configField('schedule.compassAdGift','龙王罗盘每日广告礼包','switch',{help:'每天1次，活动开放时可领。无免广告权益时按设置的等待时间领取。'}),
    configField('schedule.adSpeedUpProduce','工厂生产广告加速','switch',{help:'每天3次，每次30分钟，优先剩余时间最长的生产队列，只加速已开工的目标，不使用加速器。遵守工厂禁用名单。无免广告权益时按设置的等待时间领取。'}),
    configField('schedule.adSpeedUpBuilding','建筑升级广告加速','switch',{help:'每天3次，与博物馆展柜共用次数，每次30分钟，只加速施工中的建筑。遵守建筑禁用名单。尚未经真实账号验证，回读确认不到次数变化时不重复提交。无免广告权益时按设置的等待时间领取。'}),
    configField('schedule.adSpeedUpMuseum','博物馆展柜广告加速','switch',{help:'与建筑升级共用每天3次，优先剩余时间更长的目标，到期后自动提交展柜完工。尚未经真实账号验证，回读确认不到次数变化时不重复提交。无免广告权益时按设置的等待时间领取。'}),
  ]},
  {id:'river-series',title:'限时 · 联动系列',category:'daily',fields:[
    configField('schedule.riverScore','走江踏浪 · 积分奖励'),configField('schedule.riverPass','走江踏浪 · 走江战令'),
    configField('schedule.riverHelp','走江助力 · 免费和广告礼包','switch',{help:'广告档要求当前渠道支持，无免广告权益时按“广告奖励”中的等待时间领取。'}),
    configField('schedule.festivalSign','酆都诡事 · 每日签到'),configField('schedule.festivalFreeGift','酆都诡事 · 免费特惠'),
    configField('schedule.festivalActiveRewards','酆都诡事 · 活跃奖励'),configField('schedule.edict','酆都法旨 · 解符'),configField('schedule.evilExpel','驱邪除祟 · 累计奖励'),
    configField('schedule.edictPass','酆都法旨 · 法旨战令','switch',{help:'默认关闭。只领取积分已达标的档位，不消耗贡品；已购通行证时一并领取对应奖励。'}),
    configField('schedule.compassDaily','龙王罗盘 · 每日免费礼包'),configField('schedule.compassReward','龙王罗盘 · 积分奖励'),
    configField('schedule.compassSpin','龙王罗盘 · 自动抽取'),
    configField('eventActions.compassThreshold','铜钱达到多少开始抽取','number',{ parent: 'schedule.compassSpin',unit:'枚',help:'每轮先核对活动、道具单价与库存，默认10枚。'}),
    configField('eventActions.compassDrawCount','每批最多抽取','choice',{ parent: 'schedule.compassSpin',numeric:true,options:[[1,'1次'],[5,'5次'],[10,'10次'],[50,'50次']],help:'按实际铜钱和游戏支持的批次选择，每轮最多一批。'}),
  ]},
  { id: 'building', title: '建筑', category: 'base', fields: [
    configField('building.enabled', '总开关'), configField('building.collect', '自动领取产出'), configField('building.build', '自动建造'),
    configField('building.upgrade', '自动升级'), configField('building.finish', '自动完工'),
    configField('building.supply', '缺料时为建筑备料', 'switch', { help: '为符合等级和前置条件的建造、升级补产材料，遵守工厂开关、禁用名单和需求优先级。' }),
    configField('building.disabledTypes', '禁止建筑', 'multi', { catalog: 'buildings', empty: '未选择，允许全部建筑', help: '所选类型不再自动建造、升级或备料；产出领取与已有施工的完工独立控制。' }),
    configField('building.speedUp', '自动加速', 'switch', { help: '只使用已有加速器，并遵守公共保留数量。' }),
    configField('building.keepBlueprints', '保留建筑蓝图数量', 'number', { unit: '张', help: '消耗后的蓝图数量不得低于此值，0 表示不保留。' }),
    configField('building.maxBuilds', '每轮最多建造', 'number', { parent: 'building.build', unit: '座', help: '填 0 时本轮不新增建造。' }),
    configField('building.maxUpgrades', '每轮最多升级', 'number', { parent: 'building.upgrade', unit: '座', help: '包含为订单升级的工厂，填 0 时本轮不升级。' }),
  ] },
  { id: 'factory', title: '工厂', category: 'base', fields: [
    configField('factory.enabled', '总开关'), configField('factory.gain', '自动领取产品'), configField('factory.produce', '自动生产', 'switch', { help: '按原料、库存、在产和待收数量填充空余队列格。已建成的工厂升级时仍可生产当前等级的配方。' }),
    configField('factory.cooperateNative', '按需求调整游戏自动生产目标', 'switch', { help:'只控制游戏中已开启的原生自动生产目标；关闭后，普通排产仍由“自动生产”和“按需优先生产”控制。开启时补齐种子及上游需求，保留正在生产队列，目标调整后回读确认并间隔至少60秒，不购买材料。' }),
    configField('factory.disabledTypes', '禁用工厂', 'multi', { catalog: 'factories', empty: '未选择，允许全部工厂', help: '控制台不再新增生产或加速，已完成产品仍按领取开关处理。游戏内已有的原生自动生产设置保持原状。' }),
    configField('factory.keepStock', '备货水位', 'number', { unit: '件 / 产品', help: '计入库存、待领取与在产数量，实际不超过游戏仓库上限。0 表示只为需求生产。' }),
    configField('factory.checkEverySeconds', '兜底检查间隔', 'number', { unit: '秒', help: '优先按服务端完工时间和建筑状态推送领取、补产；没有可靠完工时间、缺料、满仓或发生错误时，按此间隔复查。独立于主循环间隔；账号队列占用时等待。' }),
    configField('factory.demandFirst', '按需优先生产', 'switch', { help: '开启后先补所选需求来源。同级需求先选耗时短的产品，有效月卡开启双生产位时可调整同批顺序以缩短工期。关闭后按备货水位从短到长补库存。联盟募兵、红船的独立备料开关仍各自生效。' }),
    configField('factory.demandPriority', '需求优先级', 'priority', { wide: true, help: '按列表顺序优先补料。开启按需优先生产并选择海兽进阶后，同轮进阶投喂、培育喂养和博物馆也按此顺序使用材料。勾选“工厂加速”后，会加速该来源仍缺少的在产物品；移除的来源不会自动补回。' }),
    configField('factory.speedUp', '自动加速生产', 'switch', { help: '与按来源加速独立；两种方式都遵守加速器保留量。' }),
    configField('factory.speedUpItems', '加速物品', 'multi', { parent: 'factory.speedUp', catalog: 'materials', empty: '未选择，允许全部在产物品', when: d => d.factory.speedUp }),
  ] },
  { id: 'farm', title: '农田', category: 'base', fields: [
    configField('farm.enabled', '总开关'), configField('farm.harvest', '自动收割'),
    configField('farm.autoPlant', '自动种植', 'switch', { help: '按需求与现有种子安排作物；与自定义种植互斥，也可都关闭。' }),
    configField('farm.customPlant', '自定义种植', 'switch', { help: '开启后按下方顺序与水位种植，并暂停游戏内的自动种植。' }),
    configField('farm.crops', '种植优先级与备货水位', 'crops', { parent: 'farm.customPlant', wide: true, when: d => d.farm.customPlant, help: '从上向下补足所需作物，计入田间预计产量。水位 0 表示不备货。' }),
    configField('farm.speedUp', '自动加速', 'switch', { help: '只催熟仍有需求的作物，遵守公共加速器保留量。' }),
  ] },
  { id: 'gather', title: '采集', category: 'base', fields: [
    configField('gather.enabled', '采集总开关'),
    configField('gather.fishing', '自动钓鱼', 'switch', { help: '钓具达到 2 级后，每轮一竿；鱼库存满时跳过。' }),
    configField('gather.fishBook','满仓继续开拓大鱼图鉴','switch',{ parent: 'gather.fishing',when:d=>d.gather.fishing,help:'每轮最多一竿。图鉴集齐后自动关闭此项，常规钓鱼仍按仓储上限执行。'}),
    configField('gather.floaters', '自动打捞'), configField('gather.antiqueFloaters','打捞藏品宝箱'),
    configField('gather.continueWhenFull', '满仓继续打捞', 'switch', { parent: 'gather.floaters', help: '仅控制海面原料漂浮物；潜水和拾荒开启后满仓也会继续搜索。', when: d => d.gather.floaters }),
    configField('gather.diving', '自动潜水', 'switch', { help: '玩法达到 2 级后，每轮搜索一次；满仓、溢出或空奖励均继续，升级后按新等级执行。' }),
    configField('gather.keyOpen', '钥匙开箱', 'switch', { parent: 'gather.diving', help: '每轮潜水成功后最多使用 1 把现有保险箱钥匙，不会购买钥匙。', when: d => d.gather.diving }),
    configField('gather.salvage', '自动拾荒', 'switch', { help: '玩法达到 2 级后，每轮搜索一次；满仓、溢出或空奖励均继续，升级后按新等级执行。' }),
    configField('gather.upgradeFishing', '钓鱼升级'), configField('gather.upgradeDiving', '潜水升级'), configField('gather.upgradeSalvage', '拾荒升级'),
    configField('gather.targetLevel', '目标等级', 'number', { unit: '级', help: '达到目标后停止强化和升级；仍需满足游戏建筑数量与等级条件。' }),
    configField('gather.fishingGoldReserve', '钓具强化后保留金币', 'number', { parent: 'gather.upgradeFishing', unit: '金币', when: d => d.gather.upgradeFishing }),
  ] },
  { id: 'resident', title: '居民需求', category: 'base', fields: [
    configField('resident.enabled', '自动满足'), configField('resident.skipCrops', '跳过农作物订单'), configField('resident.skipProduction', '跳过需生产的订单'),
    configField('resident.blockedMaterials', '不准消耗', 'multi', { catalog: 'materials', empty: '未选择，允许消耗所有材料', help: '订单包含所选材料时，不自动交付。' }),
    configField('resident.minExp', '最低经验', 'number', { help: '奖励低于此值或无法确认奖励时跳过，0 表示不限制。' }),
    configField('resident.minGold', '最低金币', 'number', { unit: '金币', help: '0 表示不限制。' }),
    configField('resident.reroll', '不达最低经验或金币时自动换单', 'switch', { help: '任一最低奖励不满足时自动换单，也用于跳过农作物、需生产及禁用材料等不符合条件的订单；达到每日上限不会换单。角色12级起可用，关闭时只跳过并保留原订单。' }),
    configField('resident.dailyCap', '每日满足上限', 'number', { unit: '单', help: '同时参考游戏今日完成数和本工具记录，0 表示不限。' }),
    configField('resident.rewards', '自动领取进度奖励'),
  ] },
  { id: 'cargo', title: '贸易港口', category: 'base', fields: [
    configField('cargo.enabled', '自动贸易'), configField('cargo.dailyLoadLimit', '每日装货上限', 'number', { unit: '次', help: '本工具每批装货请求计 1 次，收货不计；0 表示不限。北京时间每日零点重置。' }),
  ] },
  { id: 'events', title: '随机事件', category: 'base', fields: [
    configField('events.otherOption','其他随机事件默认选项','choice',{options:[[1,'第一个选项'],[2,'第二个选项']],numeric:true,help:'海上资源补给仍选建造居民房，居民离开仍选让他离开；其他已知事件按此选项处理，不把选项名称推断为收益高低。'}),
    configField('events.enabled', '自动处理', 'switch', { help: '海上资源补给选择“建造居民房”；居民离开选择“让他离开”；其他服务器事件按上方默认选项处理，不等待手选。' }),
  ] },
  { id: 'pet', title: '海兽培育室', category: 'base', fields: [
    configField('pet.enabled', '总开关'), configField('pet.claim', '自动领取'), configField('pet.breed', '自动培育'),
    configField('pet.species', '培育种类', 'multi', { parent: 'pet.breed', catalog: 'petSpecies', empty: '未选择品种，不自动培育', when: d => d.pet.breed }),
    configField('pet.release','自动放生','switch',{help:'每轮核对全部库存及上阵、值守、养成状态，处理所选品质的闲置未养成对象。游戏客户端本地锁定名单不可读。'}),
    configField('pet.releaseQualities','处理品质','multi',{ parent: 'pet.release',catalog:'petQualities',empty:'未选择，不处理',when:d=>d.pet.release}),
    configField('pet.quality', '培育品质上限', 'choice', { parent: 'pet.breed', options: [['BLUE', '蓝色'], ['PURPLE', '紫色'], ['ORANGE', '橙色'], ['RED', '红色']], when: d => d.pet.breed, help: '在所选品质及以下，从材料足够的低品质开始尝试。' }),
    configField('pet.universal', '允许消耗万能基因', 'switch', { parent: 'pet.breed', help: '仅在普通基因不足时，用对应的已有自选基因补足。', when: d => d.pet.breed }),
    configField('pet.feed', '自动喂养', 'switch', { help: '消耗服务器列出的喂养材料，加快当前培育。' }),
    configField('pet.advance', '自动进阶', 'switch', { help: '对已入驻的海兽投喂进阶材料；达到喂养和等级要求后进阶。' }),
  ] },
  { id: 'forge', title: '装备自动锻造', category: 'equipment', fields: [
    configField('forge.enabled', '自动锻造总开关', 'switch', { help: '控制普通锻造，随每轮挂机检查所选工厂。军备竞赛的装备打造独立运行：对应活动日可使用本组工厂、配方与预算领取和制造，即使本开关关闭；其他日子普通锻造仍按本开关执行。保存配置后需启动挂机；预览不执行动作。停止总挂机会暂停全部工具锻造，不会关闭游戏内已开启的原生自动锻造。' }),
    configField('forge.buildingIds', '锻造工厂', 'multi', { catalog: 'forgeBuildings', empty: '请选择装备工厂' }),
    configField('forge.nativeAuto', '使用游戏原生自动锻造', 'switch', { help: '开启后由游戏自己的逻辑领取和锻造，本组工具领取、续产、分解、配方、材料保留及预算均不生效，原配置保留；周活动的品质顺序和积分停止规则也不限制游戏原生。需要游戏的装备工厂自动锻造月卡权益，不会自动购买。保存后在挂机运行时同步开关并回读确认。关闭此项后，工具会关闭由本工具开启的原生开关，再按工具配置执行；如需停掉原生自动，请关闭此项并保持挂机运行到确认关闭后再停止。' }),
    configField('forge.collect', '自动领取完工装备', 'switch', { when: d => !d.forge.nativeAuto, help: '领取所选工厂已完成的装备；达到锻造次数或金币预算上限仍可领取。只需领取时，可关闭“自动续产”。' }),
    configField('forge.craft', '自动续产', 'switch', { when: d => !d.forge.nativeAuto, help: '工厂空闲时按下方配方、材料保留和预算继续制造。开启自动领取时，先确认装备入库再续产。' }),
    configField('forge.decompose','自动分解','switch',{when:d=>!d.forge.nativeAuto,help:'每轮核对全部库存及穿戴、养成状态，处理所选品质的闲置未养成对象。游戏客户端本地锁定名单不可读。'}),
    configField('forge.decomposeQualities','处理品质','multi',{ parent: 'forge.decompose',catalog:'equipQualities',empty:'未选择，不处理',when:d=>!d.forge.nativeAuto && d.forge.decompose}),
    configField('forge.recipeIds', '配方优先顺序', 'multi', { parent: 'forge.craft', when: d => !d.forge.nativeAuto && d.forge.craft, catalog: 'forgeRecipes', empty: '请选择锻造配方', help: '按勾选先后依次尝试，使用首个满足赛季、材料和预算的配方。产出装备和星级遵守游戏随机规则。' }),
    configField('forge.universal', '允许万能材料补足', 'switch', { parent: 'forge.craft', when: d => !d.forge.nativeAuto && d.forge.craft, help: '仅补实际不足的对应品质材料，不用来绕过普通材料保留量。' }),
    configField('forge.materialReserve', '普通材料保留量', 'number', { parent: 'forge.craft', when: d => !d.forge.nativeAuto && d.forge.craft, unit: '每种', help: '一次锻造后，每种消耗的普通材料不得低于此值。' }),
    configField('forge.universalReserve', '万能材料保留量', 'number', { parent: 'forge.universal', unit: '每种', when: d => !d.forge.nativeAuto && d.forge.craft && d.forge.universal }),
    configField('forge.goldReserve', '锻造后保留金币', 'number', { parent: 'forge.craft', when: d => !d.forge.nativeAuto && d.forge.craft, unit: '金币' }),
    configField('forge.dailyLimit', '每日锻造次数上限', 'number', { parent: 'forge.craft', when: d => !d.forge.nativeAuto && d.forge.craft, unit: '次', help: '至少1次；只计本工具下单，未知结果仍占额度。' }),
    configField('forge.dailyGoldLimit', '每日锻造金币预算', 'number', { parent: 'forge.craft', when: d => !d.forge.nativeAuto && d.forge.craft, unit: '金币', help: '至少1金币，跨轮和重启保留；不自动购买材料、不消耗钻石或加速器。' }),
  ] },
  { id: 'museum', title: '博物馆探宝', category: 'base', fields: [
    configField('museum.runEnabled', '博物馆探宝总开关', 'switch', { help: '统一暂停博物馆升级、领奖、藏品上架和探宝，保留细项选择。未选择任何执行动作时不会操作。' }),
    configField('museum.upgrade', '自动升级技能与展区'),
    configField('museum.revenue', '自动领取人气币', 'switch', { help: '领取博物馆已积累的营收。' }),
    configField('museum.achievements', '自动领取人气奖励', 'switch', { help: '领取已达成人气档位的成就奖励。' }),
    configField('museum.display', '自动上架藏品', 'switch', { help: '按展柜适配条件自动上架可展示的藏品。' }),
    configField('museum.enabled', '自动探宝', 'switch', { help: '自动领取已完成探险的奖励，并按所选地图、倍数规则继续派遣探险。' }),
    configField('museum.factorMode', '探宝倍数模式', 'choice', { parent: 'museum.enabled', options: [['materials', '材料筛选模式'], ['recommended', '按推荐英雄选择']], help: '按推荐英雄选择时，优先选择符合地图推荐条件的英雄，分别设置满队、不足满队和无推荐英雄时的处理方式。探险时长按游戏地图配置计算。' }),
    configField('museum.factor', '常规探宝倍数', 'choice', { parent: 'museum.enabled', when: d => d.museum.factorMode === 'materials', numeric: true, options: museumFactorOptions, help: '未解锁时按当前最高可用倍数执行，保留已选设置。' }),
    configField('museum.fullRecommendedFactor', '推荐英雄满队倍数', 'choice', { parent: 'museum.enabled', when: d => d.museum.factorMode === 'recommended', numeric: true, options: museumFactorOptions, help: '推荐英雄足以组成完整队伍时使用；未解锁时按当前最高可用倍数执行。' }),
    configField('museum.partialRecommendedFactor', '推荐英雄不足满队倍数', 'choice', { parent: 'museum.enabled', when: d => d.museum.factorMode === 'recommended', numeric: true, options: museumFactorOptions, help: '有推荐英雄但不足一队时使用，其余位置由可用英雄补齐；未解锁时按当前最高可用倍数执行。' }),
    configField('museum.noRecommendedFallback', '无推荐英雄时兜底', 'switch', { parent: 'museum.enabled', when: d => d.museum.factorMode === 'recommended', help: '没有可用推荐英雄时，按兜底倍率派遣其他可用英雄；关闭则跳过该地图的新派遣。' }),
    configField('museum.noRecommendedFactor', '无推荐英雄兜底倍率', 'choice', { parent: 'museum.noRecommendedFallback', when: d => d.museum.factorMode === 'recommended' && d.museum.noRecommendedFallback, numeric: true, options: museumFactorOptions, help: '未解锁时按当前最高可用倍数执行，保留已选设置。' }),
    configField('museum.maxDispatches', '每轮最多派遣队伍', 'number', { parent: 'museum.enabled', unit: '队', help: '0 表示不限，仍需有空闲队伍、英雄和足够材料。' }),
    configField('museum.materialFactor', '根据材料调整倍数', 'switch', { parent: 'museum.enabled', when: d => d.museum.factorMode === 'materials' }),
    configField('museum.factorMaterials', '命中材料名单', 'multi', { parent: 'museum.materialFactor', catalog: 'materials', empty: '未选择，仅检查库存阈值', when: d => d.museum.materialFactor }),
    configField('museum.stockThreshold', '库存阈值', 'number', { parent: 'museum.materialFactor', when: d => d.museum.materialFactor, help: '任一所需材料库存不高于此值时使用命中倍数；0 关闭库存条件。' }),
    configField('museum.matchedFactor', '命中时倍数', 'choice', { parent: 'museum.materialFactor', numeric: true, options: museumFactorOptions, when: d => d.museum.materialFactor }),
    configField('museum.maps', '探宝地图', 'multi', { parent: 'museum.enabled', catalog: 'maps', empty: '未选择，不限制地图', help: '控制新派遣与指南使用；已经完成的探宝仍可领取。' }),
    configField('museum.useGuide', '使用探险指南', 'switch', { parent: 'museum.enabled' }),
    configField('museum.dailyGuideLimit', '每日指南上限', 'number', { parent: 'museum.useGuide', unit: '本', help: '每本缩短 30 分钟，填 0 表示不使用；保存配置或重启不会清零当日记录。' }),
  ] },
  { id: 'resources', title: '加速与钻石', category: 'base', fields: [
    configField('resources.keepAccelerators', '保留加速器数量', 'number', { unit: '个', help: '所有自动加速共用保留量，消耗后不得低于此值。' }),
    configField('resources.allowDiamonds', '自动钻石消耗总开关'),
    configField('resources.diamondThreshold', '钻石保留阈值', 'number', { parent: 'resources.allowDiamonds', unit: '钻石', help: '本工具消费后余额不得低于此值。游戏内手动消费不受此开关限制。' }),
    configField('resources.diamondDailyLimit', '每日钻石使用量', 'number', { parent: 'resources.allowDiamonds', unit: '钻石', help: '0 表示禁止自动花钻石。统计启用本版本后的自动消费，升级前与游戏内手动消费不计入。北京时间零点重置；结果不明的已发送消费仍占额度。' }),
  ] },
  { id: 'gold', title: '每日点金', category: 'base', fields: [
    configField('gold.enabled', '每日付费点金'), configField('gold.times', '点金次数', 'number', { unit: '次 / 天', help: '请先用完当天的免费点金，可手动使用或开启免费点金挂机。这个目标只统计付费次数，包含手动付费。上笔结果待确认时会保留额度，暂停追加。' }),
  ] },
  { id: 'treasure', title: '万吨巨轮', category: 'world', fields: [
    configField('treasure.enabled', '巨轮自动化总开关', 'switch', { help: '开始挂机后生效，独立于基地自动化。按所选舰队、参与模式和实际汽油库存出征；耐久不足可先普通维修。不会召回、补油或修改编队。' }),
    configField('treasure.qualities', '常规参与货轮类型', 'multi', { catalog: 'treasureQualities', selectAll: true, empty: '未选择，暂停常规派遣和跟随', help: '勾选常规自动参加和跟随时可以抢的货轮类型，可多选。中小货轮兜底按下方设置，独立选择货轮。' }),
    configField('treasure.autoJoin', '常规自动参加', 'switch', { when:d=>!d.treasure.follow, help:'仅在未开启指定跟随时生效。开启跟随后，首次出征必须匹配名单，不使用常规自动参加兜底；已确认的跟随按反复攻占设置接续。' }),
    configField('treasure.participationMode', '参与模式', 'radio', { options: [['untilFull', '打满就停'], ['always', '每次参与']], help: '打满就停：达到游戏今日领奖上限后不再派遣或维修。每次参与：领奖已满仍可参加，但不增加奖励次数，其他限制仍有效。' }),
    configField('treasure.repeatAttack', '反复攻占', 'switch', { help: '已确认出征后，被打回或返航且回到主城空闲时，可再次参与同一货轮。开启跟随后，由“跟随后续出征方式”决定是否重新匹配跟随玩家；关闭反复攻占时，即使重新匹配也不会再次参与同一货轮。请求结果未知时继续等待确认。' }),
    configField('treasure.follow', '跟随指定玩家', 'switch', { help: '识别名单中正在前往货轮的舰队，也兼容当前守军。开启反复攻占后，可选择首次跟随后自主攻占或每次重新跟随。收到可识别的出发推送后会提前唤醒检查，每次发送前仍核对目标、汽油库存、避战和舰队占用。历史排名、已返航或过期行军不会触发跟随；不能保证同时抵达或必得奖励。' }),
    configField('treasure.followMode', '跟随后续出征方式', 'radio', { parent: 'treasure.follow', when: d => d.treasure.follow && d.treasure.repeatAttack, options: [['trigger', '首次跟随后自主攻占'], ['eachTime', '每次重新跟随']], help: '默认首次跟随后自主攻占：同一舰队对同一货轮首次跟随确认后，可在跟随玩家离开后继续攻占，重启和换日保留确认。每次重新跟随：每次出征前都重新匹配名单玩家的有效行军或当前守军，没有匹配就等待，历史确认不再放行。两种方式都需要开启反复攻占才能再次参与同一货轮；另行开启的中小货轮兜底仍可独立派遣。' }),
    configField('treasure.fleetIds', '参与舰队', 'multi', { catalog: 'expeditionFleets', empty: '请选择参与舰队，空选不派遣', help: '只使用已建成、有英雄编队且实际空闲的舰队；行军、战斗、维修和驻外等占用会跳过。游戏自动作战开关开启不等于正在作战。' }),
    configField('treasure.followPlayerIds', '跟随名单', 'players', { parent: 'treasure.follow', when: d => d.treasure.follow, help: '从当前账号的盟友名单搜索多选，按选择顺序优先跟随。使用完整角色 ID 区分同名玩家；也可补充未列出的角色 ID。未列出的已选 ID 仍保留，需要时手动移除。' }),
    configField('treasure.followNames', '补充跟随昵称（可选）', 'names', { parent: 'treasure.follow', when: d => d.treasure.follow, help: '保留原有手填名单。每行一个完整昵称，角色 ID 名单优先；同名无法确认身份时跳过。', placeholder: '每行输入一位其他玩家的完整昵称' }),
    configField('treasure.rewardItems', '目标奖励（任一匹配）', 'multi', { catalog: 'treasureRewards', empty: '不筛选奖励', help: '自动参加和跟随时，货轮含任一勾选奖励即符合奖励条件。留空接受所有奖励。可搜索完整物品名称。“垃圾袋（任意品质）”匹配各品质垃圾袋，选择具体品质则只匹配该品质。' }),
    configField('treasure.fallbackEnabled', '中小货轮兜底', 'switch', { help: '到达兜底开始时间后，若今日领奖未达目标且舰队没有符合常规规则的货轮，按下方设置的货轮类型和奖励优先级派遣。即使常规类型留空或跟随名单未命中也可兜底，仍遵守避战、外盟权限、进度、耐久、汽油库存和出征上限。' }),
    configField('treasure.fallbackAfter', '兜底开始时间', 'time', { parent: 'treasure.fallbackEnabled', when: d => d.treasure.fallbackEnabled, help: '按北京时间每天从此时刻检查至当天结束。请按所在区服最后一轮万吨时间设置，默认 21:00。' }),
    configField('treasure.fallbackTargetRewards', '兜底领奖目标', 'number', { parent: 'treasure.fallbackEnabled', when: d => d.treasure.fallbackEnabled, unit: '次 / 天', help: '以服务器今日已领奖次数为准，最多补至游戏每日领奖上限。达到目标后停止中小货轮兜底，“每次参与”模式也遵守此目标。' }),
    configField('treasure.fallbackQualities', '兜底货轮优先级', 'priority', { parent: 'treasure.fallbackEnabled', when: d => d.treasure.fallbackEnabled, options: [['PURPLE', '中型货轮'], ['BLUE', '小型货轮']], itemLabel: '货轮类型', empty: '请选择至少一种兜底货轮。', help: '按列表从上到下选择类型，可移除不参加的类型。每种类型内再按对应奖励优先级匹配。' }),
    configField('treasure.fallbackMediumRewardPriority', '中型货轮奖励优先级（任一匹配）', 'priority', { parent: 'treasure.fallbackQualities', when: d => d.treasure.fallbackEnabled && d.treasure.fallbackQualities.includes('PURPLE'), catalog: 'treasureRewards', checkboxes: true, empty: '不筛选奖励', help: '中型货轮含任一勾选奖励即符合兜底奖励条件。多艘符合时，优先选择含排名靠前奖励的货轮。留空接受所有奖励。' }),
    configField('treasure.fallbackSmallRewardPriority', '小型货轮奖励优先级（任一匹配）', 'priority', { parent: 'treasure.fallbackQualities', when: d => d.treasure.fallbackEnabled && d.treasure.fallbackQualities.includes('BLUE'), catalog: 'treasureRewards', checkboxes: true, empty: '不筛选奖励', help: '小型货轮含任一勾选奖励即符合兜底奖励条件。多艘符合时，优先选择含排名靠前奖励的货轮。留空接受所有奖励。' }),
    configField('treasure.avoidNames', '避战玩家名称', 'names', { help: '每行填写一位玩家的完整昵称，按名称完全匹配，同名玩家都会避开。只判断货轮当前守军和战斗者；历史排名中已离开的玩家不会单独触发。避战优先于跟随。', placeholder: '每行输入一位玩家的完整昵称' }),
    configField('treasure.avoidPlayerIds', '已有避战角色 ID', 'names', { when: d => d.treasure.avoidPlayerIds.length > 0, help: '保留此前保存的精确角色 ID，每行一个。可删除不再需要的条目；新玩家请在上方填写名称。', placeholder: '每行一个已有的完整角色 ID' }),
    configField('treasure.allowHostile', '允许争夺其他联盟货轮', 'switch', { help: '默认关闭，只参与无人占领或本联盟货轮。开启后可能与其他联盟交战，跟随名单也受此开关约束。' }),
    configField('treasure.minDurabilityPercent', '最低舰队耐久', 'number', { unit: '%', help: '低于此比例时先维修；关闭自动维修则跳过。0 不设比例阈值，但零耐久仍需维修。未知耐久上限不会自动维修或出征。' }),
    configField('treasure.autoRepair', '耐久不足自动维修', 'switch', { help: '有符合条件的货轮时，按服务器报价普通维修至满耐久，完成后重新检查目标再派。不会使用钻石或加速维修。' }),
    configField('treasure.marchSpeedUp', '允许行军加速', 'switch', { help: '默认关闭。仅加速本工具已确认派出的巨轮舰队，缩短出征航程。每次钻石费用读取游戏配置，还需开启全局钻石消费，并满足全局每日预算和钻石保留量。' }),
    configField('treasure.marchTargetSeconds', '行军剩余目标', 'number', { parent: 'treasure.marchSpeedUp', when: d => d.treasure.marchSpeedUp, unit: '秒', help: '默认60秒。剩余航程超过此值时才加速，每次缩短时间以游戏为准。0表示在航程结束前持续按预算检查加速。' }),
    configField('treasure.dailyDiamondLimit', '每日行军加速钻石预算', 'number', { parent: 'treasure.marchSpeedUp', when: d => d.treasure.marchSpeedUp, unit: '钻石', help: '默认0，0禁止加速花钻。与全局每日钻石预算同时生效，结果未确认的加速继续占用预算。' }),
    configField('treasure.maxProgress', '巨轮整体进度阈值', 'number', { unit: '%', help: '货轮达到此占领进度后不再派遣，减少临近结束时白跑。' }),
    configField('treasure.personalProgressLimit', '个人进度上限', 'number', { unit: '%', help: '本人在单艘货轮的实际占领进度达到上限后，不再新派遣或为该货轮备战维修，反复攻占也不例外。0表示禁止新派遣。只读取实际个人进度，查询失败先等待核对；已出发、排队或驻守的舰队不会被强制召回。' }),
    configField('treasure.dailyDispatchLimit', '每日舰队出征上限', 'number', { unit: '次', help: '每次派遣一支舰队计 1 次，重复参与也计数；0 表示不限制工具次数，仍遵守参与模式。北京时间零点换日。' }),
    configField('treasure.checkEverySeconds', '检查间隔', 'number', { unit: '秒', help: '挂机运行时每 5–300 秒检查一次。保存配置不会开始挂机。' }),
  ] },
  { id:'radar',title:'联盟情报',category:'world',fields:[
    configField('radar.runEnabled','联盟情报总开关','switch',{help:'统一暂停情报处理和舰队维修，保留细项选择。未选择任何执行动作时不会操作。'}),
    configField('radar.enabled','自动处理情报'),
    configField('radar.repairIdle','自动维修空闲舰队','switch',{help:'普通维修耐久低于80%的空闲舰队，按实际汽油库存检查。'}),
    configField('radar.fleetIds','情报参与舰队','multi',{ parent: 'radar.enabled',catalog:'expeditionFleets',empty:'未选择舰队，仅领取奖励；选择后才派遣',help:'使用空闲且已编队舰队；可与巨轮、城战、首杀共用舰队，只使用实际空闲且无待确认任务的舰队。'}),
    configField('radar.types','情报类型','multi',{ parent: 'radar.enabled',catalog:'radarTypes',empty:'未选择，暂停新派遣'}),
    configField('radar.allowMaterials','允许交付难民情报材料','switch',{ parent: 'radar.enabled',help:'仅使用现有足量材料，不购买，不交付钻石。'}),
    configField('radar.minDurabilityPercent','最低舰队耐久','number',{ parent: 'radar.enabled',unit:'%'}),
    configField('radar.checkEverySeconds','情报检查间隔','number',{ parent: 'radar.enabled',unit:'秒'}),
  ] },
  { id: 'progression', title: '推关与试炼', category: 'world', fields: [
    configField('progression.enabled','推关与试炼总开关'),
    configField('progression.mainline','主线 / 闯关自动挑战','switch',{help:'主线推关与闯关是同一个玩法。随挂机每轮挑战当前关卡一次，胜利后下一轮继续推进。'}),
    configField('lineups.mainlinePresetId','自动主线挑战阵容','lineup',{parent:'progression.mainline',help:'与挑战页共用此阵容选择，按账号保存。挑战时临时使用所选阵容，每场结束后恢复挑战前的游戏阵容。'}),
    configField('progression.trials','试炼自动推关','switch',{help:'每轮依次挑战所选副本的下一关，无需每轮手动开始。达到停止上限只暂停对应副本，其他玩法继续。'}),
    configField('progression.raidIds','自动推关副本','multi',{ parent: 'progression.trials',catalog:'trialRaids',empty:'请选择自动推关副本'}),
    configField('lineups.trialPresets','各副本自动挑战阵容','trialLineups',{parent:'progression.trials',help:'与挑战页共用各副本的阵容选择，按账号保存。自动挑战只在已开启自动推关的副本中生效，每场结束后恢复挑战前的游戏阵容。'}),
    configField('progression.maxFailures','失败停止次数','number',{unit:'次',help:'主线与每个试炼分别累计同一关的连续战败，通关清零。跨挂机轮次和断线重连保留；达到上限后本次挂机不再重试，暂停后重新开始挂机可重试。不是挑战总次数，也不统计网络错误。仅用于挂机，挑战页手动参数独立。'}),
    configField('schedule.trialSweep','试炼首轮免费扫荡','switch',{help:'只使用免费档位，扫荡与自动推关分别控制，不计入失败停止次数。'}),
  ] },
  { id: 'pirate-hunt', title: '海盗讨伐', category: 'world', description: '免费扫荡已首杀的最高等级；派遣舰队挑战下一等级可推进首杀。两项独立开启。', fields: [
    configField('schedule.pirate','每日免费扫荡','switch',{help:'使用游戏每日免费扫荡次数，三种海盗共用。无需舰队，不消耗汽油、耐久或钻石；日常任务完成后仍按剩余扫荡次数执行。'}),
    configField('pirateSweep.type','扫荡海盗种类','choice',{options:[['1','海盗先锋'],['2','海盗精锐'],['3','海盗头目']],help:'默认海盗先锋。自动使用所选种类已首杀的最高等级；地图暂时没有该等级目标时等待，不自动改种类或降级。'}),
    configField('pirateHunt.enabled','自动讨伐首杀'),
    configField('pirateHunt.maxFailures','失败停止次数','number',{unit:'次',help:'只统计本人战报确认的连续战败，首杀成功清零。跨挂机轮次和重连保留，达到上限后停止本次挂机的海盗派遣；暂停后重新开始挂机可重试。结果未确认时保留记录，不按战败重发。'}),
    configField('pirateHunt.fleetIds','首杀参与舰队','multi',{catalog:'expeditionFleets',empty:'请选择首杀舰队',help:'每次只派一支空闲舰队。可与巨轮、城战、情报共用舰队；实际占用或结果待确认时跳过，不抢占任务。'}),
    configField('pirateHunt.types','首杀海盗种类','multi',{catalog:'pirateTypes',empty:'所有类型',help:'从各类型本人尚未首杀的下一等级开始，优先较低等级；空选表示所有类型。'}),
    configField('pirateHunt.maxLevel','推进等级上限','number',{unit:'级',help:'0表示推进到游戏当前允许的等级。每次必须确认本人首杀记录更新后才推进下一级。'}),
    configField('pirateHunt.minDurabilityPercent','最低舰队耐久','number',{unit:'%',help:'低于阈值停止，不自动修理；零耐久或无法确认上限也不派遣。'}),
    configField('pirateHunt.checkEverySeconds','手动推进战果检查间隔','number',{unit:'秒',help:'手动连续推进按此间隔检查，自动讨伐随挂机每轮检查。连续战败达到失败停止次数或结果不明时停止；已出征舰队不会强制召回。'}),
  ] },
  { id: 'cityWar', title: '联盟城战', category: 'world', fields: [
    configField('schedule.guildWelfare', '领取联盟福利礼包'),
    configField('schedule.guildTitleReward', '联盟每日职级礼包', 'switch', { help:'默认关闭。按服务器提供的可领取职级核对每日礼包，不以当前职位替代；确认奖励回执及当日领取时间后才记为成功。' }),
    configField('schedule.worldOnlineRewards', '领取城战在线奖励', 'switch', { help: '在服务器城战时段内，按实际计时逐档领取免费在线奖励。独立于下方城战接续开关；默认关闭，保存后随挂机检查，不自动启动挂机。请求结果未知时等待计数确认，不重复领取。' }),
    configField('cityWar.enabled', '城战接续总开关', 'switch', { help: '按下方原生委任次数决定何时接续正常出战，每支参与舰队可指定进攻或防守。下方预览范围选择“联盟城战”；不会宣战或改变集结目标。' }),
    configField('cityWar.fleetIds', '城战参与舰队', 'multi', { catalog: 'expeditionFleets', empty: '请选择参与接续的舰队' }),
    configField('cityWar.defenceFleetIds', '舰队职责与策略', 'cityWarRoles', { parent: 'cityWar.fleetIds', wide: true, help: '为已选舰队分别选择进攻或防守；展开后可设置本队策略、维修加速和派遣加速。策略可跟随全局，也可独立设置目标来源、城市和优先策略。加速需开启城战接续和“基础 → 加速与钻石”中的自动钻石消耗总开关，每队每项上限与全局钻石预算同时生效。切换职责保留本队另一套策略；新加入的舰队默认进攻。进攻只选择本盟已宣战且仍属于敌方的城市，防守只选择被宣战且仍属于本盟的城市；没有对应目标时等待，不自动换职责。使用舰队已保存的英雄编队，不自动换阵。职责仅约束工具接管后的派遣；要立即按此分工执行，将原生委任次数设为 0。' }),
    configField('cityWar.nativeCommissionLimit', '原生委任次数', 'number', { unit: '次', help: '-1 表示按服务器 VIP 规则等待额度用尽。0 表示关闭所选舰队的原生委任，由工具立即接续。N 表示先让原生委任使用 N 次（不超过 VIP 额度），再关闭开关并由工具接续。原生委任跟随联盟集结，攻守职责与各自目标配置在工具接管后生效。需要立即按设置执行时设为 0，工具会先回读确认关闭。' }),
    configField('cityWar.targetMode', '进攻目标来源', 'choice', { options: [['alliance', '跟随联盟有效进攻目标'], ['selected', '只选择指定城市']], help: '进攻队使用本组目标来源、城市和优先策略。目标须为本盟已宣战且当前属于敌方的城市。攻守目标设置在工具接管后生效，需要立即执行时将原生委任次数设为 0。' }),
    configField('cityWar.targetPriority', '进攻目标优先', 'choice', { options: [['fewestAllied', '按队数与距离选择'], ['original', '沿用集结／指定城市顺序']], help: '合计本盟排队、交战、已同步在途和本轮安排的舰队。以队数最少的城为基准，相差 0–9 队时选较近目标，差 10 队及以上时优先队数较少的城。多盟同攻时，攻方队列为空或排队明细与总数吻合即可确认本盟排队数。队数不明时，按队数选城会跳过该城，按集结或指定顺序仍可派舰。发送前重新核对。' }),
    configField('cityWar.cityRefs', '指定进攻城市', 'multi', { parent: 'cityWar.targetMode', catalog: 'cityTargets', empty: '请选择当前场景的进攻城市', when: d => d.cityWar.targetMode === 'selected', help: '进攻队在本名单内选择有效目标。启用队数与距离优先时按上述规则排序，勾选顺序用于同条件时的次序。场景不匹配、未宣战或城市归属不符合进攻职责时跳过，没有有效目标时等待。' }),
    configField('cityWar.defenceTargetMode', '防守目标来源', 'choice', { options: [['alliance', '跟随联盟有效防守目标'], ['selected', '只选择指定城市']], help: '防守队使用本组目标来源、城市和优先策略，可与进攻队分别选择自动选城或指定城市。目标须为正在受宣战且当前属于本盟的城市。' }),
    configField('cityWar.defenceTargetPriority', '防守目标优先', 'choice', { options: [['fewestAllied', '按队数与距离选择'], ['original', '沿用集结／指定城市顺序']], help: '按守方队列、本盟正在交战和已同步在途舰队总数选城，本轮安排也计入。守方队列采用服务器计数，可能包含城防 NPC。以队数最少的城为基准，相差 0–9 队时选较近目标，差 10 队及以上时优先队列较少的城。数量无法确认时跳过。防守己城行军汽油为 0，远近按实际距离比较，发送前重新核对。' }),
    configField('cityWar.defenceCityRefs', '指定防守城市', 'multi', { parent: 'cityWar.defenceTargetMode', catalog: 'cityTargets', empty: '请选择当前场景的防守城市', when: d => d.cityWar.defenceTargetMode === 'selected', help: '防守队在本名单内选择有效目标。启用队数与距离优先时按上述规则排序，勾选顺序用于同条件时的次序。场景不匹配、未受宣战或城市归属不符合防守职责时跳过，没有有效目标时等待。' }),
    configField('cityWar.autoRepair', '耐久不足时维修', 'switch', { help: '仅正常维修；按服务器返回的完整维修报价核对实际汽油库存，维修完成后再出战。' }),
    configField('cityWar.repairBelowPercent', '低于此耐久比例先维修', 'number', { unit: '%', help: '还须达到游戏配置的城战基础耐久门槛；实际扣除随交战对象变化，不保证每场只扣基础值。已在行军、战斗、维修、驻外或其他任务中的舰队不被抢占。' }),
    configField('cityWar.reserveDuringWar', '城战期间为所选舰队保留任务', 'switch', { help: '城战时段存在符合舰队职责的有效目标时，为对应舰队保留任务；没有防守目标时不预留防守队，没有进攻目标时不预留进攻队。已在执行巨轮或其他任务的舰队等待空闲，不主动召回。' }),
    configField('cityWar.checkEverySeconds', '城战检查间隔', 'number', { unit: '秒' }),

    ...[0,1,2].flatMap(i=>{
      const key='fleetSpeed.fleets.'+i+'.', label='舰队'+(i+1)+' · ';
      return ['repair','march'].flatMap(mode=>{
        const title=mode==='repair'?'维修':'派遣',when=d=>d.fleetSpeed.fleets[i][mode];
        return [configField(key+mode,label+'允许'+title+'加速','switch'),
          configField(key+mode+'SmartSave',label+title+'智能省钻','switch',{parent:key+mode,when,help:mode==='repair'?'仅控制本队维修。开启后在分钟计费边界短等一次，例如2:01等到1:59。关闭后预算足够且超过剩余时间阈值就直接加速，不影响派遣省钻。':'仅控制本队派遣。逐次加速并回读，最后接近目标时短等一次，省掉下一次固定费用；节省时间太少也不花钻。关闭不影响维修省钻。'}),
          configField(key+mode+'SmartWaitSeconds',label+title+'省钻最多等待','number',{unit:'秒',parent:key+mode+'SmartSave',when:d=>when(d)&&d.fleetSpeed.fleets[i][mode+'SmartSave'],help:'默认5秒。每次维修或整段航程只允许一次短等，截止时间固定，避免反复等待耽误效率；重连不重新计时。'}),
          configField(key+mode+'SkipSeconds',label+title+'剩余多少秒不加速','number',{unit:'秒',parent:key+mode,when,help:'剩余时间小于等于此值直接等待，不花钻。默认60秒；0表示以完成为目标，智能省钻开启时仍可短等。'}),
          ...(mode==='march'?[configField(key+'marchMinSavedSeconds',label+'每次至少节省多少秒','number',{unit:'秒',parent:key+'marchSmartSave',when:d=>when(d)&&d.fleetSpeed.fleets[i].marchSmartSave,help:'仅派遣智能省钻开启时生效。行军每次速度翻倍；预计节省不足此值就不花钻，防止为几秒钟反复付费。'})]:[]),
          configField(key+mode+'DailyDiamonds',label+title+'每日钻石上限','number',{unit:'钻石',parent:key+mode,when,help:'0 禁止。该队此种加速独立计数，与全局钻石日预算同时生效；北京时间换日。'+(mode==='repair'?'钻石维修一次完成，按分钟进位及全角色共享的当天阶梯费率计价，不能指定部分加速；累计量缺失或前次结果未知时按最高档预算。':'同一航程多次加速均计入本项每日用量，每次回读确认后才决定下一次，达到剩余时间目标立即停止。')})];
      }).map(field=>({...field,fleetIndex:i,fleetGroup:'fleetSpeed',section:label+'加速'}));
    })
  ] },
  { id: 'heroes', title: '英雄养成', category: 'heroes', fields: [
    configField('heroes.enabled', '养成总开关'), configField('loop.heroes', '加入自动挂机'),
    configField('heroes.heroIds', '指定英雄', 'multi', { catalog: 'heroes', empty: '留空则暂停培养，不影响技能展示领奖', help: '可搜索并选择多个英雄。升级、升星等培养操作只处理名单中已拥有的英雄；技能展示领奖覆盖所有已拥有的英雄。' }),
    configField('heroes.level', '自动升级'), configField('heroes.star', '自动升星'),
    configField('heroes.skill', '技能升级'), configField('heroes.skillAdvance', '技能进阶'),
    configField('heroes.exclusiveLevel', '专武升级'), configField('heroes.exclusiveStar', '专武升星'),
    configField('heroes.showSkillReward', '领取技能展示奖励', 'switch', { help: '领取所有已拥有英雄的技能展示奖励，不受指定英雄名单限制；已领取的英雄自动跳过。' }),
    configField('heroes.universal', '英雄升星允许使用万能碎片', 'switch', { section: '高级设置', startCollapsed: true }),
    configField('heroes.keepExp', '保留英雄经验', 'number', { section: '高级设置' }),
    configField('heroes.targetLevel', '目标等级', 'number', { section: '高级设置', unit: '级', help: '0 表示采用游戏当前允许的上限。' }),
    configField('heroes.targetStar', '目标星级', 'number', { section: '高级设置', unit: '星', help: '0 表示采用游戏上限。' }),
  ] },
  { id: 'antique', title: '藏品养成', category: 'antique', fields: [
    configField('antique.enabled', '藏品养成总开关', 'switch', { moduleControl: true, help: '只在已有碎片、经验或金币足够时操作，不购买、不消耗钻石。结果未知时保留记录，不重复发送。' }),
    configField('antique.activate', '自动激活藏品', 'switch', { help: '使用对应藏品碎片激活，稀有/史诗/传说/超凡分别需要 10/10/10/50 个碎片。万能碎片不会自动兑换。' }),
    configField('antique.activateQualities', '激活品质', 'multi', { parent: 'antique.activate', catalog: 'antiqueQualities', empty: '未选择，不激活', when: d => d.antique.activate }),
    configField('antique.star', '自动升星', 'switch', { help: '按当前星级消耗对应颜色碎片；已激活藏品按品质和顺序处理。' }),
    configField('antique.starQualities', '升星品质', 'multi', { parent: 'antique.star', catalog: 'antiqueQualities', empty: '未选择，不升星', when: d => d.antique.star }),
    configField('antique.targetStar', '升星目标星级', 'number', { parent: 'antique.star', unit: '星', when: d => d.antique.star, help: '0 表示升到当前配置最高星级。' }),
    configField('antique.universal', '允许万能碎片补足升星', 'switch', { parent: 'antique.star', when: d => d.antique.star, help: '只在普通碎片不足时使用；不会用于激活。' }),
    configField('antique.master', '自动提升藏品大师等级', 'switch', { help: '消耗藏品大师徽章，并满足下一等级要求的总星级。' }),
    configField('antique.targetMasterLevel', '大师目标等级', 'number', { parent: 'antique.master', unit: '级', when: d => d.antique.master, help: '0 表示升到当前配置最高等级。' }),
    configField('antique.suit', '自动激活/升级套装', 'switch', { help: '普通套装需集齐本套装藏品；红色套装至少激活 2 件。升级消耗金币和对应颜色藏品经验。' }),
    configField('antique.suitQualities', '套装品质', 'multi', { parent: 'antique.suit', catalog: 'antiqueQualities', empty: '未选择，不升级套装', when: d => d.antique.suit }),
    configField('antique.goldReserve', '套装升级后保留金币', 'number', { parent: 'antique.suit', unit: '金币', when: d => d.antique.suit }),
    configField('antique.dailyGoldLimit', '每日套装金币预算', 'number', { parent: 'antique.suit', unit: '金币', when: d => d.antique.suit, help: '0 表示不限额；跨日重置，未确认的消耗仍占预算。' }),
  ] },
  { id: 'hero-recruit', title: '英雄招募', category: 'heroes', fields: [
    configField('schedule.heroAdRecruit','英雄广告招募','switch',{help:'每天3次，不消耗招募券或钻石。无免广告权益时按设置的等待时间领取。'}),
  ] },
  { id: 'antique-recruit', title: '藏品招募', category: 'antique', fields: [
    configField('schedule.antiqueAdRecruit','藏品广告招募','switch',{help:'每天3次，不消耗招募券或钻石。无免广告权益时按设置的等待时间领取。'}),
  ] },
  { id: 'rewards', title: '任务与奖励', category: 'daily', fields: [
    configField('tasks.main', '领取主线奖励'), configField('tasks.branch', '领取支线奖励'), configField('tasks.achievements', '领取成就奖励'),
    configField('dailies.enabled', '日常总开关', 'switch', { help: '控制本组每日任务与奖励。基地页的付费点金独立设置。' }), configField('dailies.claimTasks', '领取每日任务奖励'),
    configField('dailies.claimDailyChest', '领取每日活跃宝箱'), configField('dailies.claimWeeklyChest', '领取每周活跃宝箱'), configField('dailies.claimGift', '领取每日免费赠礼'),
    configField('schedule.comicDrama','漫剧观看与每日奖励','switch',{help:'默认关闭。已解锁的集数每轮最多处理 10 集，并在每天领取 1 次每日奖励；当天没有新集时重看最后一集以满足领取条件。'}),
    configField('schedule.tournamentDailyGift','擂台赛每日礼包','switch',{help:'默认关闭。只在擂台赛进行阶段按服务器记录每天领取 1 次，不参与投注和布阵。'}),
    configField('schedule.seasonChest','赛季宝箱用钥匙开启','switch',{help:'默认关闭。每箱消耗服务器指定的 3 把钥匙，每轮最多 5 箱，钥匙不足时等待，不花钻石，也不发起钥匙交换。钥匙在进入新赛季时清零，建议赛季内开启。'}),
  ] },
  { id:'worldBoss',title:'世界Boss',category:'world',fields:[
    configField('worldBoss.enabled','每日首战自动派遣'),
    configField('schedule.worldBossRewards','自动领取伤害达标奖励','switch',{help:'随挂机领取已达到伤害档位的奖励。独立于每日首战自动派遣，关闭首战派遣后仍可领奖；开启领奖不会派出舰队。'}),
    configField('worldBoss.fleetIds','首战参与舰队','multi',{catalog:'expeditionFleets',selectAll:true,empty:'未选择，自动选一支空闲舰队',help:'勾选多支时一起派出符合条件的舰队；未选择时自动选一队。遵守统一任务顺序和在途保护。'}),
    configField('worldBoss.fleetPresets','各舰队出战阵容','fleetLineups',{parent:'worldBoss.fleetIds',wide:true,help:'为已勾选的舰队选择保存的阵容；未指定时使用该舰队当前阵容。只切换英雄与阵型，英雄不得与其他舰队重复。战斗结束并返航后恢复原阵容。'}),
    configField('worldBoss.minDurabilityPercent','最低耐久','number',{unit:'%',help:'0表示不设百分比门槛，仍须有耐久。'}),
  ]},
  { id:'fleet-dispatch',title:'舰队调度',category:'world',fields:[configField('fleetDispatch.priority','任务优先顺序','dispatchOrder',{wide:true,help:'从上到下检查，已出征舰队不抢占。有效城战时段预留优先；已启动首杀对较低优先级任务预留舰队，无目标后释放。巨轮跟随独立排序；当天世界Boss首战完成后释放舰队。'})]},
];


// 世界页常用玩法置前；不覆盖用户已保存的实际派遣顺序。
const worldFirst = ['cityWar','treasure','silicon','resourceFields'];
configGroups.sort((a,b)=>(worldFirst.includes(a.id)?worldFirst.indexOf(a.id):3)-(worldFirst.includes(b.id)?worldFirst.indexOf(b.id):3));
// 全局攻守策略与逐队编辑共用字段定义；独立策略切回全局时保留原值。
const cityWarStrategyKeys = ['targetMode','targetPriority','cityRefs','defenceTargetMode','defenceTargetPriority','defenceCityRefs'];
const cityWarGroup = configGroups.find(group => group.id === 'cityWar');
const cityWarStrategyFields = cityWarGroup.fields.filter(field => cityWarStrategyKeys.includes(field.key.split('.')[1]));
cityWarGroup.fields = [
  ...cityWarGroup.fields.filter(field => !cityWarStrategyFields.includes(field)),
  ...cityWarStrategyFields.map(field => ({ ...field, parent: undefined, section: '全局策略', startCollapsed: true })),
];

function configGet(key) {
  const parts = key.split('.');
  if (parts[0] === 'cityWar' && parts[1] === 'fleetStrategies' && parts.length === 4) {
    const strategy = configEditor.draft.cityWar.fleetStrategies?.[parts[2]];
    if (parts[3] === 'strategyMode') return strategy?.strategyMode ?? (strategy ? 'custom' : 'global');
    return strategy?.[parts[3]] ?? configEditor.draft.cityWar[parts[3]];
  }
  return parts.reduce((value, part) => value?.[part], configEditor.draft);
}
function configClearErrors() {
  configEditor.errors = {};
  for (const widget of configEditor.widgets.values()) widget.clearError?.();
}
function configSet(key, value) {
  const draft = structuredClone(configEditor.draft);
  // 组合主控一次保存所有关联字段，关闭模块不更改细项和参数。
  for (const path of configEditor.fields.get(key)?.controlFields ?? [key]) {
    const parts = path.split('.'), field = parts.pop();
    if (parts[0] === 'cityWar' && parts[1] === 'fleetStrategies') {
      draft.cityWar.fleetStrategies ??= {};
      draft.cityWar.fleetStrategies[parts[2]] ??= Object.fromEntries(cityWarStrategyKeys.map(name => [name, structuredClone(draft.cityWar[name])]));
    }
    const target = parts.reduce((object, part) => object[part], draft);
    target[field] = value;
  }
  configEditor.previewSummary=null;
  if (key === 'cityWar.fleetIds') {
    draft.cityWar.defenceFleetIds = (draft.cityWar.defenceFleetIds ?? []).filter(id => value.includes(id));
  }
  if (key === 'heroes.heroIds' && value.length) draft.heroes.needsSelection = false;
  if (key === 'farm.autoPlant' && value) draft.farm.customPlant = false;
  if (key === 'farm.customPlant' && value) draft.farm.autoPlant = false;
  configEditor.draft = draft;
  // 编辑后允许重新校验，但保留上次提示直到新结果返回，避免无关输入使错误区反复显隐。
  // 改回已保存值不会再次提交，应立即清理；版本冲突仍保留。
  if (!configEditor.saveError?.fields?.revision) {
    configEditor.saveError = null;
    if (!configIsDirty()) configClearErrors();
    if (!Object.keys(configEditor.errors).length) configMessage('');
  }
  configRenderUsage();
  if ($('config-preview-result').childNodes.length) clear($('config-preview-result')).append(el('p', 'config-help', '草稿已更改，请重新预览计划。'));
  configUpdateVisibility();
  configEditor.saveRetries = 0;
  configScheduleSave();
}
function configPageStale() { return typeof window !== 'undefined' && window.cwConsoleVersion?.isStale() === true; }
function configHasDraft() { return !!configEditor.draft; }
function configVersionStale() {
  configCancelSaveTimer();
  configEditor.saveError = { code: 'CLIENT_VERSION_MISMATCH', fields: { revision: '页面已过期，请先保留草稿再刷新。' } };
  configMessage(''); configBusy(configEditor.busy); configUpdateState();
}
function configDownloadDraft() {
  if (!configEditor.draft) return;
  const document = { ...consoleDraftFormat, settings: structuredClone(configEditor.draft) };
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = window.document.createElement('a');
  link.href = url; link.download = '疯狂水世界-未保存草稿.json'; window.document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  configMessage('已下载当前游戏配置草稿，未发送到服务器；其中未通过校验的值需在新页面修正。');
}
function configIsDirty() { return !!configEditor.draft && JSON.stringify(configEditor.draft) !== JSON.stringify(configEditor.baseline); }
function configCancelSaveTimer() {
  if (configEditor.saveTimer !== null) clearTimeout(configEditor.saveTimer);
  configEditor.saveTimer = null;
}
function configScheduleSave(delay = 600) {
  configCancelSaveTimer();
  if (configIsDirty() && configEditor.owner === current && !configPageStale() && !configEditor.recoveryBlocked && !configEditor.saveError?.fields) {
    const account = current;
    configEditor.saveTimer = setTimeout(() => {
      configEditor.saveTimer = null;
      if (account === current && configEditor.owner === account) void configSave(null, { automatic: true });
    }, delay);
  }
  configUpdateState();
}
async function configFlush() {
  const account = current;
  configCancelSaveTimer();
  if (configPageStale() || configEditor.recoveryBlocked) { configMessage(''); return false; }
  while (account === current) {
    const intervalSave = loopIntervalSaves.get(account);
    if (intervalSave?.writing) {
      if (!await intervalSave.promise) return false;
    } else if (configEditor.savePromise) {
      if (!await configEditor.savePromise) return false;
    } else if (!configIsDirty()) return true;
    else if (configEditor.owner !== account || configEditor.busy || configEditor.loading) {
      configMessage('配置正在处理，请稍后再试。'); return false;
    } else if (!await configSave(null, { automatic: true })) return false;
    configCancelSaveTimer();
  }
  return false;
}
function configIntervalSaved(account, everySeconds, revision, nextRevision) {
  if (configEditor.owner !== account || configEditor.data?.revision !== revision) return;
  mutateConsoleValue('configuration', 'data', value => { value.settings.loop.everySeconds = everySeconds; value.revision = nextRevision; });
  mutateConsoleValue('configuration', 'baseline', value => { value.loop.everySeconds = everySeconds; });
  mutateConsoleValue('configuration', 'draft', value => { value.loop.everySeconds = everySeconds; });
}
function configVisible() { return !$('tab-settings').classList.contains('hidden'); }
function configRecoveryMessage(recovery, compact = false) {
  if (compact) return recovery?.reason === 'unavailable' ? '配置暂不可用，自动挂机已停止，原文件未覆盖；请到挂机配置查看原因并修复。'
    : '配置' + (recovery?.reason === 'missing' ? '丢失' : recovery?.reason === 'corrupt' ? '损坏' : '异常') + '，自动挂机已停止；请在挂机配置重新配置保存后手动启动。';
  if (recovery?.reason === 'unavailable') return recovery.message || '配置暂不可用，自动挂机已停止，原文件未覆盖。请修复配置或使用兼容版本后重新载入。';
  let text = '配置' + (recovery?.reason === 'missing' ? '丢失' : recovery?.reason === 'corrupt' ? '损坏' : '丢失或损坏') + '，已恢复关闭的默认配置，自动挂机已停止。请重新配置并保存后手动启动。';
  if (recovery?.backupFile) text += ' 原文件备份：' + recovery.backupFile + '。';
  return text;
}
function configMessage(text, kind = 'info') {
  const node = $('config-message'), recovery = configEditor.recoveryNotice ?? configEditor.data?.recovery;
  const recovering = recovery?.required || configEditor.recoveryBlocked;
  let warning = '';
  if (recovering) {
    warning = configRecoveryMessage(recovery);
    if (configEditor.recoveryBlocked) warning += recovery?.reason === 'unavailable' ? ' 当前页面配置未生效，自动保存已暂停；请修复后重新载入配置。'
      : ' 当前保留的是未生效的旧草稿，自动保存已暂停；请重新载入默认配置后再编辑。';
  }
  configEditor.recoveryReloadButton = null;
  node.textContent = [configPageStale() ? '当前页面已过期，旧草稿未保存且已保留。请先下载或复制未保存的修改，再刷新页面。' : '', warning, text].filter(Boolean).join('\n'); node.hidden = !node.textContent; node.dataset.kind = recovering || configPageStale() ? 'error' : kind;
  if (configEditor.recoveryBlocked) {
    const reload = el('button', 'config-small-button', recovery?.reason === 'unavailable' ? '重新载入配置' : '重新载入默认配置'); reload.type = 'button';
    reload.disabled = configPageStale() || configEditor.busy || configEditor.loading; reload.onclick = () => { void configReload(); }; node.append(reload);
    configEditor.recoveryReloadButton = reload;
  }
}
function configCompatibilityMessage(data) {
  if ((!configEditor.saveError && !Object.keys(configEditor.errors).length) || data.recovery?.required || configEditor.recoveryBlocked) configMessage(configEditor.saveError?.message || data.compatibility?.error || '', data.compatibility ? 'error' : 'info');
}
function configBusy(value) {
  configEditor.busy = value;
  for (const id of ['config-retry', 'config-import', 'config-export', 'config-preview']) $(id).disabled = value || configEditor.loading || !configEditor.draft;
  if (configEditor.recoveryBlocked) $('config-import').disabled = true;
  if (configPageStale()) {
    for (const id of ['config-retry', 'config-import', 'config-preview']) $(id).disabled = true;
    $('config-export').disabled = !configEditor.draft;
  }
  if (configEditor.recoveryReloadButton) configEditor.recoveryReloadButton.disabled = configPageStale() || value || configEditor.loading;
  if (!value && !configEditor.savePromise && !configEditor.saveError && configIsDirty()) configScheduleSave();
}
function configUpdateState() {
  const dirty = configIsDirty();
  const node = $('config-state'); node.dataset.dirty = String(dirty);
  node.setAttribute('aria-busy', String(configEditor.saving));
  node.textContent = configEditor.loading ? '正在载入…' : configEditor.saving ? '正在自动保存…' : configEditor.busy ? '正在处理…' : (configEditor.recoveryNotice ?? configEditor.data?.recovery)?.reason === 'unavailable' ? '配置暂不可用 · 请修复后重新载入' : configEditor.recoveryBlocked ? '旧草稿未生效 · 请重新载入默认配置' : dirty ? configEditor.saveError ? configEditor.saveError.fields?.revision ? '配置有冲突，尚未保存' : configEditor.saveError.fields ? '请修正配置，尚未保存' : configEditor.saveTimer !== null ? '保存失败，正在等待重试…' : '自动保存失败，更改仍保留' : '等待自动保存…' : configEditor.data?.recovery?.required ? '已载入关闭的默认配置 · 请重新配置保存' : configEditor.draft ? '自动保存已开启 · 配置已同步' : '尚未载入';
  if (configPageStale()) node.textContent = '页面已过期 · 旧草稿已保留，请先下载再刷新';
  node.title = node.textContent;
  $('config-retry').hidden = configEditor.recoveryBlocked || !dirty || !configEditor.saveError || !!configEditor.saveError.fields || configEditor.saveTimer !== null;
}
function configRevealTab(tab) {
  const bar = tab.parentElement, item = tab.getBoundingClientRect(), bounds = bar.getBoundingClientRect();
  if (!bounds.width || !item.width) return;
  if (item.left < bounds.left + 4) bar.scrollLeft -= bounds.left + 4 - item.left;
  else if (item.right > bounds.right - 4) bar.scrollLeft += item.right - bounds.right + 4;
}
function configActivate(category, focus = false, writeHash = true) {
  if (!Object.hasOwn(configCategories, category)) return;
  closeHelpTip(false);
  const changed = category !== configEditor.category;
  if (changed) clear($('config-preview-result'));
  configEditor.category = category;
  for (const node of document.querySelectorAll('[data-config-tab]')) {
    const selected = node.dataset.configTab === category;
    node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1;
    if (selected) { if (focus) node.focus({ preventScroll: true }); configRevealTab(node); }
  }
  for (const node of document.querySelectorAll('[data-config-panel]')) node.hidden = node.dataset.configPanel !== category;
  const choices = [...configEditor.groups.values()].filter(group => group.category === category);
  const selected = choices.find(group => group.id === configEditor.selectedGroups[category]) || choices[0];
  if (selected) configActivateGroup(selected.id, false, writeHash, changed);
}
function configActivateGroup(id, focus = false, writeHash = true, forcePreview = false) {
  const group = configEditor.groups.get(id);
  if (!group || group.category !== configEditor.category) return;
  closeHelpTip(false);
  const changed = configEditor.selectedGroups[group.category] !== id;
  configEditor.selectedGroups = { ...configEditor.selectedGroups, [group.category]: id };
  const panel = $('config-panel-' + group.category);
  const family = baseFamilies.find(item => item.groups.includes(id));
  if (family) {
    familyGroups.set(family.id, id);
    $('config-base-sections').setAttribute('aria-labelledby', 'config-family-' + family.id);
    panel.querySelector('.config-subtabs').hidden = family.groups.length === 1;
    for (const tab of panel.querySelectorAll('[data-config-family]')) {
      const selected = tab.dataset.configFamily === family.id;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      if (selected && focus && family.groups.length === 1) tab.focus({ preventScroll: true });
    }
  }
  for (const tab of panel.querySelectorAll('[data-config-group]')) {
    tab.hidden = !!family && !family.groups.includes(tab.dataset.configGroup);
    const selected = tab.dataset.configGroup === id;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    if (selected) { if (focus) tab.focus({ preventScroll: true }); configRevealTab(tab); }
  }
  for (const section of panel.querySelectorAll('.config-section')) section.hidden = section.id !== 'config-group-' + id;
  if (changed || forcePreview) {
    clear($('config-preview-result'));
    $('config-preview-scope').value = 'module:'+id;
  }
  configRenderUsage();
  configWeeklyRankingSync();
  if (writeHash && configVisible()) history.replaceState(history.state, '', '#config-group-' + id);
}
function configWeeklyRankingReset() {
  configWeeklyRanking.serial++;
  Object.assign(configWeeklyRanking, { owner: current, data: null, error: '', pending: null, at: 0 });
  const root = $('config-weekly-ranking');
  if (!root) return;
  root.hidden = true;
  for (const id of ['config-weekly-ranking-summary','config-weekly-ranking-updated','config-weekly-ranking-table']) {
    const node = $(id); if (node) { clear(node); node.hidden = true; }
  }
}
function configWeeklyRankingVisible() {
  return configEditor.owner === current && configEditor.category === 'daily'
    && configEditor.selectedGroups.daily === 'weekly-activities' && configVisible();
}
function configWeeklyRankingSync() {
  const root = $('config-weekly-ranking');
  if (!root) return;
  if (configWeeklyRanking.owner !== current) configWeeklyRankingReset();
  root.hidden = !configWeeklyRankingVisible();
  if (!root.hidden) { configWeeklyRankingRender(); void configWeeklyRankingLoad(); }
}
function configWeeklyRankingNumber(value) {
  const text = typeof value === 'string' && /^\d+$/.test(value) ? value
    : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return text === null ? '未返回' : text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function configWeeklyRankingTime(value) {
  return Number.isFinite(value) && value > 0 && value < 8640000000000
    ? new Date(value * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未返回';
}
function configWeeklyRankingRender() {
  const root = $('config-weekly-ranking');
  if (!root || configWeeklyRanking.owner !== current) return;
  const { data, pending, error } = configWeeklyRanking;
  root.setAttribute('aria-busy', String(!!pending));
  $('config-weekly-ranking-refresh').disabled = !!pending;
  $('config-weekly-ranking-refresh').textContent = pending ? '读取中…' : '刷新榜单';
  const status = $('config-weekly-ranking-status');
  status.textContent = error ? '榜单读取失败：' + error + (data ? '。以下为上次成功读取的榜单。' : '')
    : pending ? '正在读取军备竞赛排行…' : data?.reason || (data ? '仅展示服务器返回的名次，不在返回范围内的排名不会推算。' : '尚未读取榜单。');
  const summary = clear($('config-weekly-ranking-summary')), updated = $('config-weekly-ranking-updated');
  const host = clear($('config-weekly-ranking-table'));
  summary.hidden = updated.hidden = !data; host.hidden = !data?.rows?.length;
  if (!data) { updated.textContent = ''; return; }
  const mine = data.mine;
  const ownRank = Number.isSafeInteger(mine?.rank) && mine.rank > 0 ? '第 ' + mine.rank + ' 名' : '未返回';
  for (const [label, value] of [
    ['当前主题', data.subjectName || '等待服务器主题'], ['本人名次', ownRank],
    ['本人积分', mine?.scoreText ?? configWeeklyRankingNumber(mine?.score)],
    ['结算时间（北京时间）', configWeeklyRankingTime(data.settleTime ?? data.endTime)],
  ]) {
    const item = el('div'); item.append(el('span','',label),el('strong','',value)); summary.append(item);
  }
  updated.textContent = '更新时间（北京时间）：' + configWeeklyRankingTime(data.checkedAt)
    + (data.roomLevel ? ' · 分组等级 ' + data.roomLevel : '') + (error ? ' · 上次榜单，刷新失败' : '');
  if (!data.rows?.length) return;
  const board = el('table'), caption = el('caption','sr-only','军备竞赛服务器返回的玩家排行');
  const head = el('thead'), titles = el('tr'), body = el('tbody');
  for (const [index, label] of ['名次','玩家','积分','等级'].entries()) {
    const cell = el('th',index >= 2 ? 'config-ranking-number' : '',label); cell.scope = 'col'; titles.append(cell);
  }
  head.append(titles);
  for (const row of data.rows) {
    const line = el('tr',row.own ? 'is-own' : '');
    const values = [Number.isSafeInteger(row.rank) && row.rank > 0 ? String(row.rank) : '未返回',
      (row.name || '未返回名称') + (row.own ? '（我）' : ''), row.scoreText ?? configWeeklyRankingNumber(row.score), configWeeklyRankingNumber(row.level)];
    values.forEach((value,index) => line.append(el('td',index >= 2 ? 'config-ranking-number' : '',value)));
    body.append(line);
  }
  board.append(caption,head,body); host.append(board);
}
async function configWeeklyRankingLoad(force = false) {
  if (typeof call !== 'function' || !configWeeklyRankingVisible()) return;
  if (configWeeklyRanking.owner !== current) configWeeklyRankingReset();
  const previous = configWeeklyRanking.data, elapsed = (Date.now() - configWeeklyRanking.at) / 1000;
  const settled = previous?.status === 'active' && Number.isFinite(previous.checkedAt)
    && Number.isFinite(previous.settleTime ?? previous.endTime) && previous.checkedAt + elapsed >= (previous.settleTime ?? previous.endTime);
  if (configWeeklyRanking.pending || !force && !settled && configWeeklyRanking.at && Date.now() - configWeeklyRanking.at < 30000) return;
  const account = current, serial = ++configWeeklyRanking.serial;
  const active = () => current === account && configWeeklyRanking.owner === account && configWeeklyRanking.serial === serial;
  const job = { account, serial }; configWeeklyRanking.pending = job; configWeeklyRanking.error = ''; configWeeklyRankingRender();
  try {
    const data = await call('/api/activity-ranks/view?key=week-cross&account=' + encodeURIComponent(account));
    if (!active()) return;
    if (!data || !Array.isArray(data.rows)) throw new Error('服务器未完整返回榜单，请刷新重试');
    configWeeklyRanking.data = data;
  } catch (error) { if (active()) configWeeklyRanking.error = error.message || '暂时无法读取，请稍后刷新'; }
  finally {
    if (active()) { configWeeklyRanking.pending = null; configWeeklyRanking.at = Date.now(); configWeeklyRankingRender(); }
  }
}
function configApplyHash() {
  let id;
  try { id = decodeURIComponent(location.hash.replace(/^#config-group-/, '')); } catch { return; }
  id = configLegacyGroups.get(id) || id;
  if (!location.hash.startsWith('#config-group-') || !configEditor.groups.has(id)) return;
  const group = configEditor.groups.get(id);
  configActivate(group.category, false, false); configActivateGroup(id, false, false);
}
function configUpdateVisibility() {
  if (!configEditor.draft) return;
  const update = (widget, parentActive = true) => {
    const { spec, children = [] } = widget;
    const key = spec.key;
    const visible = parentActive && (!spec.when || spec.when(configEditor.draft));
    const active = visible && (spec.moduleControl || spec.kind !== 'switch' || configSwitchValue(spec));
    let hasError = !!configEditor.errors[key] || !widget.error.hidden;
    for (const child of children) {
      const childHasError = update(child, active);
      hasError = hasError || childHasError;
    }
    if(hasError)configRevealSection(widget);
    widget.row.hidden = !visible && !hasError;
    widget.node.hidden = widget.row.hidden;
    if (widget.spec.kind === 'switch') configPaintSwitch(widget.control, configSwitchValue(spec));
    if (widget.moduleNote) {
      const enabled = configSwitchValue(spec);
      const blocked = (spec.gates ?? []).filter(path => !configGet(path));
      const labels = blocked.map(path => configEditor.fields.get(path)?.label || path);
      widget.moduleNote.textContent = enabled && spec.configuredFields?.length && !spec.configuredFields.some(path => configGet(path))
        ? '尚未选择执行动作，请在下方设置。' : enabled && labels.length ? '需先开启：' + labels.join('、') : '';
      widget.moduleNote.hidden = !widget.moduleNote.textContent;
    }
    if (['lineup', 'trialLineups', 'fleetLineups'].includes(widget.spec.kind)) widget.control?.refresh?.();
    if (widget.childPanel) {
      if (hasError) configCollapsed.delete(key);
      const available = children.some(child => !child.node.hidden);
      const expanded = available && (spec.collapsible === false || !configCollapsed.has(key));
      const focusedChild = children.find(child => child.node.contains(document.activeElement));
      if (focusedChild && (!expanded || focusedChild.node.hidden)) widget.control.focus({ preventScroll: true });
      widget.childPanel.hidden = !expanded;
      if (widget.disclosure) {
        widget.disclosure.hidden = !available;
        widget.disclosure.textContent = expanded ? '收起设置' : '展开设置';
        widget.disclosure.setAttribute('aria-expanded', String(expanded));
        widget.disclosure.setAttribute('aria-label', spec.label + (expanded ? '，收起下级设置' : '，展开下级设置'));
      }
      widget.node.dataset.expanded = String(expanded);
    }
    return hasError;
  };
  for (const widget of configEditor.widgets.values()) {
    if (!widget.parentKey) update(widget);
  }
  // 逐队控件内部的字段独立更新；待其显隐就绪后再恢复舰队入口和焦点。
  for (const widget of configEditor.widgets.values()) {
    if (widget.spec.kind === 'cityWarRoles') widget.control?.refresh?.();
  }
}
function configSwitchValue(spec) {
  return (spec.controlFields ?? [spec.key]).every(key => configGet(key) === true);
}
function configPaintSwitch(button, checked) {
  button.setAttribute('aria-checked', String(checked)); button.dataset.state = checked ? 'checked' : 'unchecked';
  for (const thumb of button.querySelectorAll('[data-state]')) thumb.dataset.state = button.dataset.state;
}
function configButton(text, onClick, extra = '') {
  const button = el('button', 'config-small-button ' + extra, text); button.type = 'button'; button.onclick = onClick; return button;
}

function configRenderFields(fields, host) {
  // 逐队加速随职责编辑器一起渲染，保留原配置键和每种加速的参数层级。
  if (fields.some(field => field.kind === 'cityWarRoles')) {
    const speedFields = fields.filter(field => field.fleetGroup === 'fleetSpeed');
    fields = fields.filter(field => field.fleetGroup !== 'fleetSpeed').map(field =>
      field.kind === 'cityWarRoles' ? { ...field, speedFields } : field);
  }
  const keys = new Set(fields.map(field => field.key));
  const children = new Map();
  for (const field of fields) {
    configEditor.fields.set(field.key, field);
    // 模块启停始终置顶，暂停时仍可调整下面的执行细项。
    const parent = keys.has(field.parent) ? field.parent : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(field);
  }
  const render = (spec, parentKey = null) => {
    const row = configRenderField(spec);
    const widget = configEditor.widgets.get(spec.key);
    widget.parentKey = parentKey;
    widget.node = row;
    widget.children = [];
    const childFields = children.get(spec.key) ?? [];
    if (!childFields.length) return widget;
    if(spec.collapsible !== false && !configDisclosureSeen.has(spec.key)){configDisclosureSeen.add(spec.key);configCollapsed.add(spec.key);}
    const branch = el('div', 'config-branch'); branch.dataset.configBranch = spec.key;
    const panel = el('div', 'config-children'); panel.id = widget.control.id + '-children';
    panel.revealConfig = () => { configCollapsed.delete(spec.key); };
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-labelledby', widget.control.id + '-label');
    let disclosure = null;
    if (spec.collapsible !== false) {
      disclosure = el('button', 'config-disclosure'); disclosure.type = 'button';
      disclosure.setAttribute('aria-controls', panel.id);
      disclosure.onclick = () => {
        if (configCollapsed.has(spec.key)) configCollapsed.delete(spec.key);
        else configCollapsed.add(spec.key);
        configUpdateVisibility();
      };
      row.querySelector('.config-control').prepend(disclosure);
    }
    row.classList.add('has-children');
    widget.control.setAttribute('aria-controls', panel.id);
    widget.node = branch; widget.childPanel = panel; widget.disclosure = disclosure;
    for (const field of childFields) {
      const child = render(field, spec.key);
      widget.children.push(child); panel.append(child.node);
    }
    branch.append(row, panel);
    return widget;
  };
  let section = null, sectionHost=host;
  for (const field of children.get(null) ?? []) {
    if (field.section && field.section!==section) {
      section=field.section;
      const collapsible=field.sectionCollapsible!==false;
      const container=el(collapsible?'details':'section','config-field-section'),heading=el(collapsible?'summary':'h3','config-subheading',section);
      container.id='config-section-'+field.key.replaceAll('.','-');
      if (collapsible) {
        if (field.startCollapsed && !configDisclosureSeen.has(container.id)) {
          configDisclosureSeen.add(container.id); configCollapsedSections.add(container.id);
        }
        container.open=!configCollapsedSections.has(container.id);
        container.ontoggle=()=>{if(container.open)configCollapsedSections.delete(container.id);else configCollapsedSections.add(container.id);};
      } else {
        heading.id=container.id+'-heading';container.setAttribute('aria-labelledby',heading.id);
      }
      container.append(heading);host.append(container);sectionHost=container;
    }else if(!field.section){section=null;sectionHost=host;}
    sectionHost.append(render(field).node);
  }
}

function configRevealSection(widget) {
  for(let node=widget?.node?.parentElement;node;node=node.parentElement){
    node.revealConfig?.();
    if(node.tagName==='DETAILS'&&node.classList?.contains('config-field-section')){
      node.open=true;configCollapsedSections.delete(node.id);
    }
  }
}

function configRender() {
  closeHelpTip(false);
  clear($('config-preview-result'));
  configEditor.fields.clear(); configEditor.widgets.clear(); configEditor.groups.clear(); configEditor.playerWidgets = [];
  const root = clear($('config-fields'));
  const groups = configGroups.map(group => ({ ...group, fields: [...group.fields] }));
  const fleetIds = configEditor.data.catalog?.expeditionFleets?.map(row=>row.value);
  if (fleetIds) for (const group of groups) group.fields = group.fields.filter(field => field.fleetIndex===undefined ||
    fleetIds.includes(configEditor.draft[field.fleetGroup].fleets[field.fleetIndex].id)).map(field => field.fleetIndex===undefined ? field : {
      ...field,label:field.label.replace(/^舰队\d+/, '舰队'+configEditor.draft[field.fleetGroup].fleets[field.fleetIndex].id.replace('远征船','')) });
  const hiddenFields = new Set(configEditor.data.rules?.hiddenFields ?? []);
  for (const group of groups) group.fields = group.fields.filter(field => !hiddenFields.has(field.key) && !activityOwnedSettings.has(field.key));
  const mapped = new Set(configEditor.data.rules?.mappedTasks ?? []);
  const staticFields=new Set(groups.flatMap(g=>g.fields.map(f=>f.key)));
  const tasks = (configEditor.data.tasks ?? []).filter(task => !mapped.has(task.key)&&!hiddenFields.has('schedule.'+task.key)&&!activityOwnedSettings.has('schedule.'+task.key)&&!staticFields.has('schedule.'+task.key)).map(task => ['freeRecruit', 'ticketRecruit'].includes(task.key) ? { ...task, group: '招募' } : task);
  const destinations = { '联盟': ['cityWar', '联盟城战'], '海面': ['building', '建筑'], '领奖': ['rewards', '任务与领奖'],
    '周期活动': ['daily-weekly', '周期活动'], '限时活动': ['river-series', '限时 · 联动系列'], '藏品': ['antique-recruit', '藏品招募'],
    '招募': ['hero-recruit', '英雄招募'], '日常': ['daily-actions', '日常行动'], '挑战': ['daily-challenges', '挑战与扫荡'] };
  configLegacyGroups.clear();
  configLegacyGroups.set('daily-collections', 'hero-recruit');
  configLegacyGroups.set('equipment-legacy', 'forge');
  configLegacyGroups.set('military-week', 'weekly-activities');
  configLegacyGroups.set('daily-events', 'rewards');
  configLegacyGroups.set('side-rewards', 'rewards');
  configLegacyGroups.set('pirate-sweep', 'pirate-hunt');
  [...new Set(tasks.map(task => task.group))].forEach((name, index) => {
    const [id, title] = destinations[name] || ['daily-other', '其他项目'];
    // 旧版从 33 开始为动态分组生成书签。新增静态分组时仍需解析旧编号。
    configLegacyGroups.set('schedule-' + (33 + index), id);
    let group = groups.find(item => item.id === id);
    if (!group) { group = { id, title, category: 'daily', fields: [] }; groups.push(group); }
    for (const task of tasks.filter(task => task.group === name)) if (!group.fields.some(field => field.key === 'schedule.' + task.key)) group.fields.push(configField('schedule.' + task.key, task.label, 'switch', task.key === 'heroRecruitRewards' ? { help: '只领取本赛季已达标的英雄累计招募奖励，不消耗招募券或钻石。与藏品领奖分别控制，不受日常行动开关控制，暂停托管时停止。' } : {}));
  });
  groups.find(g => g.id === 'rewards').title = '任务与领奖';
  const trialGroup = groups.find(g => g.id === 'progression');
  if (trialGroup) trialGroup.fields.push(
    configField('trials.ads', '试炼免广告扫荡', 'switch', { help:'渠道开放且该副本广告次数有剩余时执行，无免广告权益时按“广告奖励”中的等待时间领取。当前配置每副本每天1次，不花钻石。先完成普通首轮免费扫荡。' }),
    configField('trials.paid', '试炼钻石扫荡', 'switch', { help:'普通首轮免费之后才执行付费扫荡；还需开启“基础→加速与钻石”中的钻石总开关，并遵守保留量与全局每日预算。新开关默认关闭。' }),
    configField('trials.raidIds', '自动额外扫荡副本', 'multi', { catalog:'trialRaids', empty:'未选择，不安排自动额外扫荡', help:'选择自动免广告与钻石扫荡的副本。原有首轮免费扫荡和挑战页的单次扫荡入口保持独立；单次操作仍遵守各项费用与预算限制。' }),
    configField('trials.paidPerRaidLimit', '每副本每日钻石扫荡上限', 'number', { parent:'trials.paid', unit:'次', help:'仅统计本工具的付费扫荡；同时遵守游戏基础、VIP和有效月卡次数限制。0禁止钻石扫荡。' }),
    configField('trials.maxSingleCost', '单次钻石费用上限', 'number', { parent:'trials.paid', unit:'钻石', help:'当前普通付费档为50钻，实际费用以游戏最新配置为准，超过此值不执行。' }),
    configField('trials.dailyDiamondBudget', '试炼每日钻石预算', 'number', { parent:'trials.paid', unit:'钻石', help:'三个副本共用，也计入全局每日钻石用量。结果未知仍保留额度，跨日未知请求先核对，不重复发送。' }),
  );
  for (let index = groups.length - 1; index >= 0; index--) if (!groups[index].fields.length) groups.splice(index, 1);
  const adIndex = groups.findIndex(group => group.id === 'ad-rewards');
  if (adIndex >= 0 && groups.some(group => group.id === 'daily-actions')) {
    const [ads] = groups.splice(adIndex, 1);
    groups.splice(groups.findIndex(group => group.id === 'daily-actions') + 1, 0, ads);
  }
  const firstDaily = groups.findIndex(group => group.category === 'daily');
  for (const id of ['daily-weekly', 'rewards']) {
    const index = groups.findIndex(group => group.id === id);
    if (index >= 0) {
      const [group] = groups.splice(index, 1);
      groups.splice(firstDaily, 0, group);
    }
  }
  const movedFields = new Set(configEditor.data.rules?.controlFields ?? []);
  movedFields.add('loop.everySeconds');
  for (const group of groups) {
    const controls = (configEditor.data.rules?.moduleControls ?? []).filter(control => control.configTarget === group.id && !hiddenFields.has(control.key));
    const switches = controls.map(control => configField(control.key, control.configLabel ?? (controls.length === 1 ? '自动挂机' : control.label), 'switch', {
      help: control.help || group.fields.find(field => field.key === control.key)?.help,
      moduleControl: true, controlFields: control.fields, gates: control.gates, configuredFields: control.configuredFields,
    }));
    group.controlKeys=[...new Set([...group.fields.map(field=>field.key), ...controls.flatMap(control=>control.fields)])];
    group.fields = [...switches, ...group.fields.filter(field=>!movedFields.has(field.key)).map(field =>
      movedFields.has(field.parent) ? { ...field, parent: undefined } : field)];
    configEditor.groups.set(group.id, group);
  }
  const scopeSelect=$('config-preview-scope');
  for(const opt of [...scopeSelect.options])if(!['base','daily','activity'].includes(opt.value))opt.remove();
  for(const group of groups)scopeSelect.add(new Option(group.title,'module:'+group.id));
  for (const [category, label] of Object.entries(configCategories)) {
    const panel = el('div'); panel.id = 'config-panel-' + category; panel.dataset.configPanel = category; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'config-tab-' + category);
    const selected = groups.filter(group => group.category === category);
    const singleGroup = category !== 'base' && selected.length === 1;
    let groupHost = panel;
    if (category === 'base') {
      const families = el('div', 'config-families'); families.setAttribute('role', 'tablist'); families.setAttribute('aria-label', '基地分类');
      baseFamilies.forEach((family, index) => {
        const tab = el('button', '', family.title); tab.type = 'button'; tab.id = 'config-family-' + family.id; tab.dataset.configFamily = family.id; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', 'false'); tab.setAttribute('aria-controls', 'config-base-sections');
        const activate = () => configActivateGroup(familyGroups.get(family.id) || family.groups[0]); tab.onclick = activate;
        tab.onkeydown = event => { const i = event.key === 'ArrowRight' ? (index + 1) % 4 : event.key === 'ArrowLeft' ? (index + 3) % 4 : event.key === 'Home' ? 0 : event.key === 'End' ? 3 : null;
          if (i != null) { event.preventDefault(); const next = baseFamilies[i]; configActivateGroup(familyGroups.get(next.id) || next.groups[0]); families.children[i].focus(); } };
        families.append(tab);
      }); panel.append(families); groupHost = el('div'); groupHost.id = 'config-base-sections'; groupHost.setAttribute('role', 'tabpanel'); panel.append(groupHost);
    }
    const tabs = el('div', 'config-subtabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', label + '分组');
    for (const group of selected) {
      const family = baseFamilies.find(item => item.groups.includes(group.id));
      if (singleGroup || family?.groups.length === 1) continue;
      const tab = el('button', '', group.title); tab.type = 'button'; tab.id = 'config-subtab-' + group.id; tab.dataset.configGroup = group.id;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'config-group-' + group.id); tab.setAttribute('aria-selected', 'false'); tab.tabIndex = -1;
      tab.onclick = () => configActivateGroup(group.id);
      tab.onkeydown = event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const family = baseFamilies.find(item => item.groups.includes(configEditor.selectedGroups[category]));
        const choices = category === 'base' && family ? selected.filter(item => family.groups.includes(item.id)) : selected;
        const at = choices.findIndex(item => item.id === configEditor.selectedGroups[category]);
        const next = event.key === 'ArrowRight' ? (at + 1) % choices.length : event.key === 'ArrowLeft' ? (at + choices.length - 1) % choices.length : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : null;
        if (next !== null) { event.preventDefault(); event.stopPropagation(); configActivateGroup(choices[next].id, true); }
      };
      tabs.append(tab);
    }
    if (!singleGroup) groupHost.append(tabs);
    for (const group of selected) {
      const family = baseFamilies.find(item => item.groups.includes(group.id));
      const direct = singleGroup || family?.groups.length === 1;
      const section = el('section', 'config-section'); section.id = 'config-group-' + group.id;
      section.setAttribute('role', direct ? 'group' : 'tabpanel');
      section.setAttribute('aria-labelledby', singleGroup ? 'config-tab-' + category : direct ? 'config-family-' + family.id : 'config-subtab-' + group.id);
      if (group.description) section.append(el('p','config-section-intro',group.description));
      if (['cityWar','silicon','treasure','resourceFields'].includes(group.id) && !configEditor.data.catalog?.fleetAvailability?.known) {
        section.append(el('p','config-section-intro','舰队名单尚未同步。连接游戏后重新打开挂机配置即可查看舰队名单。'));
      }
      const fields = group.fields.map(spec => ({ ...spec, category, groupId: group.id }));
      configRenderFields(fields, section);
      groupHost.append(section);
    }
    root.append(panel);
  }
  configActivate(configEditor.category, false, false);
  scopeSelect.value='module:'+configEditor.selectedGroups[configEditor.category];
  configApplyHash(); configUpdateVisibility(); configUpdateState(); configRenderUsage();
  if (!configEditor.playerData && configGet('treasure.followPlayerIds').length) void configRefreshPlayers();
}

function configRenderField(spec) {
  if(spec.kind==='number'){
    const rule=configEditor.data.rules?.numbers?.[spec.key];
    const meaning=rule?.min>0?'0不可用，最小值为'+rule.min+'。':configZeroHints[spec.key];
    if(meaning&&!/0\s*(?:表示|禁止|时|关闭|不设)/.test(spec.help??''))spec={...spec,help:[spec.help,meaning].filter(Boolean).join(' ')};
  }

  const row = el('div', 'config-row' + (spec.wide ? ' is-wide' : '')); row.dataset.kind = spec.kind;
  if (spec.moduleControl) row.classList.add('config-module-control');
  const id = 'config-field-' + spec.key.replaceAll('.', '-');
  const name = el('div', 'config-label-line'); const label = el('label', 'config-label', spec.label); label.htmlFor = id; name.append(label);
  name.hidden = spec.kind === 'cityWarRoles';
  label.id = id + '-label';
  if (spec.help) { const help = el('span', '', spec.help); help.id = id + '-help'; help.hidden = true; name.append(makeHelpTip(spec.label, spec.help), help); }
  const box = el('div', 'config-control'); const error = el('div', 'config-field-error'); error.id = id + '-error'; error.hidden = true;
  let control;
  if (spec.kind === 'switch') {
    control = $('config-switch-template').content.firstElementChild.cloneNode(true); control.id = id; control.type = 'button';
    control.setAttribute('aria-label', spec.label); configPaintSwitch(control, configSwitchValue(spec));
    control.onclick = () => { configSet(spec.key, !configSwitchValue(spec)); };
    box.append(control);
  } else if (spec.kind === 'number') {
    const line = el('div', 'config-number'); control = el('input'); control.type = 'number'; control.required = true; control.step = '1';
    const rule = configEditor.data.rules?.numbers?.[spec.key] ?? { min: 0, max: 1000000000 };
    control.min = String(rule.min); control.max = String(rule.max); control.id = id; control.value = String(configGet(spec.key)); control.dataset.configNumber = spec.key;
    control.oninput = () => { configSet(spec.key, control.value === '' ? null : Number(control.value)); };
    line.append(control); if (spec.unit) line.append(el('span', '', spec.unit)); box.append(line);

  } else if (spec.kind === 'time') {
    control = el('input'); control.type = 'time'; control.required = true; control.id = id; control.value = configGet(spec.key);
    control.onchange = () => configSet(spec.key, control.value); box.append(control);
  } else if (spec.kind === 'names') {
    control = el('textarea', 'config-input'); control.id = id; control.rows = 2; control.maxLength = 3600;
    control.placeholder = spec.placeholder || '每行一项'; control.value = configGet(spec.key).join('\n'); control.spellcheck = false;
    control.oninput = () => configSet(spec.key, control.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)); box.append(control);
  } else if (spec.kind === 'choice') {
    control = el('select', 'config-select'); control.id = id;
    for (const [value, text] of spec.options) { const option = el('option', '', text); option.value = value; control.append(option); }
    control.value = configGet(spec.key); control.onchange = () => configSet(spec.key, spec.numeric ? Number(control.value) : control.value); box.append(control);
  } else if (['lineup', 'trialLineups', 'fleetLineups'].includes(spec.kind)) {
    control = configLineupPicker(spec, id); box.append(control);
  } else if (spec.kind === 'radio') {
    control = el('div', 'config-radio'); control.id = id; control.setAttribute('role', 'radiogroup'); control.setAttribute('aria-label', spec.label); control.tabIndex = -1;
    for (const [value, text] of spec.options) {
      const option = el('label', 'config-option'); const input = el('input'); input.type = 'radio'; input.name = id; input.value = value; input.checked = configGet(spec.key) === value;
      input.onchange = () => { if (input.checked) configSet(spec.key, value); }; option.append(input, el('span', '', text)); control.append(option);
    }
    box.append(control);
  } else if (spec.kind === 'players') {
    control = configPlayerPicker(spec, id); box.append(control);
  } else if (spec.kind === 'multi') {
    control = configMultiselect(spec, id); box.append(control);
  } else if (spec.kind === 'cityWarRoles') {
    control = configCityWarRoles(spec, id); box.append(control);
  } else if (spec.kind === 'dispatchOrder') {
    control = configDispatchOrder(spec, id); box.append(control);
  } else if (spec.kind === 'priority') {
    control = configPriorityEditor(spec, id); box.append(control);
  } else if (spec.kind === 'crops') {
    control = configCropEditor(spec, id); box.append(control);
  }
  if (control) {
    control.dataset.configKey = spec.key;
    control.setAttribute('aria-describedby', (spec.help ? id + '-help ' : '') + id + '-error');
  }
  box.append(error); row.append(name, box);
  const widget = { row, node: row, control, error, spec, clearError() { error.hidden = true; error.textContent = ''; control?.removeAttribute('aria-invalid'); } };
  if (spec.moduleControl) {
    widget.moduleNote = el('span', 'config-help'); widget.moduleNote.hidden = true;
    widget.moduleNote.id = id + '-note'; widget.moduleNote.setAttribute('role', 'status');
    name.append(widget.moduleNote);
    control.setAttribute('aria-describedby', control.getAttribute('aria-describedby') + ' ' + widget.moduleNote.id);
  }
  configEditor.widgets.set(spec.key, widget);
  return row;
}

function configDispatchOrder(spec, id) {
  const root = el('div', 'config-dispatch-order'); root.id = id;
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', spec.label);
  const hint = el('p', 'config-help', '拖动左侧手柄调整顺序，也可使用上移、下移按钮。');
  const list = el('div'); list.setAttribute('role', 'list');
  const status = el('span', 'sr-only'); status.setAttribute('role', 'status');
  const labels = { cityWar: '城战接续', pirateHunt: '海盗讨伐 / 首杀', treasure: '巨轮普通参战',
    follow: '巨轮跟随', worldBoss: '世界Boss首战', radar: '联盟情报', silicon: '硅矿采集', resourceFields: '资源田占领' };
  const owner = configEditor.owner;
  let drag = null;
  const editable = () => owner === current && configEditor.owner === owner && !configEditor.busy && !configEditor.loading
    && root.isConnected && root.getClientRects().length > 0;
  const clearDrop = () => { for (const row of list.children) delete row.dataset.drop; };
  const cancelDrag = () => {
    const previous = drag; drag = null; clearDrop();
    window.removeEventListener('blur', cancelDrag);
    document.removeEventListener('keydown', escapeDrag);
    if (!previous) return;
    delete previous.row.dataset.dragging;
    if (previous.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
  };
  const escapeDrag = event => { if (event.key === 'Escape' && drag) { event.preventDefault(); cancelDrag(); } };
  const move = (value, to) => {
    if (!editable()) return;
    const values = [...configGet(spec.key)], from = values.indexOf(value);
    if (from < 0 || to < 0 || to >= values.length || from === to) return;
    values.splice(from, 1); values.splice(to, 0, value);
    configSet(spec.key, values); paint(value);
    status.textContent = (labels[value] || value) + '已移至第' + (to + 1) + '位';
  };
  const startDrag = (event, value, row, handle) => {
    if (event.button !== 0 || event.isPrimary === false || handle.disabled || !editable()) return;
    cancelDrag();
    drag = { value, row, handle, pointerId: event.pointerId, startY: event.clientY, moved: false,
      order: JSON.stringify(configGet(spec.key)), to: configGet(spec.key).indexOf(value) };
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    window.addEventListener('blur', cancelDrag); document.addEventListener('keydown', escapeDrag);
    handle.onpointermove = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!editable() || JSON.stringify(configGet(spec.key)) !== drag.order) { cancelDrag(); return; }
      if (!drag.moved && Math.abs(event.clientY - drag.startY) < 5) return;
      drag.moved = true; row.dataset.dragging = 'true';
      const others = [...list.children].filter(item => item !== row);
      const before = others.findIndex(item => { const rect = item.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2; });
      drag.to = before < 0 ? others.length : before;
      clearDrop();
      if (before < 0 && others.length) others.at(-1).dataset.drop = 'after';
      else if (others[before]) others[before].dataset.drop = 'before';
      if (event.clientY < 48) window.scrollBy(0, -16);
      else if (event.clientY > window.innerHeight - 48) window.scrollBy(0, 16);
    };
    handle.onpointerup = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const completed = drag;
      const valid = editable() && JSON.stringify(configGet(spec.key)) === completed.order;
      cancelDrag();
      if (valid && completed.moved) move(value, completed.to);
    };
    handle.onpointercancel = handle.onlostpointercapture = cancelDrag;
  };
  function paint(focusValue) {
    cancelDrag(); clear(list);
    const values = configGet(spec.key);
    values.forEach((value, index) => {
      const row = el('div', 'config-dispatch-row config-dispatch-sortable');
      row.dataset.dispatch = value; row.setAttribute('role', 'listitem');
      const label = labels[value] || value;
      const handle = configButton('⠿', () => {}); handle.classList.add('config-dispatch-handle');
      handle.setAttribute('aria-label', '拖动排序：' + label); handle.title = '拖动排序，或按上下方向键移动';
      handle.onpointerdown = event => startDrag(event, value, row, handle);
      handle.onkeydown = event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;
        if (to !== null) { event.preventDefault(); cancelDrag(); move(value, to); }
      };
      const actions = el('div', 'config-order-tools');
      for (const [offset, text] of [[-1, '上移'], [1, '下移']]) {
        const button = configButton(text, () => { cancelDrag(); move(value, index + offset); });
        button.disabled = index + offset < 0 || index + offset >= values.length;
        button.setAttribute('aria-label', label + text); actions.append(button);
      }
      row.append(handle, el('span', 'config-order-num', String(index + 1)), el('span', 'config-order-name', label), actions);
      list.append(row);
      if (value === focusValue) handle.focus({ preventScroll: true });
    });
  }
  root.append(hint, list, status); paint();
  return root;
}

function configLineupPicker(spec, id) {
  const root = el('div'); root.id = id; root.tabIndex = -1;
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', spec.label);
  const presets = configGet('lineups.presets') ?? [];
  const fleetPicker = spec.kind === 'fleetLineups', bindingField = fleetPicker ? 'buildingId' : 'raidId';
  const entries = spec.kind === 'trialLineups'
    ? (configEditor.data.catalog?.trialRaids ?? []).map(raid => ({ raidId: String(raid.value), label: raid.label }))
    : fleetPicker ? (configEditor.data.catalog?.expeditionFleets ?? []).map(fleet => ({ raidId: String(fleet.value), label: fleet.label }))
    : [{ raidId: null, label: spec.label }];
  const controls = [];
  for (const entry of entries) {
    const line = el('div', 'config-add');
    const select = el('select', 'config-select'); select.id = id + (entry.raidId ? '-' + entry.raidId : '-select');
    select.dataset.lineupBinding = entry.raidId ? (fleetPicker ? 'fleet:' : 'trial:') + entry.raidId : 'mainline';
    select.setAttribute('aria-label', entry.label + (fleetPicker ? '世界Boss出战阵容' : entry.raidId ? '自动挑战阵容' : ''));
    const empty = el('option', '', fleetPicker ? '使用舰队当前阵容' : '使用游戏当前阵容'); empty.value = ''; select.append(empty);
    for (const preset of presets) {
      const option = el('option', '', preset.name); option.value = preset.id; select.append(option);
    }
    const view = configButton('查看', () => {
      if (select.value) void openSavedLineupViewer(current, select.value);
    });
    view.dataset.lineupView = select.dataset.lineupBinding;
    view.setAttribute('aria-label', '查看' + entry.label + (entry.raidId ? '阵容' : ''));
    select.onchange = () => {
      if (entry.raidId === null) configSet(spec.key, select.value);
      else {
        const bindings = configGet(spec.key).filter(binding => binding[bindingField] !== entry.raidId);
        if (select.value) bindings.push({ [bindingField]: entry.raidId, presetId: select.value });
        configSet(spec.key, bindings);
      }
      root.refresh();
    };
    let label;
    if (entry.raidId) {
      label = el('label', 'config-label', entry.label); label.htmlFor = select.id; root.append(label);
    }
    line.append(select, view); root.append(line);
    controls.push({ ...entry, select, view, line, label });
  }
  const hint = el('p', 'config-help', fleetPicker ? '请先勾选参与舰队以逐队指定阵容。' : '副本列表暂未载入，请刷新挂机配置。');
  if (fleetPicker || !entries.length) root.append(hint);
  root.refresh = () => {
    let visible = 0;
    for (const { raidId, select, view, label, line } of controls) {
      select.value = raidId === null ? configGet(spec.key) : configGet(spec.key).find(binding => binding[bindingField] === raidId)?.presetId ?? '';
      view.disabled = !select.value;
      if (fleetPicker) { label.hidden = line.hidden = !configGet('worldBoss.fleetIds').includes(raidId); if (!line.hidden) visible++; }
    }
    if (fleetPicker) hint.hidden = visible > 0;
  };
  root.refresh();
  return root;
}

function configRenderUsage() {
  const group=configEditor.groups.get(configEditor.selectedGroups[configEditor.category]),preview=configEditor.previewSummary;
  const relevant=(configEditor.runtime?.controls??[]).filter(c=>group?.controlKeys?.includes(c.key));
  const active=relevant.filter(c=>c.enabled&&!/^(控制项|分组控制)/.test(c.observation?.text??''));
  const success=active.filter(c=>c.observation?.state==='ok').length,waiting=active.filter(c=>c.observation?.state==='waiting').length,pending=active.filter(c=>['pending','error'].includes(c.observation?.state)).length;
  const usePreview=preview?.group===group?.id&&preview?.scope===$('config-preview-scope').value;
  const type=usePreview?preview.scopeLabel:group?.title||'当前模块';
  const unseen=active.filter(c=>!c.observation?.checkedAt).length;
  let progress=active.length?(unseen===active.length?'尚无执行检查记录':'最近结果：成功 '+success+' 项 · 等待 '+waiting+' 项 · 未确认/失败 '+pending+' 项'+(unseen?' · 未检查 '+unseen+' 项':'')):relevant.length?'当前未开启具体执行项目':'尚无执行记录';
  const actualProgress=usePreview?(preview.notes??[]).find(text=>/今日已用|已领至|已领取至|今日.*已完成|当前进度/.test(text)):null;
  if(actualProgress)progress=actualProgress;else if(active.length===1&&active[0].observation?.checkedAt)progress=active[0].observation.text;
  if (!usePreview && group?.id === 'weekly-activities' && configEditor.draft?.weeklyActivity?.enabled) {
    const selected = ['farm','pet','antique','order','forge','hero'].filter(kind => configEditor.draft.weeklyActivity[kind + 'Enabled']).length;
    if (selected) progress = '已配置 ' + selected + ' 项全天活动；执行情况见日志';
  }
  // 条件包含等待、阻碍及正常状态，直接保留预览说明，避免关键词筛选漏掉预算等原因。
  const notes=usePreview?[
    ...(preview.notes??[]),
    ...(preview.forge?.factories??[]).filter(f=>f.reason).map(f=>f.buildingId+'：'+f.reason),
    ...(preview.dispatch?.fleets??[]).map(f=>f.reason),
  ]:relevant.flatMap(c=>[...(c.blockedBy?.map(name=>'需开启'+name)??[]),...(['waiting','error','pending'].includes(c.observation?.state)?[c.observation.text]:[])]);
  const conditions=[...new Set(notes.filter(n=>typeof n==='string'&&n.trim()).map(n=>n.trim()))];
  const conditionText=conditions.length?conditions.slice(0,3).join('；')+(conditions.length>3?'；其余见下方条件':'')
    :!usePreview?'尚未预览，请先读取当前状态'
    :preview.viewOnly?'已完成只读检查，详见下方状态'
    :preview.actions.length?'本次预览可安排动作，执行前会重新核对条件'
    :'当前无可执行动作，详见下方状态与条件';
  const root=clear($('config-usage'));
  root.append(el('div','','任务类型：'+type),el('div','','进度：'+progress+(usePreview?'；本次'+(preview.viewOnly?'只读查看':preview.actions.length+'项待执行（仅预览）'):'')),el('div','','执行条件：'+conditionText));
}

function configSyncRecovery(runtime) {
  if (configPageStale() || !current || !configVisible()) return;
  const recovery = runtime.settingsRecovery ?? null, loaded = configEditor.owner === current ? configEditor.data : null;
  if (!recovery?.required && !loaded?.recovery?.required && !configEditor.recoveryNotice) return;
  const marker = JSON.stringify([runtime.settingsRevision, recovery]);
  const observed = configEditor.recoverySync;
  if (!configEditor.recoveryNotice && marker === JSON.stringify([loaded?.revision, loaded?.recovery ?? null])) return;
  if (observed?.account === current && observed.marker === marker && (observed.pending || observed.complete)) return;
  // 先取消旧草稿的定时保存，再等读取；网络缓慢时也不能把已失效的草稿写回。
  if (recovery?.required) {
    configEditor.recoveryNotice = recovery;
    if (recovery.reason === 'unavailable' || configEditor.owner === current && configIsDirty()) {
      configEditor.recoveryBlocked = true; configCancelSaveTimer();
    }
    configMessage(''); configUpdateState();
  }
  if (configEditor.busy || configEditor.loading) return;
  const check = { account: current, marker, pending: true, complete: false }; configEditor.recoverySync = check;
  void configLoad().then(data => {
    if (configEditor.recoverySync !== check) return;
    check.pending = false; check.complete = !!data;
  });
}

async function configLoad(force = false) {
  if (configPageStale()) { configMessage(''); return; }
  if (configEditor.busy || configEditor.loading) return;
  if (!current) { configMessage('请先添加或选择账号。'); return; }
  const account = current, version = ++configEditor.serial, original = JSON.stringify(configEditor.draft);
  if (force) configCancelSaveTimer();
  configEditor.loading = true; configBusy(true);
  if (!Object.keys(configEditor.errors).length) configMessage('');
  configUpdateState();
  try {
    const [data,runtime]=await Promise.all([call('/api/settings?fleets=1'),call('/api/loop').catch(()=>null)]);
    if (configPageStale() || account !== current || version !== configEditor.serial) return;
    const recoveryChanged = data.recovery?.required && (data.recoveryToken !== configEditor.data?.recoveryToken || JSON.stringify(data.recovery) !== JSON.stringify(configEditor.data?.recovery));
    if((!force || JSON.stringify(configEditor.draft)!==original)&&configEditor.owner===account&&configEditor.draft&&!(recoveryChanged&&!configIsDirty()&&!configEditor.recoveryBlocked)&&
      (configEditor.recoveryBlocked || configIsDirty() || (data.revision===configEditor.data?.revision && data.baseRevision===configEditor.data?.baseRevision && JSON.stringify(data.settings)===JSON.stringify(configEditor.baseline) && JSON.stringify(data.catalog)===JSON.stringify(configEditor.data.catalog)))){
      if (recoveryChanged) {
        configEditor.recoveryBlocked = true; configCancelSaveTimer();
      }
      configEditor.runtime=runtime;configEditor.data={...configEditor.data,usage:data.usage,pendingUsage:data.pendingUsage};
      const displayChanged=JSON.stringify(data.rules)!==JSON.stringify(configEditor.data.rules)||JSON.stringify(data.tasks)!==JSON.stringify(configEditor.data.tasks);
      configEditor.data={...configEditor.data,rules:data.rules,tasks:data.tasks,compatibility:data.compatibility,
        recovery:configEditor.recoveryBlocked ? data.recovery ?? configEditor.data.recovery : data.recovery,recoveryToken:data.recoveryToken};
      configEditor.recoveryNotice = null;
      configCompatibilityMessage(data);
      // 活动开放状态独立于保存版本；更新入口时保留草稿和原基线，避免覆盖编辑或绕过版本冲突。
      if(displayChanged){configEditor.previewSummary=null;configRender();}else configRenderUsage();
      return data;
    }
    configEditor.runtime=runtime;configEditor.previewSummary=null;
    if(force||configEditor.owner!==account){configCollapsed.clear();configDisclosureSeen.clear();configCollapsedSections.clear();}
    configEditor.owner = account; configEditor.data = data; configEditor.draft = structuredClone(data.settings); configEditor.baseline = structuredClone(data.settings); configEditor.errors = {}; configEditor.recoveryBlocked = data.recovery?.reason === 'unavailable'; configEditor.recoveryNotice = null;
    configCancelSaveTimer(); configEditor.saveError = null; configEditor.saveRetries = 0;
    configEditor.playerData = null; configEditor.playerRequest = null; configEditor.playerError = '';
    $('config-account-name').textContent = (accounts.find(row => row.id === account)?.title || '当前账号') + '的挂机配置';
    configRender(); configCompatibilityMessage(data);
    return data;
  } catch (error) { if (account === current && version === configEditor.serial) configMessage(error.message, 'error'); }
  finally {
    if (version === configEditor.serial) { configEditor.loading = false; configBusy(false); configUpdateState(); configWeeklyRankingSync(); }
  }
}

async function configReload() {
  if (configPageStale()) { configMessage(''); return; }
  if (configEditor.busy || configEditor.loading) return;
  if (configIsDirty() && !window.confirm('当前草稿未生效。重新载入会丢弃本页未保存的更改，并读取服务器当前配置，是否继续？')) return;
  await configLoad(true);
}

async function configMayChangeAccount(next) {
  if (next === current) return true;
  if (configEditor.busy && !configEditor.saving) { configMessage('配置正在载入或导入处理中，请稍后再切换账号。'); return false; }
  const account = current;
  if (await configFlush()) return account === current;
  if (account !== current || configEditor.busy || configEditor.loading) return false;
  return window.confirm('当前配置未能自动保存。切换账号会丢弃这些更改，是否继续？');
}
function configAccountChanged() {
  resetWorldMap();
  if (configEditor.owner === current) return;
  configWeeklyRankingReset();
  configCancelSaveTimer(); configEditor.savePromise = null; configEditor.saving = false; configEditor.saveError = null; configEditor.saveRetries = 0; configEditor.busy = false;
  configEditor.serial++; configEditor.owner = null; configEditor.data = null; configEditor.draft = null; configEditor.baseline = null; configEditor.loading = false; configEditor.errors = {}; configEditor.recoveryBlocked = false; configEditor.recoveryNotice = null; configEditor.recoverySync = null;
  configEditor.runtime=null;configEditor.previewSummary=null;
  configEditor.playerData = null; configEditor.playerRequest = null; configEditor.playerError = ''; configEditor.playerWidgets = [];
  configCollapsed.clear();configDisclosureSeen.clear();configCollapsedSections.clear();
  clear($('config-fields')).append(el('p', 'config-empty', '正在切换账号配置…')); clear($('config-preview-result')); clear($('config-usage')); configBusy(false); configUpdateState();
  if (configVisible()) void configLoad(true);
}

function configErrors(error, { focus = true } = {}) {
  configClearErrors();
  configEditor.errors = error.fields ?? {};
  configMessage(error.fields?.revision ? '配置已在其他页面更新。刷新页面可读取最新配置，本页未保存的更改会被丢弃。' : error.message, 'error');
  let first;
  for (const [key, text] of Object.entries(configEditor.errors)) {
    const lookup = key === 'factory.speedUpSources' ? 'factory.demandPriority' : key;
    const widget = configEditor.widgets.get(lookup);
    if (!widget) continue;
    widget.row.hidden = false; widget.error.textContent = text; widget.error.hidden = false; widget.control?.setAttribute('aria-invalid', 'true');configRevealSection(widget); first ??= widget;
  }
  configUpdateVisibility();
  if (focus && first) { configActivate(first.spec.category); configActivateGroup(first.spec.groupId); first.control?.focus?.(); first.row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  else if (focus) $('config-message').scrollIntoView({ block: 'nearest' });
}

function configCheckForm({ focus = true } = {}) {
  for (const [key, widget] of configEditor.widgets) {
    for (const input of widget.row.querySelectorAll('input[type=number], input[type=time]')) {
      if (!input.checkValidity()) {
        configEditor.errors[key] = input.type === 'time' ? '请填写有效的北京时间。' : '请填写有效整数，并遵守输入范围。'; widget.row.hidden = false;
        widget.control?.setAttribute('aria-invalid', 'true'); widget.error.textContent = configEditor.errors[key]; widget.error.hidden = false;
        configUpdateVisibility();
        if (focus) { configActivate(widget.spec.category); configActivateGroup(widget.spec.groupId); input.focus(); input.reportValidity(); }
        return false;
      }
    }
  }
  return true;
}

async function configRefreshPlayers() {
  const account = configEditor.owner, serial = configEditor.serial;
  if (!account || !configEditor.draft) return;
  if (configEditor.playerRequest?.account === account && configEditor.playerRequest.serial === serial) return configEditor.playerRequest.promise;
  const job = { account, serial, promise: null };
  configEditor.playerRequest = job; configEditor.playerError = '';
  for (const paint of configEditor.playerWidgets) paint();
  job.promise = (async () => {
    try {
      const data = await call('/api/settings/players');
      if (account !== current || account !== configEditor.owner || serial !== configEditor.serial) return;
      configEditor.playerData = data;
    } catch (error) {
      if (account === current && serial === configEditor.serial) configEditor.playerError = error.message;
    } finally {
      if (configEditor.playerRequest === job) { configEditor.playerRequest = null; for (const paint of configEditor.playerWidgets) paint(); }
    }
  })();
  return job.promise;
}

function configPlayerPicker(spec, id) {
  const root = el('div', 'config-player-picker'); root.id = id; root.tabIndex = -1; root.setAttribute('role', 'group'); root.setAttribute('aria-label', spec.label);
  const selected = el('div', 'config-player-tags');
  // 点击姓名标签时，焦点须留在下拉框内，避免落到外层分组触发失焦关闭。
  const details = el('details', 'config-multi'); details.tabIndex = -1;
  const summary = el('summary', '', '选择盟友'); summary.setAttribute('aria-label', '选择' + spec.label); details.append(summary);
  const panel = el('div', 'config-multi-panel'); const search = el('input', 'config-input'); search.type = 'search'; search.placeholder = '搜索昵称或角色 ID'; search.setAttribute('aria-label', '搜索' + spec.label);
  const status = el('p', 'config-help'); status.setAttribute('role', 'status');
  const list = el('div', 'config-option-list');
  const refresh = configButton('刷新盟友名单', () => { void configRefreshPlayers(); }); refresh.setAttribute('aria-label', '刷新' + spec.label + '盟友名单');
  const manual = el('div', 'config-add'); const input = el('input', 'config-input'); input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 19; input.placeholder = '补充完整角色 ID'; input.setAttribute('aria-label', '补充' + spec.label + '角色ID');
  const manualError = el('p', 'config-field-error'); manualError.hidden = true;
  const limit = spec.key === 'treasure.followPlayerIds' ? 30 : 100;
  function change(value, checked) {
    const values = configGet(spec.key);
    if (checked && !values.includes(value) && values.length >= limit) { manualError.textContent = '最多选择' + limit + '位玩家'; manualError.hidden = false; paint(); return; }
    configSet(spec.key, checked ? [...new Set([...values, value])] : values.filter(item => item !== value)); manualError.hidden = true; paint();
  }
  const add = configButton('添加 ID', () => {
    const value = input.value.trim();
    if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > (1n << 63n) - 1n) { manualError.textContent = '请输入完整的正整数角色 ID，不能使用科学计数法'; manualError.hidden = false; input.focus(); return; }
    change(value, true); if (configGet(spec.key).includes(value)) input.value = '';
  }); add.setAttribute('aria-label', '添加' + spec.label + '角色ID');
  manual.append(input, add);
  function paintList() {
    const focusId = list.contains(document.activeElement) ? document.activeElement.value : null;
    const scrollTop = list.scrollTop;
    clear(list);
    const query = search.value.trim().toLocaleLowerCase(), values = configGet(spec.key);
    const matches = (configEditor.playerData?.members ?? []).filter(member => (member.name + ' ' + member.id).toLocaleLowerCase().includes(query));
    for (const member of matches) {
      const option = el('label', 'config-option'); const check = el('input'); check.type = 'checkbox'; check.value = member.id; check.checked = values.includes(member.id); check.onchange = () => change(member.id, check.checked);
      const label = el('span'); label.append(el('span', 'config-player-name', member.name), el('small', 'config-help', 'ID ' + member.id + (member.online ? ' · 在线' : '')));
      option.append(check, label); list.append(option);
      if (member.id === focusId) check.focus({ preventScroll: true });
    }
    if (configEditor.playerData && !matches.length) list.append(el('p', 'config-help', query ? '没有匹配的盟友，可改用完整角色 ID 或补充昵称。' : '当前没有可选择的盟友，已排除自己及联盟黑名单。'));
    list.scrollTop = scrollTop;
  }
  function paint() {
    const values = configGet(spec.key), members = configEditor.playerData?.members ?? [];
    if (!values) return;
    clear(selected);
    for (const value of values) {
      const member = members.find(row => row.id === value);
      const duplicateName = member && members.filter(row => row.name === member.name).length > 1;
      const name = member ? member.name + (duplicateName ? '（' + value + '）' : '') : '角色 ' + value;
      const tag = el('span', 'config-player-tag'); const text = el('span', '', name); text.title = '角色 ID：' + value;
      const remove = configButton('移除', () => { change(value, false); summary.focus(); }, 'remove'); remove.setAttribute('aria-label', '从' + spec.label + '移除' + name);
      tag.append(text, remove); selected.append(tag);
    }
    selected.hidden = !values.length;
    summary.textContent = values.length ? '选择盟友 · 已选 ' + values.length + ' 位' : '选择盟友';
    refresh.disabled = !!configEditor.playerRequest; refresh.textContent = configEditor.playerRequest ? '正在读取…' : '刷新盟友名单';
    const data = configEditor.playerData;
    status.textContent = configEditor.playerError || (configEditor.playerRequest ? '正在读取盟友…' : data?.reason || (data ? (data.guildName || '当前联盟') + ' · 可选 ' + members.length + ' 位盟友' : '尚未读取盟友名单'));
    if (details.open) paintList();
  }
  search.oninput = paintList;
  details.ontoggle = () => {
    if (details.open) { paintList(); configPlacePanel(details, panel); if (!configEditor.playerData) void configRefreshPlayers(); search.focus({ preventScroll: true }); }
    else details.classList.remove('open-up');
  };
  details.onkeydown = event => { if (event.key === 'Escape') { details.open = false; summary.focus(); event.stopPropagation(); } };
  panel.append(search, status, list, refresh, manual, manualError); details.append(panel); root.append(selected, details);
  configEditor.playerWidgets.push(paint); paint(); return root;
}

function configCityWarRoles(spec, id) {
  const root = el('div'); root.id = id; root.tabIndex = -1; root.setAttribute('role', 'group'); root.setAttribute('aria-label', spec.label);
  const entries = new Map();
  const empty = el('p', 'config-help', '先选择城战参与舰队，再逐队设置进攻或防守。');
  const available = configEditor.data.catalog.expeditionFleets ?? [];
  const availableIds = new Set(available.map(fleet => fleet.value));
  // 未同步的旧舰队平时不展示；其保留策略报错时仍须提供可修正的控件。
  const retained = Object.keys(configEditor.draft.cityWar.fleetStrategies ?? {}).filter(id => !availableIds.has(id));
  const fleets = [...available, ...retained.map(value => ({ value, label: '远征舰队 ' + value.replace('远征船', '') + ' 队（未同步）' }))];
  for (const fleet of fleets) {
    const buildingId = fleet.value, name = fleet.label || buildingId;
    const branch = el('div', 'config-war-fleet'); branch.dataset.fleetId = buildingId;
    const row = el('div', 'config-dispatch-row config-war-role'), select = el('select', 'config-select');
    const label = el('label', 'config-order-name', name); select.id = id + '-' + buildingId; label.htmlFor = select.id;
    label.id = select.id + '-label'; select.setAttribute('aria-label', name + '城战职责');
    for (const [value, text] of [['attack', '进攻'], ['defence', '防守']]) { const option = el('option', '', text); option.value = value; select.append(option); }
    select.onchange = () => {
      const others = (configGet(spec.key) ?? []).filter(value => value !== buildingId);
      configSet(spec.key, select.value === 'defence' ? [...others, buildingId] : others);
    };
    const disclosure = el('button', 'config-disclosure'); disclosure.type = 'button';
    const panel = el('div', 'config-children config-war-strategy'); panel.id = select.id + '-strategy';
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-labelledby', label.id);
    disclosure.setAttribute('aria-controls', panel.id);
    const entry = { branch, select, disclosure, expanded: false, keys: [], speedStates: [] }; entries.set(buildingId, entry);
    const expand = value => {
      if (!value && panel.contains(document.activeElement)) disclosure.focus({ preventScroll: true });
      entry.expanded = value; panel.hidden = !value;
      disclosure.textContent = value ? '收起设置' : '展开设置';
      disclosure.setAttribute('aria-expanded', String(value));
      disclosure.setAttribute('aria-label', name + (value ? '，收起设置' : '，展开设置'));
    };
    disclosure.onclick = () => expand(!entry.expanded);
    panel.revealConfig = () => { branch.hidden = false; empty.hidden = true; expand(true); };
    const prefix = 'cityWar.fleetStrategies.' + buildingId + '.';
    const mode = configField(prefix + 'strategyMode', '策略配置', 'choice', {
      category: spec.category, groupId: spec.groupId, options: [['global', '跟随全局'], ['custom', '独立配置']],
      help: '跟随全局时使用页面下方的全局攻守策略。切换到独立配置可单独设置本队；切回全局会保留本队的独立设置。',
    });
    entry.keys.push(mode.key);
    const fields = cityWarStrategyFields.map(template => {
      const field = template.key.split('.')[1], defence = field.startsWith('defence');
      const cityList = field === 'cityRefs' || field === 'defenceCityRefs';
      const key = prefix + field; entry.keys.push(key);
      return { ...template, key, parent: undefined, category: spec.category, groupId: spec.groupId,
        help: template.help?.replaceAll('本组', '本队').replaceAll('进攻队', '本队进攻时').replaceAll('防守队', '本队防守时'),
        when: draft => {
          const isDefence = (draft.cityWar.defenceFleetIds ?? []).includes(buildingId);
          return configGet(mode.key) === 'custom' && defence === isDefence && (!cityList || configGet(prefix + (defence ? 'defenceTargetMode' : 'targetMode')) === 'selected');
        } };
    });
    configRenderFields([mode, ...fields], panel);
    const speedFields = (spec.speedFields ?? []).filter(field =>
      availableIds.has(buildingId) && configGet('fleetSpeed.fleets.' + field.fleetIndex + '.id') === buildingId
    ).map(field => ({ ...field, section: undefined, label: field.label.replace(/^舰队\d+ · /, '') }));
    entry.keys.push(...speedFields.map(field => field.key));
    configRenderFields(speedFields, panel);
    for (const field of speedFields.filter(field => ['repair', 'march'].includes(field.key.split('.').at(-1)))) {
      const widget = configEditor.widgets.get(field.key), notice = el('div', 'config-help');
      notice.id = widget.control.id + '-status';
      const status = el('span'); status.setAttribute('role', 'status');
      const state = { key: field.key, mode: field.key.split('.').at(-1), notice, status, targetKey: null };
      const fix = configButton('前往设置', () => {
        const target = configEditor.widgets.get(state.targetKey);
        if (!target) return;
        configActivate(target.spec.category); configActivateGroup(target.spec.groupId);
        configRevealSection(target); configUpdateVisibility();
        target.control.scrollIntoView({ block: 'center' }); target.control.focus({ preventScroll: true });
      });
      fix.setAttribute('aria-label', (state.mode === 'repair' ? '维修' : '派遣') + '加速，前往未生效的设置');
      state.fix = fix; notice.append(status, fix); entry.speedStates.push(state);
      widget.node.insertBefore(notice, widget.childPanel);
      widget.control.setAttribute('aria-describedby', [widget.control.getAttribute('aria-describedby'), notice.id].filter(Boolean).join(' '));
    }
    row.append(label, select, disclosure); branch.append(row, panel); root.append(branch); expand(false);
  }
  root.append(empty);
  root.refresh = () => {
    const selected = configGet('cityWar.fleetIds') ?? [], defence = configGet(spec.key) ?? [];
    let visible = false;
    for (const [buildingId, entry] of entries) {
      const prefix = 'cityWar.fleetStrategies.' + buildingId + '.', mode = configGet(prefix + 'strategyMode');
      if (entry.mode !== mode) {
        // 首次独立配置按切换当时的全局值初始化，同时同步已渲染的控件。
        for (const key of entry.keys) {
          const widget = configEditor.widgets.get(key);
          if (widget?.spec.kind === 'choice') widget.control.value = configGet(key);
          else widget?.control.refresh?.();
        }
        entry.mode = mode;
      }
      for (const state of entry.speedStates) {
        const issues = [];
        if (!configGet('cityWar.enabled')) issues.push(['cityWar.enabled', '城战接续总开关已关闭']);
        if (!configGet('resources.allowDiamonds')) issues.push(['resources.allowDiamonds', '全局自动钻石消耗已关闭']);
        if (!(configGet('resources.diamondDailyLimit') > 0)) issues.push(['resources.diamondDailyLimit', '全局每日钻石预算为 0']);
        if (!(configGet(state.key + 'DailyDiamonds') > 0)) issues.push([state.key + 'DailyDiamonds', '本项每日钻石上限为 0']);
        state.notice.hidden = !configGet(state.key) || !issues.length;
        state.status.textContent = issues.length ? '尚未生效：' + issues.map(([, reason]) => reason).join('；') + '。'
          : '';
        state.targetKey = issues[0]?.[0] ?? null; state.fix.hidden = !state.targetKey;
      }
      const hasError = entry.keys.some(key => configEditor.errors[key] || configEditor.widgets.get(key)?.error.hidden === false);
      const included = selected.includes(buildingId) && availableIds.has(buildingId);
      if (!included && !hasError && entry.branch.contains(document.activeElement)) root.focus({ preventScroll: true });
      else if (entry.keys.some(key => {
        const widget = configEditor.widgets.get(key);
        return widget?.row.hidden && widget.row.contains(document.activeElement);
      })) entry.disclosure.focus({ preventScroll: true });
      entry.branch.hidden = !included && !hasError; visible ||= !entry.branch.hidden;
      entry.select.disabled = !included; entry.select.value = defence.includes(buildingId) ? 'defence' : 'attack';
    }
    empty.hidden = visible;
  };
  root.refresh(); return root;
}

function configMultiselect(spec, id, options = {}) {
  const read = options.read ?? (() => configGet(spec.key));
  const write = options.write ?? (value => configSet(spec.key, value));
  const catalog = options.catalog ?? configEditor.data.catalog;
  const disabled = options.disabled === true;
  const root = el('details', 'config-multi'); root.id = id; root.setAttribute('aria-label', spec.label); root.tabIndex = -1;
  const summary = el('summary'); summary.setAttribute('aria-label', spec.label); root.append(summary);
  const panel = el('div', 'config-multi-panel');
  const search = el('input', 'config-input'); search.type = 'search'; search.placeholder = '搜索' + spec.label; search.setAttribute('aria-label', '搜索' + spec.label);
  const list = el('div', 'config-option-list'); const foot = el('div', 'config-select-foot');
  const count = el('span'); let limit = 120;
  const more = configButton('显示更多选项', () => { limit += 120; paintList(); });
  const all = () => {
    const options = (catalog[spec.catalog] ?? []).filter(item =>
      spec.key !== 'heroes.heroIds' || !item.hidden || read().includes(item.value));
    if (spec.catalog!=='expeditionFleets') for (const value of read()) if (!options.some(item => item.value === value)) options.unshift({ value, label: value + '（当前配置中未找到）' });
    return options;
  };
  function paintSummary() {
    const options = all(), values = read().filter(value=>spec.catalog!=='expeditionFleets'||options.some(item=>item.value===value));
    const names = values.map(value => options.find(item => item.value === value)?.label || value);
    const empty = spec.key === 'heroes.heroIds' && configGet('heroes.needsSelection')
      ? '旧配置曾允许培养全部英雄，请重新选择' : spec.empty || '请选择';
    summary.textContent = names.length ? names.slice(0, 2).join('、') + (names.length > 2 ? ' 等 ' + names.length + ' 项' : '') : empty;
  }
  function paintFooter(available, matchCount, selected) {
    const selectedCount = available.filter(item => selected.has(item.value)).length;
    count.textContent = '已选 ' + selectedCount + ' 项 · 匹配 ' + matchCount + ' 项';
    reset.disabled = disabled || selected.size === 0;
    if (selectAll) selectAll.disabled = disabled || selectedCount === available.length;
  }
  function paintList() {
    const oldScroll = list.scrollTop; clear(list);
    const query = search.value.trim().toLocaleLowerCase();
    const available = all();
    const matches = available.filter(item => (item.label + ' ' + item.value).toLocaleLowerCase().includes(query));
    const selected = new Set(read());
    for (const item of matches.slice(0, limit)) {
      const label = el('label', 'config-option'); const input = el('input'); input.type = 'checkbox'; input.checked = selected.has(item.value); input.disabled = disabled;
      input.onchange = () => {
        if (disabled) return;
        const values = read();
        write(input.checked ? [...values, item.value] : values.filter(value => value !== item.value));
        if (spec.key === 'heroes.heroIds' && item.hidden && !input.checked) { paintSummary(); paintList(); return; }
        paintSummary(); paintFooter(available, matches.length, new Set(read()));
      };
      label.append(input, el('span', '', item.label)); list.append(label);
    }
    if (!matches.length) list.append(el('p', 'config-help', '没有匹配项，试试其他名称。'));
    paintFooter(available, matches.length, selected);
    more.hidden = matches.length <= limit; list.scrollTop = oldScroll;
  }
  search.oninput = () => { limit = 120; paintList(); };
  root.ontoggle = () => {
    if (root.open) { paintList(); configPlacePanel(root, panel); search.focus({ preventScroll: true }); }
    else root.classList.remove('open-up');
  };
  root.onkeydown = event => { if (event.key === 'Escape') { root.open = false; summary.focus(); event.stopPropagation(); } };
  const actions = el('div', 'config-select-foot-actions');
  function applySelection(values, button) {
    if (disabled || button.disabled) return;
    const focused = button.ownerDocument?.activeElement === button;
    write(values); paintSummary(); paintList();
    // 操作按钮刚被禁用时，保留菜单的键盘焦点，Escape 仍可收起菜单。
    if (focused && button.disabled && root.open) {
      const doc = button.ownerDocument;
      if (doc.activeElement === button || doc.activeElement === doc.body) summary.focus({ preventScroll: true });
    }
  }
  const reset = configButton('清空选择', () => applySelection([], reset));
  const selectAll = spec.selectAll ? configButton('全选', () => applySelection(all().map(item => item.value), selectAll)) : null;
  if (selectAll) {
    selectAll.setAttribute('aria-label', '全选' + spec.label);
    actions.append(selectAll);
  }
  actions.append(reset); foot.append(count, actions);
  root.refresh = () => { paintSummary(); if (root.open) paintList(); };
  panel.append(search, list, more, foot); root.append(panel); paintSummary(); return root;
}

function configPriorityEditor(spec, id) {
  const root = el('div'); root.id = id; root.tabIndex = -1; root.setAttribute('role', 'group'); root.setAttribute('aria-label', spec.label);
  const options = spec.options?.map(([value, label]) => ({ value, label })) ?? configEditor.data.catalog[spec.catalog || 'demandSources'] ?? [];
  const factoryPriority = spec.key === 'factory.demandPriority';
  const itemLabel = spec.itemLabel || '需求来源';
  const picker = spec.checkboxes ? configMultiselect(spec, id + '-picker', {
    write(values) { configSet(spec.key, values); paint(); },
  }) : null;
  if (picker) root.append(picker);
  const list = el('ol', 'config-order-list'); root.append(list);
  const add = picker ? null : el('div', 'config-add');
  if (add) root.append(add);
  function paint(focusKey, direction) {
    clear(list); const values = configGet(spec.key); let focus;
    values.forEach((value, index) => {
      const label = options.find(item => item.value === value)?.label || value;
      const row = el('li', 'config-order-row'); row.append(el('span', 'config-order-num', String(index + 1)), el('span', 'config-order-name', label));
      const tools = el('div', 'config-order-tools');
      if (factoryPriority) {
        const speed = el('label', 'config-option'); const check = el('input'); check.type = 'checkbox'; check.checked = configGet('factory.speedUpSources').includes(value); check.setAttribute('aria-label', label + '工厂加速');
        check.onchange = () => { const current = configGet('factory.speedUpSources'); configSet('factory.speedUpSources', check.checked ? [...current, value] : current.filter(item => item !== value)); };
        speed.append(check, el('span', '', '工厂加速')); tools.append(speed);
      }
      const move = offset => { const next = [...values]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; configSet(spec.key, next); picker?.refresh(); paint(value, offset); };
      const up = configButton('上移', () => move(-1)); up.disabled = index === 0; up.setAttribute('aria-label', label + '上移');
      const down = configButton('下移', () => move(1)); down.disabled = index === values.length - 1; down.setAttribute('aria-label', label + '下移');
      const remove = configButton('移除', () => {
        configSet(spec.key, values.filter(item => item !== value));
        if (factoryPriority) configSet('factory.speedUpSources', configGet('factory.speedUpSources').filter(item => item !== value));
        picker?.refresh(); paint();
      }, 'remove'); remove.setAttribute('aria-label', '移除' + label);
      tools.append(up, down, remove); row.append(tools); list.append(row);
      if (value === focusKey) focus = direction === -1 ? up : down;
    });
    if (focus && !focus.disabled) focus.focus();
    if (!add) { list.hidden = !values.length; return; }
    if (!values.length) list.append(el('li', 'config-empty', spec.empty || '尚未选择需求来源。当前只按备货水位生产。'));
    clear(add); const select = el('select', 'config-select'); select.setAttribute('aria-label', '添加' + itemLabel);
    const available = options.filter(item => !values.includes(item.value));
    const blank = el('option', '', available.length ? '选择要添加的' + itemLabel : '已添加全部' + itemLabel); blank.value = ''; select.append(blank);
    for (const item of available) { const option = el('option', '', item.label); option.value = item.value; select.append(option); }
    const button = configButton('添加', () => { if (select.value) { configSet(spec.key, [...values, select.value]); paint(); } }); button.setAttribute('aria-label', '添加所选' + itemLabel); button.disabled = true;
    select.disabled = !available.length; select.onchange = () => { button.disabled = !select.value; };
    add.append(select, button);
  }
  paint(); return root;
}

function configCropEditor(spec, id) {
  const root = el('div'); root.id = id; root.tabIndex = -1; root.setAttribute('role', 'group'); root.setAttribute('aria-label', spec.label);
  const options = configEditor.data.catalog.crops ?? [];
  function paint() {
    clear(root); const values = configGet(spec.key); const list = el('ol', 'config-order-list');
    values.forEach((value, index) => {
      const name = options.find(item => item.value === value.id)?.label || value.id;
      const row = el('li', 'config-order-row'); row.append(el('span', 'config-order-num', String(index + 1)), el('span', 'config-order-name', name));
      const tools = el('div', 'config-order-tools'); const quantity = el('label', 'config-crop-quantity');
      const input = el('input'); input.type = 'number'; input.min = '0'; input.max = '100000'; input.step = '1'; input.required = true; input.value = value.target == null ? '' : String(value.target); input.setAttribute('aria-label', name + '备货数量');
      input.oninput = () => { const next = configGet(spec.key).map(item => ({ ...item })); next[index].target = input.value === '' ? null : Number(input.value); configSet(spec.key, next); };
      quantity.append(input, el('span', 'config-help', '件'));
      const move = delta => { const next = [...configGet(spec.key)]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; configSet(spec.key, next); paint(); };
      const up = configButton('上移', () => move(-1)); up.disabled = index === 0; up.setAttribute('aria-label', name + '上移');
      const down = configButton('下移', () => move(1)); down.disabled = index === values.length - 1; down.setAttribute('aria-label', name + '下移');
      const remove = configButton('移除', () => { configSet(spec.key, configGet(spec.key).filter(item => item.id !== value.id)); paint(); }, 'remove'); remove.setAttribute('aria-label', '移除作物' + name);
      tools.append(quantity, up, down, remove); row.append(tools); list.append(row);
    });
    if (!values.length) list.append(el('li', 'config-empty', '添加作物，设置备货数量，再调整种植顺序。'));
    const add = el('div', 'config-add'); const select = el('select', 'config-select'); select.setAttribute('aria-label', '选择作物');
    const available = options.filter(item => !values.some(row => row.id === item.value));
    const blank = el('option', '', available.length ? '选择作物' : '已添加全部作物'); blank.value = ''; select.append(blank);
    for (const item of available) { const option = el('option', '', item.label); option.value = item.value; select.append(option); }
    const button = configButton('添加作物', () => { if (select.value) { configSet(spec.key, [...configGet(spec.key), { id: select.value, target: 0 }]); paint(); } }); button.disabled = true;
    select.disabled = !available.length; select.onchange = () => { button.disabled = !select.value; };
    add.append(select, button); root.append(list, add);
  }
  paint(); return root;
}

function configSave(event, { automatic = false } = {}) {
  event?.preventDefault();
  configCancelSaveTimer();
  if (configPageStale()) { configVersionStale(); return Promise.resolve(false); }
  if (configEditor.savePromise) return configEditor.savePromise;
  if (!configEditor.draft || configEditor.busy || configEditor.loading || configEditor.owner !== current) return Promise.resolve(false);
  if (configEditor.recoveryBlocked) { configMessage(''); configUpdateState(); return Promise.resolve(false); }
  if (!configIsDirty()) return Promise.resolve(true);
  if (configEditor.saveError?.fields?.revision) return Promise.resolve(false);
  const intervalSave = loopIntervalSaves.get(current);
  if (intervalSave?.writing) {
    const account = current, serial = configEditor.serial;
    return intervalSave.promise.then(() => {
      if (account !== current || configEditor.owner !== account || configEditor.serial !== serial) return false;
      return configSave(null, { automatic });
    });
  }
  if (!configCheckForm({ focus: !automatic })) {
    configEditor.saveError = { fields: { ...configEditor.errors } };
    configMessage('请修正标出的配置，填写完整后会自动保存。', 'error'); configUpdateState();
    return Promise.resolve(false);
  }
  const account = current, serial = configEditor.serial, text = JSON.stringify(configEditor.draft);
  const active = () => account === current && account === configEditor.owner && serial === configEditor.serial;
  configEditor.saving = true; configEditor.saveError = null;
  configBusy(true);
  if (!Object.keys(configEditor.errors).length) configMessage('');
  configUpdateState();
  const job = (async () => { try {
    const data = await call('/api/settings', { method: 'POST', body: JSON.stringify({ settings: JSON.parse(text), revision: configEditor.data.revision, baseRevision: configEditor.data.baseRevision, recoveryToken: configEditor.data.recoveryToken }) });
    if (!active() || configPageStale()) return false;
    const edited = JSON.stringify(configEditor.draft) !== text;
    const normalized = !edited && JSON.stringify(data.settings) !== text;
    const displayChanged=JSON.stringify(data.rules)!==JSON.stringify(configEditor.data.rules)||JSON.stringify(data.tasks)!==JSON.stringify(configEditor.data.tasks);
    configEditor.data = data; configEditor.baseline = structuredClone(data.settings);
    configEditor.saveRetries = 0; loopSettingsRevision = data.revision;
    // 在途请求成功只确认它提交的草稿；后续编辑仍需等自己的校验结果。
    if (!edited || !configIsDirty()) configClearErrors();
    if (!edited) {
      configEditor.draft=structuredClone(data.settings);configEditor.errors={};
      if (!normalized) configUpdateVisibility();
    }
    if(displayChanged || normalized){configEditor.previewSummary=null;configRender();}
    // 常规保存仅更新常驻状态，避免成功提示条反复显隐挤动编辑中的表单。
    configRenderUsage();
    configCompatibilityMessage(data);
    if (!data.running) {
      const prior=loopFieldDefaults;
      if(!prior||$('loop-every').value===String(prior.seconds))$('loop-every').value=data.settings.loop.everySeconds;
      loopFieldDefaults={seconds:data.settings.loop.everySeconds};
    }
    return true;
  } catch (error) {
    if (active()) {
      // 较早提交的校验错误不能阻止随后已经修正的输入；版本冲突仍需人工处理。
      if (JSON.stringify(configEditor.draft) !== text && error.fields && !error.fields.revision) configEditor.saveError = null;
      else { configEditor.saveError = error; configErrors(error, { focus: !automatic }); }
    }
    return false;
  } finally {
    if (active()) {
      configEditor.savePromise = null; configEditor.saving = false; configBusy(false);
      if (configIsDirty() && configEditor.saveError && !configEditor.saveError.fields && configEditor.saveRetries < 3) {
        configScheduleSave(1000 * 2 ** configEditor.saveRetries++);
      }
      configUpdateState();
    }
  } })();
  configEditor.savePromise = job;
  return job;
}

async function configImportFile(event) {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file || !configEditor.draft || configEditor.busy) return;
  if (configPageStale()) { configMessage(''); return; }
  if (configEditor.recoveryBlocked) { configMessage('请先重新载入默认配置，再导入配置。', 'error'); return; }
  if (file.size > 262144) { configMessage('配置文件不能超过 256 KB。', 'error'); return; }
  const account = current, serial = configEditor.serial, original = JSON.stringify(configEditor.draft);
  const active = () => account === current && serial === configEditor.serial;
  configBusy(true); configUpdateState();
  try {
    let document;
    try { document = JSON.parse(await file.text()); } catch { throw new Error('文件不是有效 JSON，请选择本工具导出的配置文件。'); }
    const data = await call('/api/settings/validate', { method: 'POST', body: JSON.stringify({ document }) });
    if (!active() || configPageStale()) return;
    if (JSON.stringify(configEditor.draft) !== original) { configMessage('导入期间草稿发生了更改，已保留当前草稿。需要替换时请再次导入。'); return; }
    configEditor.draft = data.settings; configEditor.errors = {}; configEditor.saveRetries = 0;
    if (!configEditor.saveError?.fields?.revision) configEditor.saveError = null;
    configRender(); configScheduleSave();
    configMessage('配置已通过导入校验，将自动保存。', 'info');
  } catch (error) { if (active()) configErrors(error); }
  finally { if (active()) { configBusy(false); configUpdateState(); } }
}

async function configExport() {
  if (configPageStale()) { configDownloadDraft(); return; }
  if (!configEditor.draft || configEditor.busy || !configCheckForm()) return;
  const account = current, draft = structuredClone(configEditor.draft);
  configBusy(true); configUpdateState();
  try {
    const data = await call('/api/settings/validate', { method: 'POST', body: JSON.stringify({ settings: draft }) });
    if (account !== current) return;
    const exported = data.document;
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = '疯狂水世界-游戏配置.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    configMessage('已导出当前草稿，仅包含游戏配置，不含账号、登录凭据和当日用量。', 'success');
  } catch (error) { if (account === current) configErrors(error); }
  finally { if (account === current) { configBusy(false); configUpdateState(); } }
}

async function configPreview() {
  if (configPageStale()) { configMessage(''); return; }
  if (!configEditor.draft || configEditor.busy || !configCheckForm()) return;
  const account = current, original = JSON.stringify(configEditor.draft), category = configEditor.category, group = configEditor.selectedGroups[category], scope = $('config-preview-scope').value;
  const contextChanged = () => JSON.stringify(configEditor.draft) !== original || category !== configEditor.category || group !== configEditor.selectedGroups[category] || scope !== $('config-preview-scope').value;
  configBusy(true); configUpdateState(); $('config-preview').textContent = '读取真实状态…';
  try {
    const selected=scope.startsWith('module:')?configEditor.groups.get(scope.slice(7)):null;
    const dedicated={alliance:'alliance',guildShip:'guildShip',guildFort:'guildFort',silicon:'silicon',resourceFields:'resourceFields','hero-raid':'heroRaid',treasure:'world',radar:'radar','fleet-dispatch':'fleetDispatch','pirate-hunt':'pirateHunt',worldBoss:'worldBoss',cityWar:'cityWar',forge:'forge',antique:'antique',heroes:'heroes'};
    const runtime=await call('/api/loop');
    const source=selected?dedicated[selected.id]:scope;
    let data;
    if(selected?.id==='pirate-hunt'){
      const sweep=await call('/api/settings/preview',{method:'POST',body:JSON.stringify({settings:JSON.parse(original),category:'pirateSweep'})});
      const hunt=await call('/api/settings/preview',{method:'POST',body:JSON.stringify({settings:JSON.parse(original),category:'pirateHunt'})});
      data={...hunt,scopeLabel:selected.title,counts:{...sweep.counts,...hunt.counts},
        actions:[...sweep.actions,...hunt.actions],
        notes:[...sweep.notes.map(note=>'每日免费扫荡：'+note),...hunt.notes.map(note=>'首杀推进：'+note)],
      };
    }else if(source){
      data=await call('/api/settings/preview',{method:'POST',body:JSON.stringify({settings:JSON.parse(original),category:source})});
    }else{
      const controls=runtime.controls.filter(c=>selected.controlKeys.includes(c.key));
      data={groupRows:controls,fields:selected.fields,scopeLabel:selected.title,checkedAt:new Date().toISOString(),usage:configEditor.data.usage,viewOnly:true,actions:[],notes:[]};
      if(selected.category==='base' && selected.id!=='resources'){
        const plan=await call('/api/settings/preview',{method:'POST',body:JSON.stringify({settings:JSON.parse(original),category:'base'})});
        const bases={building:['build','finishUpgrade','speedUpUpgrade','buildSupply','challengeField','giveUpField'],factory:['startProduce','gainFactory','collectProduct','speedUpProduce','nativeProduce'],farm:['farm'],resident:['finishOrder','denyOrder','checkResidentOrders'],cargo:['cargo','cargoLoad','cargoClaim'],gold:['paidGold'],gather:['autoDive','diveEnhance','autoSalvage','salvageEnhance','autoFish','fishEnhance','floaters','antiqueFloaters']};
        data.moduleActions=plan.actions.filter(a=>a.setting?.split('.')[0]===selected.id || bases[selected.id]?.includes(a.kind));
        data.usage=plan.usage;
      }
      if(['daily-actions','daily-challenges','rewards'].includes(selected.id)){
        const plan=await call('/api/settings/preview',{method:'POST',body:JSON.stringify({settings:JSON.parse(original),category:'daily'})});
        const isTrial=a=>['trialPaidSweep','trialAdSweep'].includes(a.kind);
        data.moduleActions=plan.actions.filter(a=>selected.id==='daily-actions'?a.kind==='daily':selected.id==='daily-challenges'?isTrial(a):a.kind!=='daily'&&!isTrial(a));
        data.usage=plan.usage;
      }
      const activityNames={'weekly-activities':['军备竞赛'],'river-series':['走江踏浪','龙王罗盘','酆都法旨']};
      if(activityNames[selected.id]){
        const stats=await call('/api/activity-statistics?refresh=1');
        data.moduleActivities=stats.items.filter(r=>activityNames[selected.id].includes(r.name));
      }

    }
    if (account !== current) return;
    if (contextChanged()) { clear($('config-preview-result')); configMessage('草稿、分组或预览范围已变化，请重新预览。'); return; }
    configEditor.runtime=runtime;configEditor.data={...configEditor.data,usage:data.usage,...(data.pendingUsage?{pendingUsage:data.pendingUsage}:{})};configEditor.previewSummary={...data,group,scope};configRenderUsage();
    const root = clear($('config-preview-result'));
    if(data.groupRows){
      root.append(el('h4','',data.scopeLabel+' · 草稿与运行状态'));
      if(data.moduleActions)root.append(data.moduleActions.length?table(['拟执行动作','消耗'],data.moduleActions.map(a=>[a.label,a.costs.map(c=>c.name+' ×'+c.num).join('、')||'—'])):el('p','dim','当前无可排动作'));
      if(data.moduleActivities)root.append(data.moduleActivities.length?table(['活动','状态','进度'],data.moduleActivities.map(r=>[r.name,r.status,r.progress])):el('p','dim','尚无对应活动数据'));
      if(data.fields.length)root.append(table(['参数','草稿值'],data.fields.map(f=>{
        const value=configGet(f.key);
        return [f.label,typeof value==='boolean'?(value?'开':'关'):Array.isArray(value)?value.map(v=>typeof v==='object'?JSON.stringify(v):String(v)).join('、')||'未选':String(value??'未配置')];
      })));
      if(data.groupRows.length)root.append(table(['功能','最近进度','执行条件'],data.groupRows.map(c=>[c.label,c.progress,c.condition])));
      root.append(el('p','dim','只读 · 运行状态取自已保存配置'));
      return;
    }
    if(data.dispatch){if(data.dispatch.fuel!==undefined)root.append(el('p','config-help','汽油库存 '+(data.dispatch.fuel??'未同步')+' · 待确认占用 '+(data.dispatch.pending??'未同步')));root.append(table(['舰队','状态'],(data.dispatch.fleets??[]).map(f=>[f.name||f.buildingId,f.reason||'当前可用'])));}
    root.append(el('p', 'config-help', (data.scopeLabel || '当前分类') + (data.viewOnly ? ' · 只读' : ' · 可排 '+data.actions.length+' 项') + ' 检查时间：' + new Date(data.checkedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })));
    if (data.treasure) {
      const state = data.treasure;
      root.append(el('p', 'config-help', `读到 ${data.counts?.treasures ?? 0} 艘候选货轮、${data.counts?.fleets ?? 0} 支舰队，汽油 ${state.fuel ?? '未确认'}，每队费用 ${state.fuelPerFleet ?? '未确认'}，今日领奖 ${state.todayRewardTimes ?? '未确认'} / ${state.rewardLimit ?? '未确认'}。`));
      const mode = el('p', 'config-help title-with-help', '参与模式：' + (state.participationMode === 'always' ? '每次参与' : '打满就停'));
      mode.append(makeHelpTip('当前参与模式', state.participationMode === 'always' ? '领奖已满仍可参加，其他限制照常生效；不会增加游戏奖励次数。' : '领奖已满后不再派遣或维修。')); root.append(mode);
      if (state.targets?.length) root.append(table(['货轮', '本人实际进度 / 上限', '参与条件'], state.targets.map(target => [target.label,
        (target.personalProgress == null ? '未确认' : target.personalProgress + '%') + ' / ' + (target.personalProgressLimit ?? '?') + '%', target.reason || '满足目标条件'])));
      if (state.fleets?.length) root.append(table(['舰队', '实际状态 / 耐久', '游戏自动作战', '舰队条件'], state.fleets.map(fleet => [
        fleet.name, fleet.state + (fleet.durability != null ? ' · ' + fleet.durability + '/' + (fleet.maxDura ?? '?') : ''),
        fleet.autoFight == null ? '未取得' : fleet.autoFight ? '开启' : '关闭', fleet.reason || '满足',
      ])));
    }
    if (data.cityWar) {
      const state = data.cityWar;
      root.append(el('p', 'config-help', '原生每队每日委任额度：' + (state.nativeLimit ?? '未确认') + '；本工具原生委任设置：' +
        (state.nativeCommissionLimit === -1 ? '按 VIP 规则' : state.nativeCommissionLimit === 0 ? '关闭原生委任' : (state.nativeCommissionLimit ?? '?') + ' 次') +
        '；汽油 ' + (state.fuel ?? '未确认') + '。' +
        (state.startTime && state.endTime ? '服务器城战时段：' + new Date(state.startTime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' 至 ' + new Date(state.endTime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未取得有效城战时段。')));
      if (state.fleets?.length) root.append(table(['舰队 / 职责', '实际状态', '今日原生委任', '接续条件'], state.fleets.map(f => [f.name + ' · ' + (f.role === 'defence' ? '防守' : '进攻'), f.state, (f.used ?? '?') + ' / ' + (f.limit ?? '?'), f.reason || '满足舰队条件'])));
      root.append(el('p', 'config-help', '攻守职责与各自目标配置在工具接续时生效。原生委任跟随联盟集结，需要立即按设置执行时将原生委任次数设为 0。守方队列采用服务器计数，可能包含城防 NPC。'));
      if (state.targets?.length) root.append(table(['城战目标 / 方向', '攻/守队列及交战 + 本盟在途', '单队行军汽油', '目标标记'], state.targets.map(t => {
        const total = t.alliedCount == null || t.transitCount == null ? null : t.alliedCount + t.transitCount;
        return [t.name + ' · ' + (t.role === 'defence' ? '防守' : '进攻'), t.alliedCount == null ? (t.countReason || '未确认')
          : t.alliedCount + ' 队' + (t.transitCount == null ? ' + 在途未确认' : ' + ' + t.transitCount + ' 在途 = ' + total + ' 队'),
          String(t.petrol), [t.assemble ? '联盟集结' : '', t.role === 'defence' ? '本盟城市受攻' : '本盟已宣战'].filter(Boolean).join(' · ')];
      })));
    }
    if (data.onlineReward) {
      const state = data.onlineReward;
      root.append(el('p', 'config-help', '城战在线奖励：已领 ' + (state.claimed ?? '未确认') + ' 档；' + (state.ready ? '第 ' + state.stage + ' 档可领取' : state.reason || '暂无可领取档位')));
    }
    if (data.forge) {
      const state = data.forge;
      root.append(el('p', 'config-help', '当前赛季 ' + (state.season ?? '未确认') + ' · 锻造等级 ' + (state.forgeLevel ?? '未确认') + ' · 金币 ' + (state.gold ?? '未确认')));
      root.append(el('p', 'config-help', '游戏原生开关表示游戏内的自动锻造状态；工具是否自动领取由本组总开关和领取选项决定。此预览只读，保存配置并运行挂机后才会执行。'));
      if (state.factories?.length) root.append(table(['工厂', '当前状态', '游戏原生开关', '工具检查', '操作'], state.factories.map(f => {
        let action = '—';
        if (f.recoverable) {
          const button = smallButton('确认已处理并解除');
          button.title = '仅在你已在游戏内领取、分解或穿戴上一件装备后使用；不会退回已确认消耗。';
          button.onclick = async () => {
            if (account !== current || !window.confirm('请确认上一件装备已在游戏内领取或处理完毕，解除后工具可能继续下一件锻造。')) return;
            button.disabled = true;
            try {
              await call('/api/equipment/forge/recover', { method: 'POST', body: JSON.stringify({ buildingId: f.buildingId, confirm: true }) });
              await configPreview();
            } catch { button.disabled = false; }
          };
          action = button;
        }
        return [f.buildingId, f.state, f.nativeAuto ? '开启' : '关闭', f.reason || '满足', action];
      })));
    }
    if (data.antique) {
      const state = data.antique;
      root.append(el('p', 'config-help', '已激活藏品 ' + (state.count ?? '未确认') + ' 件 · 套装 ' + (state.suits ?? '未确认') + ' 套 · 大师等级 ' + (state.masterLv ?? '未确认') + ' · 金币 ' + (state.gold ?? '未确认')));
    }
    const list = el('ol', 'config-preview-list');
    for (const action of data.actions) { const row = el('li', '', action.label); if (action.costs.length) row.append(el('span', 'config-preview-cost', '消耗：' + action.costs.map(cost => cost.name + ' ×' + cost.num).join('、'))); list.append(row); }
    root.append(list);
    if (data.notes.length) { const details = el('details'); details.append(el('summary', '', (data.viewOnly ? '状态说明（' : '查看跳过原因与条件（') + data.notes.length + '）')); const notes = el('ul'); for (const text of data.notes) notes.append(el('li', '', text)); details.append(notes); root.append(details); }
    configMessage('');
  } catch (error) {
    if (account === current) {
      if (contextChanged()) { clear($('config-preview-result')); configMessage('草稿、分组或预览范围已变化，请重新预览。'); }
      else {clear($('config-preview-result')).append(el('p','bad','预览未完成：'+error.message));configErrors(error);}
    }
  }
  finally { if (account === current) { configBusy(false); configUpdateState(); $('config-preview').textContent = '只读预览'; } }
}

$('config-form').onsubmit = event => { event.preventDefault(); void configFlush(); };
$('config-retry').onclick = () => { configEditor.saveRetries = 0; void configSave(); };
$('config-import').onclick = () => { if (!configEditor.busy) $('config-file').click(); };
$('config-file').onchange = configImportFile;
$('config-export').onclick = configExport;
$('config-preview').onclick = configPreview;
$('config-weekly-ranking-refresh').onclick = () => { void configWeeklyRankingLoad(true); };
$('config-preview-scope').onchange = () => {const value=$('config-preview-scope').value;if(value.startsWith('module:')){const g=configEditor.groups.get(value.slice(7));if(g){configActivate(g.category,false,false);configActivateGroup(g.id,false,true,true);}}configEditor.previewSummary=null;clear($('config-preview-result'));configRenderUsage();};
for (const tab of document.querySelectorAll('[data-config-tab]')) {
  tab.onclick = () => configActivate(tab.dataset.configTab);
  tab.onkeydown = event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const keys = Object.keys(configCategories), at = keys.indexOf(configEditor.category);
    const next = event.key === 'ArrowRight' ? (at + 1) % keys.length : event.key === 'ArrowLeft' ? (at + keys.length - 1) % keys.length : event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : null;
    if (next != null) { event.preventDefault(); configActivate(keys[next], true); }
  };
}
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#config-group-')) return;
  if (current && !configVisible()) document.querySelector('#tabs [data-tab="settings"]').click();
  if (configVisible() && configEditor.owner === current && configEditor.data) configApplyHash();
});
document.addEventListener('pointerdown', event => {
  for (const root of document.querySelectorAll('details.config-multi[open]')) if (!root.contains(event.target)) root.open = false;
});
// 同时覆盖配置页、活动详情及联盟互助动态生成的多选框。
let configPanelCleanup = null;
document.addEventListener('toggle', event => {
  const root = event.target;
  if (!root.matches('details.config-multi')) return;
  const panel = root.querySelector('.config-multi-panel');
  if (!panel) return;
  if (!root.open) {
    if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
    return;
  }
  configPanelCleanup?.();
  let frame = 0;
  const place = () => {
    frame = 0;
    if (!root.isConnected || !root.open || !root.querySelector('summary').getClientRects().length) { cleanup(); return; }
    configPlacePanel(root, panel);
  };
  const schedule = event => {
    if (event?.type === 'scroll' && panel.contains(event.target)) return;
    if (!frame) frame = requestAnimationFrame(place);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(root); resize.observe(panel);
  const changes = new MutationObserver(schedule);
  // 切页、收起父分组、切号重绘后及时撤下顶层浮层。
  changes.observe(document.body, { childList: true, subtree: true });
  for (let parent = root; parent; parent = parent.parentElement) changes.observe(parent, { attributes: true, attributeFilter: ['hidden', 'class', 'open'] });
  const close = () => { if (!root.open) cleanup(); };
  const escape = event => {
    if (event.key === 'Escape') { root.open = false; root.querySelector('summary').focus({ preventScroll: true }); event.preventDefault(); }
  };
  const blur = event => { if (event.relatedTarget && !root.contains(event.relatedTarget)) root.open = false; };
  function cleanup() {
    cancelAnimationFrame(frame); resize.disconnect(); changes.disconnect();
    window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule);
    root.removeEventListener('toggle', close); root.removeEventListener('keydown', escape); root.removeEventListener('focusout', blur);
    if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
    root.open = false;
    if (configPanelCleanup === cleanup) configPanelCleanup = null;
  }
  configPanelCleanup = cleanup;
  window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule); window.visualViewport?.addEventListener('scroll', schedule);
  root.addEventListener('toggle', close); root.addEventListener('keydown', escape); root.addEventListener('focusout', blur);
  place();
}, true);
window.addEventListener('cw-console-version-stale', configVersionStale);
window.addEventListener('online', () => { if (configIsDirty() && configEditor.saveError && !configEditor.saveError.fields) { configEditor.saveRetries = 0; configScheduleSave(0); } });
