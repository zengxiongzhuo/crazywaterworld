import { newStateFunction } from './fixtures/console-state.mjs';
// 执行真实层次渲染与显隐函数，使用内存草稿检查依赖关系和错误定位。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultSettings, settingsUiRules } from '../src/automation-settings.mjs';
import { automationTasks } from '../src/automation.mjs';

const source = fs.readFileSync(new URL('../src/settings-ui.js', import.meta.url), 'utf8');
const definitions = source.slice(0, source.indexOf("$('config-form').onsubmit"));
assert(definitions.length > 0 && definitions.length < source.length);

function fixture({ navigation = false } = {}) {
  const env = { nodes: new Map(), saves: 0, focused: null, category: null, group: null, navigation, hash: '' };
  class Element {
    constructor(tagName = 'div', className = '', text = '') {
      this.tagName = tagName.toUpperCase(); this.className = className; this.textContent = text;
      this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = new Map();
      this.hidden = false; this.disabled = false; this.valid = true;
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
        toggle: (name, force) => {
          const enabled = force ?? !this.classList.contains(name);
          if (enabled) this.classList.add(name); else this.classList.remove(name);
          return enabled;
        },
      };
    }
    get childNodes() { return this.children; }
    set id(value) { this.elementId = value; env.nodes.set(value, this); }
    get id() { return this.elementId; }
    get options() { return this.children; }
    add(node) { this.append(node); }
    getBoundingClientRect() { return { width: 0 }; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) {
      for (const node of nodes) {
        node.remove(); node.parentElement = this; this.children.push(node);
      }
    }
    prepend(...nodes) {
      for (const node of [...nodes].reverse()) {
        node.remove(); node.parentElement = this; this.children.unshift(node);
      }
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
      this.parentElement = null;
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector) {
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      const data = selector.match(/^\[data-([\w-]+)\]$/);
      if (data) return this.dataset[data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] !== undefined;
      if (selector === 'input[type=number]') return this.tagName === 'INPUT' && this.type === 'number';
      if (selector === 'input[type=time]') return this.tagName === 'INPUT' && this.type === 'time';
      return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map(value => value.trim());
      return this.children.flatMap(child => [
        ...(selectors.some(value => child.matches(value)) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    focus() { env.focused = this; }
    scrollIntoView() { this.scrolled = true; }
    checkValidity() { return this.valid; }
    reportValidity() { this.reported = true; return this.valid; }
  }
  env.el = (tagName, className, text) => new Element(tagName, className, text);
  env.node = id => {
    if (!env.nodes.has(id)) env.nodes.set(id, env.el());
    return env.nodes.get(id);
  };
  const api = newStateFunction('env', definitions + `
    const $ = env.node, el = env.el;
    const current = 'hierarchy-fixture';
    const document = {
      get activeElement() { return env.focused; },
      querySelectorAll(selector) {
        return [...env.nodes.values()].filter(node => !node.parentElement).flatMap(node => node.querySelectorAll(selector));
      },
    };
    const closeHelpTip = () => {};
    const location = { get hash() { return env.hash; } };
    const history = { replaceState(state, title, hash) { env.hash = hash; } };
    const Option = function(text, value) { const option = el('option', '', text); option.value = value; return option; };
    const clear = node => { for (const child of [...node.children]) child.remove(); return node; };
    configRenderUsage = () => {};
    configUpdateState = () => {};
    configScheduleSave = () => { env.saves++; };
    if (!env.navigation) {
      configActivate = category => { env.category = category; };
      configActivateGroup = group => { env.group = group; };
    }
    configRenderField = spec => {
      const row = el('div', 'config-row');
      const label = el('div', 'config-label-line');
      const name = el('label', 'config-label', spec.label);
      const box = el('div', 'config-control');
      const control = el(spec.kind === 'number' || spec.kind === 'time' ? 'input' : 'button');
      control.type = spec.kind; control.id = 'config-field-' + spec.key.replaceAll('.', '-');
      const error = el('div', 'config-field-error'); error.hidden = true;
      label.append(name); box.append(control, error); row.append(label, box);
      const widget = { row, control, error, spec, clearError() { error.hidden = true; control.removeAttribute('aria-invalid'); } };
      configEditor.widgets.set(spec.key, widget);
      if (spec.kind === 'cityWarRoles') {
        configRenderFields((spec.speedFields ?? []).map(field => ({ ...field, section: undefined })), control);
      }
      return row;
    };
    return {
      editor: configEditor, groups: configGroups, merchantFields: merchantActivityFields, collapsed: configCollapsed,
      render: configRenderFields, update: configUpdateVisibility, set: configSet,
      errors: configErrors, check: configCheckForm,
      renderPage: configRender, activate: configActivate, activateGroup: configActivateGroup, applyHash: configApplyHash,
    };
  `)(env);
  api.editor.draft = defaultSettings(); api.editor.baseline = structuredClone(api.editor.draft);
  api.editor.owner = 'hierarchy-fixture'; api.editor.data = { rules: settingsUiRules(), tasks: automationTasks };
  api.editor.playerData = {};
  return {
    ...api, env,
    widget: key => api.editor.widgets.get(key),
    expand(...keys) { for(const key of keys){const widget=api.editor.widgets.get(key);if(widget.disclosure.getAttribute('aria-expanded')!=='true')widget.disclosure.onclick();} },
    mount(fields) {
      const host = env.el();
      api.editor.fields.clear(); api.editor.widgets.clear();
      api.render(fields.map(field => ({ category: 'base', groupId: 'fixture', ...field })), host);
      api.update(); return host;
    },
  };
}

const visible = node => !node.hidden && (!node.parentElement ||
  (!(node.parentElement.tagName==='DETAILS'&&!node.parentElement.open&&node.tagName!=='SUMMARY')&&visible(node.parentElement)));
const keys = widgets => widgets.map(widget => widget.spec.key);
let passed = 0;
function test(name, run) { run(); passed++; console.log('通过：' + name); }

test('军备竞赛主项平铺且参数可展开收起，全天参与与积分模式保留目标', () => {
  const f = fixture({ navigation: true }); f.renderPage();
  f.env.hash = '#config-group-weekly-activities'; f.applyHash();
  assert.equal(f.editor.category, 'daily');
  assert(visible(f.env.node('config-group-weekly-activities')));
  const group = f.editor.groups.get('weekly-activities');
  assert.equal(group.title, '军备竞赛');
  assert(!f.editor.groups.has('military-week'));
  assert.deepEqual(new Set(group.fields.map(field => field.key)),
    new Set([...Object.keys(defaultSettings().weeklyActivity).filter(key => !/(?:Start|End)$/.test(key)).map(key => 'weeklyActivity.' + key), 'schedule.armsRaceRewards']));
  assert.equal(group.description, undefined);
  assert(!group.fields.some(field => /(?:Start|End)$/.test(field.key) || field.kind === 'time'));
  assert.deepEqual(f.widget('weeklyActivity.petStop').spec.options, [['allDay','全天参与'],['score','达到积分值时']]);
  const ids = [...f.editor.groups.values()].filter(item => item.category === 'daily').map(item => item.id);
  assert.equal(ids.indexOf('ad-rewards'), ids.indexOf('daily-actions') + 1);
  const panel = f.env.node('config-group-weekly-activities');
  assert.equal(panel.querySelectorAll('details').length, 0);
  assert.equal(panel.querySelectorAll('.config-field-section').length, 0);
  assert.equal(panel.querySelectorAll('.config-disclosure').length, 6);
  for (const kind of ['farm','pet','antique','order','forge','hero']) {
    const toggle = f.widget('weeklyActivity.' + kind + 'Enabled');
    assert.equal(panel.querySelectorAll('.config-label').filter(node => node.textContent === toggle.spec.label).length, 1);
    assert.equal(toggle.node.parentElement, panel);
    assert(toggle.disclosure);
    assert(!visible(f.widget('weeklyActivity.' + kind + 'Stop').node));
    f.set('weeklyActivity.' + kind + 'Enabled', true);
    assert.equal(toggle.disclosure.textContent, '展开设置');
    assert.equal(toggle.disclosure.getAttribute('aria-expanded'), 'false');
    assert(!visible(f.widget('weeklyActivity.' + kind + 'Stop').node));
    f.expand('weeklyActivity.' + kind + 'Enabled');
    assert.equal(toggle.disclosure.textContent, '收起设置');
    assert.equal(toggle.disclosure.getAttribute('aria-expanded'), 'true');
    assert(visible(f.widget('weeklyActivity.' + kind + 'Stop').node));
    assert(!f.widget('weeklyActivity.' + kind + 'Stop').disclosure);
  }
  assert(visible(f.widget('weeklyActivity.farmRecruitTimes').node));
  assert(visible(f.widget('weeklyActivity.farmSpeedUp').node));
  assert(visible(f.widget('weeklyActivity.petQualityOrder').node));
  assert(visible(f.widget('weeklyActivity.forgeQualityOrder').node));
  const score = f.widget('weeklyActivity.petScore');
  assert(!visible(score.node));
  f.set('weeklyActivity.petStop', 'score');
  assert(visible(score.node));
  f.set('weeklyActivity.petScore', 12000); f.set('weeklyActivity.petStop', 'allDay');
  assert(!visible(score.node)); assert.equal(f.editor.draft.weeklyActivity.petScore, 12000);
  f.set('weeklyActivity.petStop', 'score'); assert(visible(score.node));
  const beforeCollapse = structuredClone(f.editor.draft), saves = f.env.saves;
  f.widget('weeklyActivity.petEnabled').disclosure.onclick();
  assert(!visible(score.node));
  assert.deepEqual(f.editor.draft, beforeCollapse);
  assert.equal(f.env.saves, saves, '收起设置不触发配置保存');
  f.expand('weeklyActivity.petEnabled'); assert(visible(score.node));
  assert.equal(f.editor.draft.weeklyActivity.petScore, 12000);
  f.set('weeklyActivity.petScore', 12000); f.set('weeklyActivity.petEnabled', false);
  assert(!visible(score.node)); assert.equal(f.editor.draft.weeklyActivity.petScore, 12000);
  f.set('weeklyActivity.petEnabled', true); assert(visible(score.node));
  f.set('weeklyActivity.petEnabled', false);
  f.errors({ message: '目标积分无效', fields: { 'weeklyActivity.petScore': '请填正整数目标积分' } });
  assert(visible(score.node)); assert.equal(f.env.focused, score.control);
  f.env.hash = '#config-group-military-week'; f.applyHash();
  assert.equal(f.editor.selectedGroups.daily, 'weekly-activities');
});

test('英雄、藏品、装备各有唯一设置入口，原有分组书签指向新分类', () => {
  const f = fixture({ navigation: true }); f.renderPage();
  const categories = {
    heroes: ['heroes', 'hero-recruit'],
    antique: ['antique', 'antique-recruit'],
    equipment: ['forge'],
  };
  for (const [category, groupIds] of Object.entries(categories)) {
    assert.deepEqual([...f.editor.groups.values()].filter(g => g.category === category).map(g => g.id), groupIds);
    for (const group of groupIds) {
      f.env.hash = '#config-group-' + group; f.applyHash();
      assert(visible(f.env.node('config-group-' + group)));
      assert.equal(f.editor.category, category);
      assert.equal(f.env.node('config-preview-scope').value, 'module:' + group);
    }
  }
  for (const [id, keys] of Object.entries({
    'hero-recruit': ['schedule.freeRecruit', 'schedule.ticketRecruit', 'schedule.heroAdRecruit', 'schedule.heroRecruitRewards'],
    'antique-recruit': ['schedule.freeAntiqueRecruit', 'schedule.antiqueAdRecruit', 'schedule.antiqueRecruitRewards'],
  })) assert.deepEqual(new Set(f.editor.groups.get(id).fields.map(field => field.key)), new Set(keys));
  for (const key of ['schedule.equipmentCollect', 'schedule.equipmentCraft']) {
    assert(!f.editor.fields.has(key), '旧装备开关不应动态生成到其他分组：' + key);
  }
  f.env.hash = '#config-group-equipment-legacy'; f.applyHash();
  assert(visible(f.env.node('config-group-forge')));
  assert.equal(f.editor.category, 'equipment');
  assert.equal(f.env.node('config-preview-scope').value, 'module:forge');
  f.env.hash = '#config-group-daily-collections'; f.applyHash();
  assert(visible(f.env.node('config-group-hero-recruit')));
  assert.equal(f.env.saves, 0);
});

test('建筑分类直接展示设置，移除单一子标签和重复标题', () => {
  const f = fixture({ navigation: true }); f.renderPage();
  const panel = f.env.node('config-panel-base'), building = f.env.node('config-group-building');
  const family = f.env.node('config-family-construction');
  assert.equal(family.textContent, '建筑');
  assert.equal(family.getAttribute('aria-selected'), 'true');
  assert.equal(panel.querySelector('.config-subtabs').hidden, true);
  assert(!panel.querySelectorAll('[data-config-group]').some(tab => tab.dataset.configGroup === 'building'));
  assert.equal(building.querySelector('h3'), null);
  assert.equal(building.getAttribute('aria-labelledby'), family.id);
  assert(visible(building));
  for (const key of ['building.collect', 'building.build', 'building.upgrade', 'building.finish',
    'building.supply', 'building.disabledTypes', 'building.speedUp', 'building.keepBlueprints']) {
    assert(building.contains(f.widget(key).node), key);
  }
  assert(!f.editor.fields.has('schedule.weekFactory'));
  assert.equal(f.env.saves, 0);
});

test('建筑与多分组分类切换、键盘导航和旧链接都能定位同一份配置', () => {
  const f = fixture({ navigation: true }); f.renderPage();
  const before = structuredClone(f.editor.draft), panel = f.env.node('config-panel-base');
  f.env.node('config-family-production').onclick();
  assert.equal(panel.querySelector('.config-subtabs').hidden, false);
  assert(visible(f.env.node('config-group-factory')));
  f.activateGroup('farm');
  f.env.node('config-family-construction').onclick();
  assert(visible(f.env.node('config-group-building')));
  assert.equal(f.env.node('config-preview-scope').value, 'module:building');
  assert.equal(f.env.hash, '#config-group-building');
  f.env.node('config-family-construction').onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert(visible(f.env.node('config-group-farm')), '再次进入生产保留上次选择');
  f.env.hash = '#config-group-building'; f.applyHash();
  assert(visible(f.env.node('config-group-building')));
  f.activateGroup('building', true);
  assert.equal(f.env.focused, f.env.node('config-family-construction'));
  f.activate('world'); assert(visible(f.env.node('config-panel-world')));
  f.activate('base'); assert(visible(f.env.node('config-group-building')));
  assert.deepEqual(f.editor.draft, before);
  assert.equal(f.env.saves, 0);
});

test('所有显式父项位于同组，字段无重复且依赖无环', () => {
  const f = fixture();
  for (const group of [...f.groups, { id: 'sea-merchant-activity', fields: f.merchantFields }]) {
    const fields = new Map(group.fields.map(field => [field.key, field]));
    assert.equal(fields.size, group.fields.length, group.id);
    for (const field of group.fields) {
      const visited = new Set([field.key]);
      let parent = field.parent;
      while (parent) {
        assert(fields.has(parent), field.key + ' 的父项必须位于同组');
        assert(!visited.has(parent), field.key + ' 不能存在循环依赖');
        visited.add(parent); parent = fields.get(parent).parent;
      }
    }
  }
  const fields = new Map([...f.groups.flatMap(group => group.fields), ...f.merchantFields].map(field => [field.key, field]));
  for (const [child, parent] of [
    ['farm.crops', 'farm.customPlant'], ['pet.quality', 'pet.breed'],
    ['forge.universalReserve', 'forge.universal'], ['museum.matchedFactor', 'museum.materialFactor'],
    ['merchant.autoBuyPointers', 'merchant.autoSpeedUp'], ['merchant.pointerDailyDiamondLimit', 'merchant.autoBuyPointers'],
    ['silicon.fleets.0.huntPlayers', 'silicon.fleets.0.huntEnabled'],
    ['antique.targetStar', 'antique.star'],
    ['treasure.marchTargetSeconds', 'treasure.marchSpeedUp'], ['treasure.dailyDiamondLimit', 'treasure.marchSpeedUp'],
  ]) assert.equal(fields.get(child)?.parent, parent, child);
});
test('巨轮跟随后续方式仅在跟随与反复攻占同时开启时展示，切换开关保留选项', () => {
  const f = fixture();
  f.mount(f.groups.find(group => group.id === 'treasure').fields.filter(field => [
    'treasure.follow', 'treasure.repeatAttack', 'treasure.followMode',
  ].includes(field.key)));
  const mode = f.widget('treasure.followMode');
  assert.equal(mode.parentKey, 'treasure.follow');
  assert.equal(mode.spec.kind, 'radio');
  assert.deepEqual(mode.spec.options.map(option => option[0]), ['trigger', 'eachTime']);
  assert.equal(f.editor.draft.treasure.followMode, 'trigger');
  assert(!visible(mode.node));
  f.set('treasure.follow', true); f.expand('treasure.follow');
  assert(!visible(mode.node));
  f.set('treasure.repeatAttack', true);
  assert(visible(mode.node));
  f.set('treasure.followMode', 'eachTime');
  f.set('treasure.repeatAttack', false);
  assert(!visible(mode.node));
  f.set('treasure.repeatAttack', true); f.set('treasure.follow', false);
  assert(!visible(mode.node));
  f.set('treasure.follow', true);
  assert(visible(mode.node));
  assert.equal(f.editor.draft.treasure.followMode, 'eachTime');
});

test('设置页不再出现汽油保留量或消费上限，其他资源约束仍存在', () => {
  const f=fixture();f.renderPage();
  for(const key of ['worldBoss.petrolReserve','radar.petrolReserve','radar.dailyPetrolLimit','pirateHunt.petrolReserve','pirateHunt.fuelBudget','treasure.petrolReserve','treasure.maxRepairCost','treasure.dailyRepairPetrolLimit','cityWar.petrolReserve','cityWar.maxRepairCost','cityWar.dailyPetrolLimit','silicon.petrolReserve','silicon.dailyPetrolLimit','silicon.fleets.0.maxRepairCost'])assert.equal(f.widget(key),undefined,key);
  assert(f.widget('resources.diamondDailyLimit'));
});

test('海兽、博物馆和情报只展示统一配置，探宝单开关直接展开参数', () => {
  const f = fixture(); f.renderPage();
  for (const name of ['petCollect', 'petBreed', 'museumCollect', 'museumExplore', 'museumRevenue', 'museumAchievements', 'radarAuto', 'radarRepair']) {
    assert.equal(f.widget('schedule.' + name), undefined, name + ' 不能被动态配置重新生成');
  }
  assert(![...f.editor.fields.values()].some(field => /沿用原规则|旧规则/.test(field.label + (field.help ?? ''))));
  for (const key of ['museum.claim', 'museum.explore']) assert.equal(f.widget(key), undefined, '探宝不拆分领奖和派遣开关');
  assert.match(f.widget('museum.enabled').spec.help, /领取.*奖励.*派遣/);
  const museumFields = f.editor.groups.get('museum').fields;
  assert.deepEqual(museumFields.filter(field => !field.parent).map(field => field.key),
    ['museum.runEnabled', 'museum.upgrade', 'museum.revenue', 'museum.achievements', 'museum.display', 'museum.enabled']);
  for (const [child, parent] of [['museum.factorMode', 'museum.enabled'], ['museum.factor', 'museum.enabled'], ['museum.fullRecommendedFactor', 'museum.enabled'], ['museum.partialRecommendedFactor', 'museum.enabled'], ['museum.maxDispatches', 'museum.enabled'], ['museum.materialFactor', 'museum.enabled'],
    ['museum.noRecommendedFallback', 'museum.enabled'], ['museum.noRecommendedFactor', 'museum.noRecommendedFallback'],
    ['museum.maps', 'museum.enabled'], ['museum.useGuide', 'museum.enabled'],
    ['museum.dailyGuideLimit', 'museum.useGuide']]) assert.equal(f.widget(child).parentKey, parent, child);
  assert.equal(f.widget('radar.repairIdle').parentKey, null, '空闲维修可独立于情报派遣开启');
  assert.deepEqual(f.widget('museum.factorMode').spec.options, [['materials', '材料筛选模式'], ['recommended', '按推荐英雄选择']]);
  for (const key of ['factor', 'matchedFactor', 'fullRecommendedFactor', 'partialRecommendedFactor', 'noRecommendedFactor']) {
    const spec = f.widget('museum.' + key).spec;
    assert.equal(spec.kind, 'choice'); assert.equal(spec.numeric, true);
    assert.deepEqual(spec.options, [[1, '1倍'], [2, '2倍'], [3, '3倍']]);
  }
  assert.match(f.widget('pet.species').spec.empty, /不自动培育/);
  assert.match(f.widget('radar.fleetIds').spec.empty, /选择后才派遣/);
  assert(!visible(f.widget('museum.factor').node));
  f.set('museum.enabled', true); f.expand('museum.enabled');
  assert(visible(f.widget('museum.factor').node));
  f.set('museum.factor', 3); f.set('museum.enabled', false);
  assert(!visible(f.widget('museum.factor').node)); assert.equal(f.editor.draft.museum.factor, 3);
  f.set('museum.enabled', true);
  assert(visible(f.widget('museum.factor').node)); assert.equal(f.editor.draft.museum.factor, 3);
  f.set('museum.materialFactor', true); f.expand('museum.materialFactor');
  f.set('museum.stockThreshold', 25);
  assert(visible(f.widget('museum.stockThreshold').node));
  f.set('museum.factorMode', 'recommended');
  for (const key of ['factor', 'materialFactor', 'factorMaterials', 'stockThreshold', 'matchedFactor']) {
    assert(!visible(f.widget('museum.' + key).node), key + ' 材料参数在推荐模式隐藏');
  }
  for (const key of ['factorMode', 'fullRecommendedFactor', 'partialRecommendedFactor', 'noRecommendedFallback', 'maxDispatches', 'maps', 'useGuide']) assert(visible(f.widget('museum.' + key).node));
  assert.equal(f.editor.draft.museum.fullRecommendedFactor, 3); assert.equal(f.editor.draft.museum.partialRecommendedFactor, 2);
  assert.equal(f.editor.draft.museum.noRecommendedFallback, false); assert.equal(f.editor.draft.museum.noRecommendedFactor, 1);
  assert(!visible(f.widget('museum.noRecommendedFactor').node));
  f.set('museum.noRecommendedFallback', true); f.expand('museum.noRecommendedFallback');
  assert(visible(f.widget('museum.noRecommendedFactor').node)); f.set('museum.noRecommendedFactor', 3);
  f.set('museum.noRecommendedFallback', false);
  assert(!visible(f.widget('museum.noRecommendedFactor').node)); assert.equal(f.editor.draft.museum.noRecommendedFactor, 3);
  f.set('museum.fullRecommendedFactor', 2); f.set('museum.partialRecommendedFactor', 1);
  assert.equal(f.editor.draft.museum.factor, 3); assert.equal(f.editor.draft.museum.stockThreshold, 25);
  f.set('museum.factorMode', 'materials');
  assert(visible(f.widget('museum.factor').node)); assert(visible(f.widget('museum.stockThreshold').node));
  assert(!visible(f.widget('museum.fullRecommendedFactor').node)); assert(!visible(f.widget('museum.partialRecommendedFactor').node));
  assert(!visible(f.widget('museum.noRecommendedFallback').node)); assert(!visible(f.widget('museum.noRecommendedFactor').node));
  f.set('museum.factorMode', 'recommended');
  assert.equal(f.editor.draft.museum.fullRecommendedFactor, 2); assert.equal(f.editor.draft.museum.partialRecommendedFactor, 1);
  f.set('museum.noRecommendedFallback', true);
  assert(visible(f.widget('museum.noRecommendedFactor').node)); assert.equal(f.editor.draft.museum.noRecommendedFactor, 3);
});

test('舰队职责隶属参与舰队，逐队加速合并且维修与派遣省钻仍各自嵌套',()=>{
  const f=fixture({navigation:true});f.editor.draft.cityWar.enabled=true;
  Object.assign(f.editor.draft.fleetSpeed.fleets[0],{repair:true,march:true});
  f.renderPage();f.activate('world');f.activateGroup('cityWar');
  const sections=f.env.node('config-group-cityWar').querySelectorAll('.config-field-section');
  const global=f.env.node('config-section-cityWar-targetMode');
  assert.equal(sections.length,1);assert.equal(global.tagName,'DETAILS');
  assert.equal(global.querySelector('summary').textContent,'全局策略');
  assert.equal(global.open,false);
  assert(!visible(f.widget('cityWar.targetMode').node),'全局策略默认收起');
  global.open=true;global.ontoggle();
  assert(visible(f.widget('cityWar.targetMode').node),'展开后显示全局策略');
  const city=f.env.node('config-group-cityWar');
  assert.equal(f.widget('cityWar.dailyDispatchLimit'), undefined);
  assert(f.widget('cityWar.nativeCommissionLimit'));
  assert.equal(f.widget('fleetSpeed.enabled'),undefined);
  assert.equal(f.widget('fleetSpeed.dailyDiamondLimit'),undefined,'城战加速不再有中间合计上限');
  assert(f.widget('resources.diamondDailyLimit'));
  for(const mode of ['repair','march']){
    assert(f.widget('fleetSpeed.fleets.0.'+mode+'DailyDiamonds'));
    assert.equal(f.widget('fleetSpeed.fleets.0.'+mode+'MaxDiamonds'),undefined,'城战加速仅保留每日钻石上限');
  }
  const participants=f.widget('cityWar.fleetIds'),roles=f.widget('cityWar.defenceFleetIds');
  assert(city.children.indexOf(global)>city.children.indexOf(participants.node));
  assert.equal(participants.node.parentElement,city,'参与舰队直接展示，不再套分区折叠');
  assert.equal(roles.parentKey,participants.spec.key);
  assert.equal(roles.node.parentElement,participants.childPanel);
  assert.equal(participants.disclosure.textContent,'展开设置');
  assert(!visible(roles.node),'舰队职责与策略默认收起');
  participants.disclosure.onclick();
  assert.equal(participants.disclosure.textContent,'收起设置');
  assert(visible(roles.node));
  for(const mode of ['repair','march']){
    assert(roles.control.contains(f.widget('fleetSpeed.fleets.0.'+mode).node));
    const smart=f.widget('fleetSpeed.fleets.0.'+mode+'SmartSave');
    assert.equal(smart.parentKey,'fleetSpeed.fleets.0.'+mode);assert(!visible(smart.node));
    assert.equal(f.widget('fleetSpeed.fleets.0.'+mode+'SmartWaitSeconds').parentKey,smart.spec.key);
  }
  assert(!f.editor.fields.has('fleetSpeed.fleets.0.smartSave'));
  assert.equal(f.env.saves,0);
  participants.disclosure.onclick();
  f.errors({message:'预算无效',fields:{'fleetSpeed.fleets.0.repairDailyDiamonds':'请填写有效预算'}},{focus:false});
  assert.equal(participants.disclosure.getAttribute('aria-expanded'),'true','逐队字段错误自动展开参与舰队设置');
  assert(visible(f.widget('fleetSpeed.fleets.0.repairDailyDiamonds').node));
  f.errors({fields:{}},{focus:false});
  participants.disclosure.onclick();
  f.renderPage();
  assert.equal(f.widget('cityWar.fleetIds').disclosure.getAttribute('aria-expanded'),'false','重绘保留参与舰队收起状态');
  assert(visible(f.widget('cityWar.targetMode').node),'重绘保留全局策略展开状态');
  const expanded=f.env.node('config-section-cityWar-targetMode');
  expanded.open=false;expanded.ontoggle();f.renderPage();
  assert(!visible(f.widget('cityWar.targetMode').node),'重绘保留全局策略收起状态');
  f.errors({message:'策略无效',fields:{'cityWar.targetMode':'请选择有效的目标来源'}},{focus:false});
  assert.equal(f.env.node('config-section-cityWar-targetMode').open,true,'隐藏错误自动展开全局策略');
  assert(visible(f.widget('cityWar.targetMode').node));
  assert.equal(f.env.saves,0,'展开收起不保存配置');
});

test('自动挑战阵容位于推关与试炼对应开关下，仍可配置且不显示管理入口', () => {
  const f = fixture({ navigation: true });
  const fields = f.groups.find(group => group.id === 'progression').fields;
  const mainline = fields.findIndex(field => field.key === 'progression.mainline');
  const trials = fields.findIndex(field => field.key === 'progression.raidIds');
  assert.equal(fields[mainline + 1].key, 'lineups.mainlinePresetId');
  assert.equal(fields[mainline + 1].parent, 'progression.mainline');
  assert.equal(fields[trials + 1].key, 'lineups.trialPresets');
  assert.equal(fields[trials + 1].parent, 'progression.trials');
  f.editor.draft.progression.mainline = true;
  f.editor.draft.progression.trials = true;
  f.renderPage(); f.activate('world'); f.activateGroup('progression');
  f.expand('progression.mainline','progression.trials');
  const section = f.env.node('config-group-progression');
  for (const key of ['lineups.mainlinePresetId', 'lineups.trialPresets']) {
    assert(section.contains(f.widget(key).node));
    assert(visible(f.widget(key).node));
  }
  assert(!section.querySelectorAll('button').some(button => button.textContent === '管理自定义阵容'));
  assert.equal(f.env.saves, 0);
});

test('商人、海商王与超凡英雄配置集中在活动页，游戏配置没有重复字段或分组', () => {
  const f = fixture();
  assert(!f.groups.some(group => group.id === 'rich-merchant'));
  assert(!f.groups.some(group => group.id === 'hero-raid'));
  assert(!f.groups.some(group => group.id === 'merchant-week'));
  const fields = f.groups.flatMap(group => group.fields.map(field => field.key));
  for (const key of ['schedule.weekOrderSubmit', 'weekOrder.allowDiamonds', 'schedule.weekOrderFinal']) {
    assert(!fields.includes(key), key);
  }
  assert(!fields.some(key => key.startsWith('heroRaid.')));
  assert(!fields.some(key => key.startsWith('merchant.')));
});

test('不连续的培育参数跟随所属开关，并保持同级设置顺序', () => {
  const f = fixture();
  const fields = f.groups.find(group => group.id === 'pet').fields.filter(field => [
    'pet.breed', 'pet.species', 'pet.release', 'pet.releaseQualities', 'pet.quality', 'pet.universal',
  ].includes(field.key));
  const host = f.mount(fields), breed = f.widget('pet.breed'), release = f.widget('pet.release');
  assert.deepEqual(keys(breed.children), ['pet.species', 'pet.quality', 'pet.universal']);
  assert.deepEqual(keys(release.children), ['pet.releaseQualities']);
  assert.deepEqual(host.children, [breed.node, release.node]);
  assert.equal(f.widget('pet.quality').node.parentElement, breed.childPanel);
});

test('三级开关关闭隐藏全部后代，重新启用保留子开关与预算', () => {
  const f = fixture();
  Object.assign(f.editor.draft.merchant, { autoSpeedUp: true, autoBuyPointers: true, pointerDailyDiamondLimit: 300 });
  f.mount(f.merchantFields.filter(field => [
    'merchant.autoSpeedUp', 'merchant.autoBuyPointers', 'merchant.pointerDailyDiamondLimit',
  ].includes(field.key)));
  const parent = f.widget('merchant.autoSpeedUp'), purchase = f.widget('merchant.autoBuyPointers');
  const budget = f.widget('merchant.pointerDailyDiamondLimit');
  assert(!visible(budget.node),'已开启的配置也默认收起');f.expand('merchant.autoSpeedUp','merchant.autoBuyPointers');
  assert(visible(budget.node));
  f.set('merchant.autoSpeedUp', false);
  assert(!visible(purchase.node)); assert(!visible(budget.node));
  assert.equal(f.editor.draft.merchant.autoBuyPointers, true);
  assert.equal(f.editor.draft.merchant.pointerDailyDiamondLimit, 300);
  f.set('merchant.autoSpeedUp', true);
  assert(visible(budget.node)); assert.equal(parent.disclosure.getAttribute('aria-expanded'), 'true');
});

test('巨轮加速开关控制秒数与预算显隐，关闭后保留配置', () => {
  const f = fixture();
  Object.assign(f.editor.draft.treasure, { marchTargetSeconds: 90, dailyDiamondLimit: 300 });
  f.mount(f.groups.find(group => group.id === 'treasure').fields.filter(field => [
    'treasure.marchSpeedUp', 'treasure.marchTargetSeconds', 'treasure.dailyDiamondLimit',
  ].includes(field.key)));
  const speed = f.widget('treasure.marchSpeedUp'), seconds = f.widget('treasure.marchTargetSeconds');
  const budget = f.widget('treasure.dailyDiamondLimit');
  assert.equal(speed.spec.kind, 'switch'); assert.equal(seconds.spec.unit, '秒'); assert.equal(budget.spec.unit, '钻石');
  assert(!visible(seconds.node)); assert(!visible(budget.node));
  f.set('treasure.marchSpeedUp', true);
  assert(!visible(seconds.node),'启用功能不自动展开配置');f.expand('treasure.marchSpeedUp');
  assert(visible(seconds.node)); assert(visible(budget.node));
  f.set('treasure.marchSpeedUp', false);
  assert(!visible(seconds.node)); assert(!visible(budget.node));
  assert.equal(f.editor.draft.treasure.marchTargetSeconds, 90);
  assert.equal(f.editor.draft.treasure.dailyDiamondLimit, 300);
  f.set('treasure.marchSpeedUp', true);
  assert(visible(seconds.node)); assert(visible(budget.node));
});

test('默认收起、按需展开；手动收起后重新启用不擅自展开', () => {
  const f = fixture(); f.editor.draft.merchant.autoSpeedUp = true;
  const fields = f.merchantFields.filter(field => [
    'merchant.autoSpeedUp', 'merchant.dailyPointerLimit',
  ].includes(field.key));
  f.mount(fields);
  const parent = f.widget('merchant.autoSpeedUp'), child = f.widget('merchant.dailyPointerLimit');
  const before = structuredClone(f.editor.draft);
  assert(!visible(child.node));parent.disclosure.onclick();assert(visible(child.node));
  parent.disclosure.onclick();
  assert(!visible(child.node)); assert.equal(parent.disclosure.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(f.editor.draft, before); assert.equal(f.env.saves, 0);
  f.mount(fields);
  assert(!visible(f.widget('merchant.dailyPointerLimit').node), '重新渲染保留收起状态');
  f.set('merchant.autoSpeedUp', false); f.set('merchant.autoSpeedUp', true);
  assert(!visible(f.widget('merchant.dailyPointerLimit').node));
  assert.equal(f.env.saves, 2);
  f.expand('merchant.autoSpeedUp');assert(visible(f.widget('merchant.dailyPointerLimit').node));
  f.mount(fields);assert(visible(f.widget('merchant.dailyPointerLimit').node),'普通重绘保留手动展开，不打断编辑');
});

test('更换已收起的下拉模式保持收起，显式展开后按条件显示并正确收回焦点', () => {
  const f = fixture(); f.editor.draft.merchant.firstDepartureMode = 'smart';
  f.mount(f.merchantFields.filter(field => [
    'merchant.firstDepartureMode', 'merchant.firstDepartureTime', 'merchant.firstDepartureWaitMinutes',
  ].includes(field.key)));
  const mode = f.widget('merchant.firstDepartureMode'), time = f.widget('merchant.firstDepartureTime');
  const wait = f.widget('merchant.firstDepartureWaitMinutes');
  const savedTime = f.editor.draft.merchant.firstDepartureTime;
  const savedWait = f.editor.draft.merchant.firstDepartureWaitMinutes;
  assert(!visible(wait.node));f.expand('merchant.firstDepartureMode');assert(visible(wait.node)); assert(!visible(time.node));
  mode.disclosure.onclick();
  assert(!visible(wait.node)); assert(f.collapsed.has('merchant.firstDepartureMode'));
  f.set('merchant.firstDepartureMode', 'time');
  assert(!visible(time.node));assert(f.collapsed.has('merchant.firstDepartureMode'));f.expand('merchant.firstDepartureMode');
  assert(visible(time.node)); assert(!visible(wait.node));
  assert(!f.collapsed.has('merchant.firstDepartureMode'));
  assert.equal(mode.disclosure.getAttribute('aria-expanded'), 'true');
  time.control.focus(); f.set('merchant.firstDepartureMode', 'smart');
  assert(!visible(time.node)); assert(visible(wait.node));
  assert.equal(f.env.focused, mode.control);
  assert.equal(f.editor.draft.merchant.firstDepartureTime, savedTime);
  assert.equal(f.editor.draft.merchant.firstDepartureWaitMinutes, savedWait);
  assert.equal(f.env.saves, 2);
});

test('收起子组与关闭多层开关时焦点回到仍可见的父控件', () => {
  const f = fixture();
  Object.assign(f.editor.draft.merchant, { autoSpeedUp: true, autoBuyPointers: true });
  f.mount(f.merchantFields.filter(field => [
    'merchant.autoSpeedUp', 'merchant.autoBuyPointers', 'merchant.pointerDailyDiamondLimit',
  ].includes(field.key)));
  const parent = f.widget('merchant.autoSpeedUp'), purchase = f.widget('merchant.autoBuyPointers');
  const budget = f.widget('merchant.pointerDailyDiamondLimit');
  f.expand('merchant.autoSpeedUp','merchant.autoBuyPointers');
  budget.control.focus(); purchase.disclosure.onclick();
  assert(!visible(budget.node)); assert.equal(f.env.focused, purchase.control);
  assert.equal(f.env.saves, 0);
  purchase.disclosure.onclick(); budget.control.focus();
  f.set('merchant.autoSpeedUp', false);
  assert(!visible(purchase.node)); assert(!visible(budget.node));
  assert.equal(f.env.focused, parent.control); assert(visible(parent.control));
});

test('模块主控单独置顶后子项回到组级，各字段只渲染一次', () => {
  const f = fixture(), moved = new Set(settingsUiRules().controlFields);
  for (const group of f.groups) {
    const fields = group.fields.filter(field => !moved.has(field.key));
    const host = f.mount(fields);
    assert.equal(f.editor.widgets.size, fields.length, group.id);
    for (const field of fields) {
      const widget = f.widget(field.key);
      assert(host.contains(widget.node), field.key);
      if (field.parent && !fields.some(item => item.key === field.parent)) {
        assert(!widget.parentKey, field.key + ' 缺少父项时必须成为根节点');
        assert(widget.node.parentElement===host||widget.node.parentElement.classList.contains('config-field-section'),field.key);
      }
    }
  }
});

test('世界Boss领奖只在世界分组出现，首战派遣与领奖独立控制', () => {
  const f = fixture({ navigation: true }); f.renderPage();
  f.env.hash = '#config-group-worldBoss'; f.applyHash();
  assert.equal(f.editor.category, 'world');
  const group = f.editor.groups.get('worldBoss'), section = f.env.node('config-group-worldBoss');
  const reward = f.widget('schedule.worldBossRewards');
  assert.equal(group.fields.filter(field => field.key === 'schedule.worldBossRewards').length, 1);
  assert.equal([...f.editor.groups.values()].flatMap(item => item.fields).filter(field => field.key === 'schedule.worldBossRewards').length, 1);
  assert(!f.widget('schedule.worldBossDamage'), '旧领奖开关不再显示');
  assert.equal(reward.spec.label, '自动领取伤害达标奖励');
  assert.equal(reward.node.parentElement, section);
  assert(visible(reward.node));
  assert.equal(f.editor.draft.worldBoss.enabled, false);
  f.set('schedule.worldBossRewards', true);
  assert.equal(f.editor.draft.worldBoss.enabled, false, '开启领奖不自动派遣');
  f.set('worldBoss.enabled', true);
  f.set('worldBoss.enabled', false);
  assert.equal(f.editor.draft.schedule.worldBossRewards, true, '关闭首战不关闭领奖');
  assert(visible(reward.node), '关闭首战后领奖仍可编辑');
  const challenges = f.editor.groups.get('daily-challenges');
  assert.deepEqual(challenges.fields.map(field => field.key), ['schedule.leagueCollect', 'schedule.leaguePassRewards']);
});

test('所有模块主控与参数在同组，英雄组合主控保留细项，运行安排入口移除', () => {
  const f = fixture({ navigation: true }); f.renderPage();
  for (const control of settingsUiRules().moduleControls) {
    const widget = f.widget(control.key), group = f.env.node('config-group-' + control.configTarget);
    assert(widget?.spec.moduleControl, control.key);
    assert(group.contains(widget.node), control.key + ' 归属配置');
    assert.deepEqual(widget.spec.controlFields, control.fields);
  }
  f.set('heroes.enabled', false);
  assert.equal(f.editor.draft.heroes.enabled, false);
  assert.equal(f.editor.draft.loop.heroes, false);
  const details = { ...f.editor.draft.heroes }; delete details.enabled;
  f.set('heroes.enabled', true);
  assert.equal(f.editor.draft.loop.heroes, true);
  assert.deepEqual(f.editor.draft.heroes, { ...details, enabled: true });
  f.set('antique.enabled', false);
  f.activate('antique'); f.activateGroup('antique');
  const master = f.widget('antique.enabled'), section = f.env.node('config-group-antique');
  assert.equal(section.querySelector('fieldset'), null);
  assert.equal(master.node.parentElement, section);
  assert.equal(master.disclosure, undefined);
  for (const action of ['activate', 'star', 'master', 'suit']) {
    const row = f.widget('antique.' + action);
    assert.equal(row.node.parentElement, section);
    assert(row.disclosure, '保留参数展开入口 ' + action);
    assert(visible(row.node), '暂停时仍可编辑 ' + action);
  }
  assert.equal(f.widget('antique.targetStar').parentKey, 'antique.star');
  f.env.hash = '#config-group-runtime'; f.applyHash();
  assert.equal(f.editor.category, 'antique', '旧运行安排链接不切到空白页');
  assert.equal(f.editor.groups.has('runtime'), false);
  assert.equal(f.editor.widgets.has('loop.rounds'), false);
});

const nestedFields = [
  { key: 'sample.enabled', label: '功能开关', kind: 'switch' },
  { key: 'sample.purchase', label: '购买权限', kind: 'switch', parent: 'sample.enabled', when: draft => draft.sample.enabled },
  { key: 'sample.budget', label: '购买预算', kind: 'number', parent: 'sample.purchase', when: draft => draft.sample.enabled && draft.sample.purchase },
];

test('服务端校验错误展开关闭及手动收起的祖先并定位输入', () => {
  const f = fixture(); f.editor.draft.sample = { enabled: false, purchase: false, budget: -1 };
  f.mount(nestedFields);
  f.collapsed.add('sample.enabled'); f.collapsed.add('sample.purchase'); f.update();
  const budget = f.widget('sample.budget'); assert(!visible(budget.node));
  f.errors({ message: '预算需要修正', fields: { 'sample.budget': '预算不能小于零' } });
  assert(visible(budget.node)); assert.equal(f.env.focused, budget.control);
  assert.equal(f.env.group, 'fixture'); assert.equal(budget.error.hidden, false);
  assert.equal(f.editor.draft.sample.enabled, false); assert.equal(f.editor.draft.sample.purchase, false);
  assert.equal(f.env.saves, 0);
  f.set('sample.budget', 1);
  assert(visible(budget.node)); assert.equal(budget.error.hidden, false);
  assert.equal(f.env.focused, budget.control, '重新校验前保留提示和当前焦点');
  f.errors({ fields: {} }, { focus: false });
  assert(!visible(budget.node)); assert.equal(budget.error.hidden, true);
  assert.equal(f.env.focused, f.widget('sample.enabled').control);
  assert(visible(f.env.focused));
});

test('本地输入校验展开隐藏的错误项，后台校验保持当前焦点', () => {
  const f = fixture(); f.editor.draft.sample = { enabled: true, purchase: true, budget: 1 };
  f.mount(nestedFields);
  const budget = f.widget('sample.budget'), parent = f.widget('sample.enabled');
  assert(!visible(budget.node));budget.control.valid = false;
  const previous = f.env.el(); previous.focus();
  assert.equal(f.check({ focus: false }), false);
  assert(visible(budget.node)); assert.equal(f.env.focused, previous);
  assert.equal(f.check(), false); assert.equal(f.env.focused, budget.control); assert(budget.control.reported);
});

test('新校验结果替换旧字段提示，不强行显示已无错误的下级参数', () => {
  const f=fixture();f.editor.draft.sample={enabled:false,purchase:false,budget:1};f.mount(nestedFields);
  const budget=f.widget('sample.budget'),enabled=f.widget('sample.enabled');
  f.errors({message:'旧草稿错误',fields:{'sample.budget':'旧预算错误'}},{focus:false});
  assert(visible(budget.node));assert.equal(budget.error.hidden,false);
  f.errors({message:'新草稿错误',fields:{'sample.enabled':'功能配置错误'}},{focus:false});
  assert.equal(budget.error.hidden,true);assert.equal(budget.control.getAttribute('aria-invalid'),null);
  assert(!visible(budget.node));assert.equal(enabled.error.hidden,false);
});

console.log(`配置层次专项：${passed}/${passed} 组通过`);
