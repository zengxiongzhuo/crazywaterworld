import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { Card, CardAction, CardHeader, CardTitle, CardContent } from "./card"
import { Input } from "./input"
import { Switch } from "./switch"
import { HelpTip } from "./help-tip"
import { Badge } from "./badge"
import { DialogFooter, DialogHeader, DialogTitle } from "./dialog"
import { MessageCircle, Music2, Plus, QrCode, Smartphone, X } from "lucide-react"

function Panel({title, help, titleAfter, children}: {title: string; help?: string; titleAfter?: React.ReactNode; children: React.ReactNode}) {
  return <Card><CardHeader><CardTitle className="title-with-help">{title}{help && <HelpTip title={title}>{help}</HelpTip>}</CardTitle>{titleAfter && <CardAction className="row-span-1 self-center max-md:col-span-2 max-md:col-start-1 max-md:row-start-2 max-md:justify-self-start">{titleAfter}</CardAction>}</CardHeader><CardContent>{children}</CardContent></Card>
}

function Option({id, label, checked = false}: {id: string; label: string; checked?: boolean}) {
  return <div className="bar"><Switch id={id} data-local-switch="" defaultChecked={checked} className="p-0" /><label htmlFor={id}>{label}</label></div>
}

export function resultsPage() {
  return renderToStaticMarkup(<div className="results-page grid gap-3">
    <Panel title="挂机成果" titleAfter={<Button id="results-refresh" variant="outline" size="sm">刷新成果</Button>}>
      <p className="dim">查看挂机完成的事情、实际收获和消耗。区服轮换持续累计，今日成果按北京时间零点划分。</p>
      <div className="results-toolbar">
        <div className="results-period" role="group" aria-label="统计时间范围"><Button id="results-current" variant="outline" aria-pressed="true">本次挂机</Button><Button id="results-today" variant="outline" aria-pressed="false">今日累计</Button></div>
        <label htmlFor="results-scope">查看范围<select id="results-scope"><option value="role">当前区服</option><option value="login">同账号全部区服</option></select></label>
        <span id="results-status" className="dim" role="status">选择区服后查看成果</span>
      </div>
      <p id="results-run" className="results-run" />
      <div id="results-metrics" className="results-metrics" aria-label="挂机概览" />
      <p id="results-empty" className="results-empty" hidden>尚无挂机成果，开始挂机后会自动记录。</p>
    </Panel>
    <div className="results-columns">
      <Panel title="收获了什么"><div id="results-gains" className="results-assets" /></Panel>
      <Panel title="消耗了什么"><div id="results-costs" className="results-assets" /></Panel>
    </div>
    <div className="results-columns">
      <Panel title="做了哪些事情"><div id="results-actions" className="results-actions" /></Panel>
      <Panel title="各区服成果"><div id="results-roles" className="results-roles" /></Panel>
    </div>
    <Panel title="成果明细">
      <div id="results-events" className="results-events" />
      <div className="bar results-pagination"><Button id="results-previous" variant="outline" size="sm">上一页</Button><span id="results-page-number" className="dim" /><Button id="results-next" variant="outline" size="sm">下一页</Button></div>
      <details className="results-pending"><summary id="results-pending-label">待确认的操作</summary><div id="results-pending-list" /></details>
      <p className="dim results-note" id="results-note">奖励以服务器确认结果为准，待确认的操作单独展示。收获与消耗分别累计。</p>
    </Panel>
  </div>);
}

export function giftCodesPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="礼包兑换">
      <div className="bar"><Button variant="outline" size="sm" id="gift-select-all">全选</Button><Button variant="outline" size="sm" id="gift-select-none">清空</Button><span id="gift-selected-count" className="dim" /></div>
      <div id="gift-account-list" className="gift-account-list" role="group" aria-label="兑换账号" />
      <div className="bar gift-redeem-actions"><Button id="gift-code-start" disabled>开始兑换</Button><span id="gift-code-state" role="status" aria-live="polite" /></div>
    </Panel>
    <Panel title="共享礼包码库">
      <div className="bar gift-library-toolbar"><Button type="button" variant="outline" size="sm" id="gift-load-initial">载入未兑换码</Button><Button type="button" variant="outline" size="sm" id="gift-batch-add" aria-haspopup="dialog" aria-controls="gift-batch-dialog">批量新增</Button><label><input id="gift-show-processed" type="checkbox" /> 显示已处理</label></div>
      <p id="gift-code-initial-note" className="dim" role="status" />
      <div className="gift-library-table"><table><thead><tr><th scope="col">礼包码</th><th scope="col">可用状态</th><th scope="col">到期日期（北京时间）</th></tr></thead><tbody id="gift-code-library-rows" /></table></div>
    </Panel>
    <Panel title="兑换记录">
      <div className="bar gift-record-toolbar">
        <label htmlFor="gift-record-account">查看账号</label><select id="gift-record-account" />
        <label htmlFor="gift-record-status">状态</label><select id="gift-record-status" defaultValue="exclude-invalid">
          <option value="exclude-invalid">排除失效/不可用</option><option value="all">全部状态</option><option value="invalid">失效/不可用</option>
          <option value="retryable">可手动重试</option><option value="success">兑换成功</option><option value="used">已兑换</option><option value="rejected">服务器拒绝</option>
          <option value="unknown">待确认</option><option value="skipped">未发送</option><option value="queued">待兑换</option><option value="sending">兑换中</option>
        </select><Button id="gift-record-export" variant="outline" disabled>导出 CSV</Button>
      </div>
      <p id="gift-record-notice" className="dim" role="status" aria-live="polite" />
      <div className="overflow-auto table-stack"><table><thead><tr>{['礼包码','状态','结果','时间','操作'].map(title=><th scope="col" key={title}>{title}</th>)}</tr></thead><tbody id="gift-code-history" /></table></div>
      <div className="bar gift-record-pagination"><label htmlFor="gift-page-size">每页</label><select id="gift-page-size" defaultValue="10">{[10,20,50,100].map(size=><option key={size} value={size}>{size} 条</option>)}</select><Button variant="outline" id="gift-prev" disabled>上一页</Button><span id="gift-page" role="status" /><Button variant="outline" id="gift-next" disabled>下一页</Button></div>
    </Panel>
    <dialog id="gift-batch-dialog" aria-labelledby="gift-batch-title">
      <DialogHeader><DialogTitle id="gift-batch-title">批量新增礼包码</DialogTitle></DialogHeader>
      <div className="gift-batch-fields"><label htmlFor="gift-batch-input">礼包码</label><textarea id="gift-batch-input" rows={8} maxLength={65536} placeholder="每行一个礼包码" />
        <label htmlFor="gift-batch-expiry">到期日期（选填，北京时间）</label><Input id="gift-batch-expiry" type="date" />
        <p id="gift-batch-error" role="status" aria-live="polite" /></div>
      <DialogFooter><Button id="gift-batch-save" type="button">保存</Button><Button id="gift-batch-cancel" type="button" variant="outline">取消</Button></DialogFooter>
    </dialog>
  </div>)
}

export function overviewPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="运行概览" help="按功能分别查看当前进度与当前条件。这里只读展示；开关与参数在对应挂机配置中设置。">
      <div className="bar overview-task-filter"><Input id="overview-task-search" type="search" aria-label="查找运行状态" placeholder="功能名称或状态" /><label htmlFor="overview-task-filter">显示</label><select id="overview-task-filter" defaultValue="enabled"><option value="enabled">已开启</option><option value="issues">异常 / 受总控限制</option><option value="all">全部项目</option></select></div>
      <p id="overview-task-summary" className="dim" role="status">等待读取运行状态</p>
      <div id="overview-task-groups" />
    </Panel>
    <Panel title="世界概览" help="点城池可派遣空闲舰队驻防、增援或进攻。募兵、集结和宣战按当前角色与城池条件开放。行军位置按已同步的起终点和时间推算。地图刷新间隔可设为 5–300 秒。" titleAfter={<div className="world-refresh-controls"><Button id="world-map-auto-refresh" size="sm" variant="outline" aria-pressed="true">自动刷新：开</Button><label className="world-refresh-setting">每<input id="world-map-refresh-seconds" aria-label="世界概览刷新秒数" type="number" min="5" max="300" step="1" defaultValue="10" />秒</label></div>}>
      <div id="world-map-fleets" className="fleet-summary" aria-label="我的舰队" />
      <details className="world-map-stats"><summary>城战与货轮详情</summary><div id="world-map-wars" /><div id="world-map-treasures" /></details>
      <details className="world-map-stats"><summary>汽油用量</summary><div id="world-map-resources" /></details>
      <div className="bar world-map-toolbar"><Button id="world-map-refresh" variant="outline" size="sm">刷新地图</Button><Button id="world-map-pan" variant="outline" size="sm" aria-pressed="false">移动地图</Button><Button id="world-map-reset" variant="outline" size="sm">全图</Button><Button id="world-map-home" variant="outline" size="sm">定位舰队</Button><label htmlFor="world-map-zoom">缩放</label><input id="world-map-zoom" type="range" min="1" max="8" step="0.25" defaultValue="1" /><span id="world-map-time" role="status">尚未读取</span></div>
      <div id="world-map-layers" className="bar" />
      <div className="world-map-layout"><div className="world-map-stage">
        <div id="world-map-scroll" className="world-map-scroll"><svg id="world-map" role="group" aria-label="世界地图" /></div>
        <dialog id="world-map-detail" className="world-map-detail" aria-labelledby="world-map-target-name" hidden>
          <div className="world-map-detail-heading"><strong id="world-map-target-name" /><Button id="world-map-detail-close" variant="ghost" size="sm" aria-label="关闭地图详情"><X aria-hidden="true" size={16} /></Button></div>
          <div id="world-map-city-actions" className="world-city-actions" hidden />
          <div id="world-map-target-facts" />
        </dialog>
      </div><div id="world-map-legend" className="world-map-legend" /><div id="world-map-state-legend" className="world-map-state-legend" /><p className="world-map-help"><span className="for-mouse">拖动平移 · Ctrl+滚轮缩放 · 悬停查看城池操作，点击固定</span><span className="for-touch">点城池操作 · 点「移动地图」后可单指拖动</span></p></div>
      <p id="world-map-notes" className="dim" />
    </Panel>
    <Panel title="资源田概览" help="按资源类型查看已占数量与有效基础产量，展开查看明细。管理弹窗展示所有已占田，可逐块替换或放弃，也可选择新田占领。" titleAfter={<div className="bar"><a className="inline-link" href="#config-group-resourceFields">资源田配置</a><Button id="resource-fields-refresh" variant="outline" size="sm" disabled>刷新资源田</Button></div>}>
      <section id="resource-fields-overview" aria-label="资源田概览">
        <div className="resource-fields-toolbar"><span id="resource-fields-capacity">连接账号后读取资源田</span><span id="resource-fields-automatic" className="dim" /></div>
        <p id="resource-fields-feedback" className="resource-fields-feedback" role="status" hidden />
        <div id="resource-fields-summary" className="resource-fields-summary" />
        <details className="resource-fields-help"><summary>同步状态与玩法说明</summary><p id="resource-fields-status" className="dim" role="status">连接账号后读取资源田</p><p className="dim">总览可见时每 60 秒刷新。</p><p id="resource-fields-notes" className="dim" /><div id="resource-fields-pending" className="resource-fields-list" /><p>资源田产出汽油、种子或科技点，城市失守会暂停产出。上方为当前有效田地的基础小时产量，不含加成。</p><p>占领需要目标城市为本盟、本人尚未占领、有名额及足够汽油，并派出可用舰队。推荐战力仅供参考，派遣后仍需行军和战斗。</p><p>替换会先放弃旧田，再派舰队占领新田。新田战败或中途失败不会自动恢复旧田。开启自动占领后，每次检查都会优先寻找可占的高级田，按资源名额补位或替换低级田。</p></details>
      </section>
      <dialog id="resource-fields-action-dialog" aria-labelledby="resource-fields-action-title">
        <DialogHeader className="flex-row items-center justify-between"><DialogTitle id="resource-fields-action-title">管理资源田</DialogTitle><Button id="resource-fields-dialog-close" variant="outline" size="sm" aria-label="关闭资源田管理">关闭</Button></DialogHeader>
        <div id="resource-fields-manager">
          <div className="resource-fields-table-heading"><h3>已占资源田</h3><span className="dim">包含所有资源类型，可逐块替换或放弃</span></div>
          <div className="resource-fields-table-scroll" role="region" aria-label="已占资源田表格，可横向滚动" tabIndex={0}><table className="resource-fields-table"><thead><tr><th scope="col">资源</th><th scope="col">田地 / 等级</th><th scope="col">城市 / 格子</th><th scope="col">有效时产</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody id="resource-fields-owned-table" /></table></div>
          <p className="resource-fields-table-hint dim">左右滑动查看位置、产量与状态，操作按钮保持可见。</p>
          <div className="resource-fields-pagination"><Button id="resource-fields-owned-prev" variant="outline" size="sm">上一页</Button><span id="resource-fields-owned-page" className="dim" /><Button id="resource-fields-owned-next" variant="outline" size="sm">下一页</Button></div>
          <div id="resource-fields-replace-bar" className="resource-fields-replace-bar" hidden><div><strong>正在选择替换目标</strong><p id="resource-fields-replace-note" /></div><Button id="resource-fields-replace-cancel" variant="outline" size="sm">取消替换</Button></div>
          <div className="resource-fields-table-heading"><h3>可占资源田</h3><span className="dim">未选旧田时为新增占领</span></div>
          <div className="resource-fields-filters"><label htmlFor="resource-fields-resource">候选资源<select id="resource-fields-resource" defaultValue=""><option value="">全部资源</option><option value="汽油">汽油</option><option value="种子">种子</option><option value="公会科技点">科技点</option></select></label><label htmlFor="resource-fields-level">最低等级<input id="resource-fields-level" type="number" min="1" max="100" step="1" defaultValue="1" /></label><span className="dim">筛选仅影响下方候选表</span></div>
          <p id="resource-fields-candidate-count" className="dim" role="status" />
          <div className="resource-fields-table-scroll" role="region" aria-label="可占资源田表格，可横向滚动" tabIndex={0}><table className="resource-fields-table"><thead><tr><th scope="col">资源</th><th scope="col">田地 / 等级</th><th scope="col">城市 / 格子</th><th scope="col">基础时产</th><th scope="col">推荐战力</th><th scope="col">操作</th></tr></thead><tbody id="resource-fields-candidates" /></table></div>
          <p className="resource-fields-table-hint dim">左右滑动查看位置、产量与推荐战力。</p>
          <div className="resource-fields-pagination"><Button id="resource-fields-page-prev" variant="outline" size="sm">上一页</Button><span id="resource-fields-page-state" className="dim" /><Button id="resource-fields-page-next" variant="outline" size="sm">下一页</Button></div>
        </div>
        <div id="resource-fields-action-body" hidden />
        <DialogFooter><Button id="resource-fields-action-back" variant="outline" hidden>返回选田</Button><Button id="resource-fields-action-confirm" disabled hidden>确认派遣</Button><Button id="resource-fields-action-cancel" variant="outline">关闭</Button></DialogFooter>
      </dialog>
    </Panel>
    <Panel title="硅矿概览" help="空矿位的详情浮层可选择舰队采集；自己的采矿舰队首奖后可撤回。单次派遣与撤回不会改变自动配置。自动刷新仅影响此概览；鼠标悬停、键盘聚焦或手机轻触矿位查看详情。奖励由服务器自动发放，倒计时结束后需同步确认。" titleAfter={<div className="bar"><a className="inline-link" href="#config-group-silicon">硅矿配置</a><Button id="silicon-refresh" variant="outline" size="sm" disabled>刷新硅矿</Button></div>}>
      <section id="silicon-overview" aria-label="硅矿概览">
        <div className="silicon-toolbar"><span id="silicon-status" className="dim" role="status">连接账号后读取硅矿</span><div className="world-refresh-controls"><Button id="silicon-auto-refresh" size="sm" variant="outline" aria-pressed="true">自动刷新：开</Button><label className="world-refresh-setting">每<input id="silicon-refresh-seconds" aria-label="硅矿自动刷新秒数" type="number" min="5" max="300" step="1" defaultValue="30" />秒</label></div></div>
        <p id="silicon-feedback" className="silicon-feedback" role="status" hidden />
        <div id="silicon-summary" className="silicon-summary" />
        <div id="silicon-fleets" className="silicon-fleets" aria-label="硅矿舰队状态" />
        <div id="silicon-mines" className="silicon-mines" />
        <p id="silicon-notes" className="dim" />
      </section>
      <aside id="silicon-slot-popover" role="dialog" aria-label="矿位详情" hidden />
      <dialog id="silicon-action-dialog" aria-labelledby="silicon-action-title">
        <DialogHeader><DialogTitle id="silicon-action-title">硅矿快捷操作</DialogTitle></DialogHeader>
        <div id="silicon-action-body" />
        <DialogFooter><Button id="silicon-action-confirm" disabled>确认操作</Button><Button id="silicon-action-cancel" variant="outline">取消</Button></DialogFooter>
      </dialog>
    </Panel>
  </div>)
}

export function activitiesPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <div className="activity-toolbar"><Button id="activities-refresh" className="ml-auto" variant="outline" size="sm">刷新活动</Button></div>
    <div id="activities-status" className="dim" role="status" />
    <div className="activity-shell">
      <div id="activity-tabs" className="activity-tabs" role="tablist" aria-label="选择活动" />
      <section id="activity-panel" role="tabpanel" tabIndex={0} hidden>
        <Card><CardHeader><div className="activity-heading"><CardTitle id="activity-title" /><span id="activity-kind" /></div><p id="activity-end" className="dim" /></CardHeader>
          <CardContent className="activity-content">
            <div id="activity-pirates" hidden><div id="pirate-board-view" className="pirate-board" aria-live="polite" /></div>
            <div id="activity-detail"><div id="activities-list" className="activity-body" /><div id="activities-order" /></div>
          </CardContent>
        </Card>
      </section>
    </div>
    <template id="ui-event-switch"><Switch className="p-0" /></template>
  </div>)
}

export function manualPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="海面" help="收成品 → 竣工 → 交单 → 按订单缺口排产 → 余料升级建筑。本轮是否允许使用加速器、拒单重刷，由下方本次开关决定。">
    <div className="bar">
      <Option id="world-speedup" label="本轮允许花加速器" />
      <Option id="world-reroll" label="本轮拒单重刷" />
      <Button id="world-plan" variant="outline">刷新数据</Button>
      <Button id="world-run" variant="default">执行一轮</Button>
      <span id="world-hint" className="warn"></span>
    </div>
    <div id="world-view" role="status" />
    <div id="world-factories"></div>
    <div id="world-orders"></div>
    </Panel>
    <Panel title="需求联合排产" help="按用户配置的需求优先级逐级优化齐套时间，上游材料继承对应优先级。共享原料和生产位统一安排，独立设施并行生产。结果显示分层工期、投料顺序、时长依据和阻塞原因。">
      <div className="bar"><Button id="production-plan-refresh" variant="outline">计算联合排产</Button><span id="production-plan-status" className="dim" role="status">连接后可计算</span></div>
      <div id="production-plan-result" aria-live="polite" />
    </Panel>
    <Panel title="资源田"><div id="world-fields" /></Panel>
  </div>)
}

export function inventoryPage() {
  return renderToStaticMarkup(<div className="grid gap-3"><Panel title="仓库">
    <div className="bar"><Button id="inventory-refresh" variant="outline">刷新库存</Button><span id="inventory-status" className="dim" role="status">尚未读取</span></div>
    <div className="bar inventory-search"><label htmlFor="inventory-query">资源名称</label><Input id="inventory-query" type="search" placeholder="搜索资源名称" /><span id="inventory-match-count" className="dim" /></div>
    <details id="world-stock-panel"><summary>展开分类库存</summary><div id="world-stock" /></details>
  </Panel></div>)
}

export function heroesPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="英雄任命" help="开启后随自动挂机，使用游戏一键委任分配英雄，已有任命可能调整。" titleAfter={<div className="bar"><label htmlFor="appointments-enabled">自动委任</label><Switch id="appointments-enabled" className="p-0" disabled /></div>}>
      <div className="appointments-heading"><h4 id="appointments-priority-title">委任优先级</h4><span id="appointments-state" className="dim" role="status">请选择账号</span></div>
      <p id="appointments-help" className="dim">上方项目优先委任。拖动手柄或使用上移、下移调整，修改后自动保存。</p>
      <ol id="appointments-priorities" className="appointments-priorities" aria-labelledby="appointments-priority-title" aria-describedby="appointments-help" />
      <div className="bar"><Button id="appointments-retry" variant="outline" size="sm" hidden>重试保存</Button><Button id="appointments-reload" variant="outline" size="sm" hidden>重新载入</Button><span id="appointments-feedback" className="sr-only" aria-live="polite" /></div>
    </Panel>
    <Panel title="英雄装备">
      <div className="bar"><Button id="equipment-refresh" variant="outline">刷新装备</Button></div>
      <div id="equipment-view" className="progression-view" aria-live="polite" />
    </Panel>
    <Panel title="装备制造"><div className="bar"><Button id="crafting-refresh" variant="outline">刷新装备厂</Button></div><div id="crafting-view" className="progression-view" aria-live="polite" /></Panel>
  </div>)
}

export function lineupsPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="我的阵容" help="管理已保存的自定义阵容，点击查看或在弹窗中编辑。主线和试炼可在各自入口选择阵容，挑战结束后自动还原到挑战前的搭配。">
      <div id="saved-lineup-view" className="progression-view" />
    </Panel>
  </div>)
}

export function accountPage() {
  return renderToStaticMarkup(<div className="account-page">
    <div className="account-page-heading">
      <div className="account-page-title"><h2 className="text-xl font-semibold">账号</h2><span id="account-count" className="dim" aria-live="polite">正在读取</span></div>
      <div className="account-page-actions">
        <Button id="refresh-account-worlds" type="button" variant="outline">刷新区服</Button>
        <Button id="import-accounts" type="button" variant="outline">导入账号</Button>
        <input id="import-accounts-file" type="file" accept=".json,application/json" aria-label="选择账号备份文件" hidden />
        <Button id="export-accounts" type="button" variant="outline" aria-haspopup="dialog" aria-controls="account-export-dialog">导出账号</Button>
        <Button id="account-add" type="button" aria-haspopup="dialog" aria-controls="account-add-dialog"><Plus aria-hidden="true" />添加账号</Button>
      </div>
    </div>
    <p className="dim">每个区服角色分别展示。同一登录账号只能有一个区服在线，切换或开始其他区服挂机时，会结束旧区服的任务和连接。新角色默认不挂机，可通过卡片上的「登录设置」单独配置自动重连策略。</p>
    <p id="account-worlds-notice" className="dim" role="status" aria-live="polite" />
    <p id="account-add-notice" className="dim" role="status" hidden />
    <p id="account-transfer-notice" className="dim" role="status" aria-live="polite" hidden />
    <Panel title="区服轮换挂机" help="按顺序登录同一账号的区服，使用各角色已保存的挂机配置；到时停止并交接。每日时段按北京时间计算，支持跨午夜。">
      <form id="role-rotation-form" className="rotation-form" noValidate>
        <div className="rotation-heading"><label htmlFor="rotation-login">登录账号<select id="rotation-login" aria-label="轮换登录账号" /></label><p id="rotation-status" className="dim" role="status" aria-live="polite">正在读取轮换配置…</p></div>
        <fieldset id="rotation-fields" className="rotation-fields" disabled>
          <div className="bar"><label className="rotation-check"><input id="rotation-enabled" type="checkbox" />启用每日轮换</label><label className="rotation-check"><input id="rotation-all-day" type="checkbox" />全天运行</label></div>
          <div className="rotation-times"><label htmlFor="rotation-start">开始时间<Input id="rotation-start" type="time" defaultValue="23:00" /></label><label htmlFor="rotation-end">结束时间<Input id="rotation-end" type="time" defaultValue="06:00" /></label><p className="dim">北京时间；23:00–06:00 表示每天晚上 11 点到次日早上 6 点。</p></div>
          <label className="rotation-check"><input id="rotation-reconnect-enabled" type="checkbox" defaultChecked />意外断线自动重连</label>
          <div className="rotation-times"><label htmlFor="rotation-reconnect-retries">重试次数<Input id="rotation-reconnect-retries" type="number" min="1" max="1000" step="1" defaultValue="3" /></label><label htmlFor="rotation-reconnect-interval">重试间隔（秒）<Input id="rotation-reconnect-interval" type="number" min="1" max="86400" step="1" defaultValue="10" /></label><p className="dim">网络波动或心跳超时时重试当前区服，保留原交接时间；次数用完后尝试下一区服。主动暂停、切区和时段结束不会触发重连。</p></div>
          <p className="dim">勾选参与区服，按下面的顺序循环。挂机时长从登录完成后开始计算，时段结束时提前停止。</p>
          <div id="rotation-roles" className="rotation-roles" role="group" aria-label="参与轮换的区服与挂机时长" />
          <div className="bar"><Button id="rotation-save" type="submit">保存轮换配置</Button><Button id="rotation-pause" type="button" variant="outline" hidden>暂停轮换</Button><Button id="rotation-reload" type="button" variant="outline">载入最新配置</Button></div>
        </fieldset>
        <p id="rotation-notice" className="dim" role="status" aria-live="polite" />
        <p className="dim">手动切区、开始或停止挂机、暂停托管会暂停本账号的轮换，可点击「继续轮换」恢复。关闭网页后后台继续运行，请保持控制台启动窗口和电脑运行。</p>
      </form>
    </Panel>
    <div id="accounts" className="account-grid" />

    <dialog id="account-login-dialog" aria-labelledby="account-login-title">
      <div className="account-dialog-heading"><DialogHeader><DialogTitle id="account-login-title" className="leading-snug">登录设置</DialogTitle></DialogHeader><Button id="account-login-close" type="button" size="icon-sm" variant="ghost" aria-label="关闭登录设置"><X aria-hidden="true" /></Button></div>
      <div id="login-settings-root" data-account="">
        <p role="status" className="dim">正在载入登录设置…</p>
        <noscript>请启用 JavaScript 后编辑登录设置。</noscript>
      </div>
    </dialog>

    <dialog id="account-export-dialog" aria-labelledby="account-export-title" aria-describedby="account-export-scope">
      <div className="account-dialog-heading"><DialogHeader><DialogTitle id="account-export-title">导出账号</DialogTitle></DialogHeader><Button id="account-export-close" type="button" size="icon-sm" variant="ghost" aria-label="关闭账号导出"><X aria-hidden="true" /></Button></div>
      <div className="account-export-selection">
        <label className="account-export-all"><input id="account-export-all" type="checkbox" />全选账号</label>
        <p id="account-export-scope" className="dim" role="status" aria-live="polite" />
      </div>
      <div id="account-export-list" role="group" aria-label="选择要导出的账号" />
      <div className="grid gap-3">
        <Button id="account-export-only" type="button" variant="outline" className="h-auto pointer-coarse:h-auto whitespace-normal justify-start p-4"><span className="grid gap-1 text-left"><strong>仅账号</strong><span className="text-xs font-normal">保存登录凭据、备注和角色资料</span></span></Button>
        <Button id="account-export-settings" type="button" variant="outline" className="h-auto pointer-coarse:h-auto whitespace-normal justify-start p-4"><span className="grid gap-1 text-left"><strong>账号及配置</strong><span className="text-xs font-normal">同时保存每个账号的挂机配置和阵容预设</span></span></Button>
      </div>
      <p className="dim">文件含登录凭据，请妥善保管。配置不包含用量账本和运行状态。</p>
      <p id="account-export-error" className="warn" role="alert" hidden />
    </dialog>

    <dialog id="account-info-dialog" aria-labelledby="account-info-title">
      <div className="account-dialog-heading"><DialogHeader><DialogTitle id="account-info-title" className="leading-snug">账号详情</DialogTitle></DialogHeader><Button id="account-info-close" type="button" size="icon-sm" variant="ghost" aria-label="关闭账号详情"><X aria-hidden="true" /></Button></div>
      <div className="bar"><Button id="account-info-refresh" type="button" variant="outline">连接并读取</Button></div>
      <div id="account-details">
        <h4>角色概况</h4><div className="who" id="who">等待连接</div>
        <h4>资源</h4><div className="resource-strip" id="res">连接后显示</div>
        <h4>该登录账号的区服角色</h4>
        <div className="bar"><Button id="load-worlds" variant="outline">加载区服</Button><Input id="world-input" aria-label="区服 ID" placeholder="区服 ID" className="w-32" /><Button id="enter-world" variant="outline">进入该区服</Button><span id="worlds-hint" className="warn" /></div>
        <div id="worlds" />
      </div>
    </dialog>

    <dialog id="account-add-dialog" aria-labelledby="account-add-title" aria-describedby="account-add-step">
      <div className="account-dialog-heading"><DialogHeader><p id="account-add-step" className="dim" role="status">选择登录渠道</p><DialogTitle id="account-add-title" className="leading-snug">添加账号</DialogTitle></DialogHeader><Button id="account-add-close" type="button" size="icon-sm" variant="ghost" aria-label="关闭添加账号"><X aria-hidden="true" /></Button></div>
      <div className="account-add-body">
        <p id="account-add-feedback" className="phone-feedback" role="status" aria-live="polite" aria-atomic="true" />
        <div id="account-add-channels" className="account-channel-grid">
          <Button type="button" variant="outline" className="account-channel h-auto pointer-coarse:h-auto items-start justify-start gap-3.5 p-5 has-[>svg]:px-5 whitespace-normal text-left" data-login-channel="wechat-qr"><QrCode className="size-[22px]" aria-hidden="true" /><span><strong>微信扫码</strong><span>手机微信授权，选择游戏角色</span></span></Button>
          <Button type="button" variant="outline" className="account-channel h-auto pointer-coarse:h-auto items-start justify-start gap-3.5 p-5 has-[>svg]:px-5 whitespace-normal text-left" data-login-channel="alipay"><QrCode className="size-[22px]" aria-hidden="true" /><span><strong>支付宝</strong><span>扫码登录，选择游戏角色</span></span></Button>
          <Button type="button" variant="outline" className="account-channel h-auto pointer-coarse:h-auto items-start justify-start gap-3.5 p-5 has-[>svg]:px-5 whitespace-normal text-left" data-login-channel="phone"><Smartphone className="size-[22px]" aria-hidden="true" /><span><strong>益世界 APP</strong><span>账号密码或短信验证码</span></span></Button>
          <Button type="button" variant="outline" className="account-channel h-auto pointer-coarse:h-auto items-start justify-start gap-3.5 p-5 has-[>svg]:px-5 whitespace-normal text-left" data-login-channel="wechat"><MessageCircle className="size-[22px]" aria-hidden="true" /><span><strong>微信小游戏</strong><span>从电脑微信读取登录信息</span></span></Button>
          <Button type="button" variant="outline" className="account-channel h-auto pointer-coarse:h-auto items-start justify-start gap-3.5 p-5 has-[>svg]:px-5 whitespace-normal text-left" data-login-channel="douyin"><Music2 className="size-[22px]" aria-hidden="true" /><span><strong>电脑抖音采集</strong><span>从电脑抖音读取登录信息</span></span></Button>
        </div>
        <section id="account-add-alipay" hidden>
          <div id="alipay-flow" className="alipay-flow">
            <div className="bar"><Button id="alipay-start" type="button">生成二维码</Button><Button id="alipay-cancel" type="button" variant="outline" hidden>取消</Button></div>
            <img id="alipay-qr" className="alipay-qr" alt="支付宝扫码登录二维码" width="256" height="256" hidden />
            <p id="alipay-hint" className="phone-feedback dim" role="status" aria-live="polite" aria-atomic="true">点击「生成二维码」，然后使用支付宝扫一扫。</p>
            <div id="alipay-roles" hidden />
            <p id="alipay-result" hidden />
            <p id="alipay-expiry" className="dim" />
            <div className="bar"><Button id="alipay-save" type="button" hidden disabled>保存所选角色</Button><Button id="alipay-roles-retry" type="button" variant="outline" hidden>重新读取角色</Button></div>
          </div>
          <p className="dim">本机需安装 Edge 或 Chrome。扫码后会进入游戏，可能让同账号的游戏客户端下线。</p>
        </section>
        <section id="account-add-wechat" hidden>
          <div id="wechat-flow" className="wechat-flow">
            <div className="bar"><Button id="wechat-start" type="button">生成二维码</Button><Button id="wechat-cancel" type="button" variant="outline" hidden>取消</Button></div>
            <img id="wechat-qr" className="wechat-qr" alt="微信扫码登录二维码" width="256" height="256" hidden />
            <p id="wechat-hint" className="phone-feedback dim" role="status" aria-live="polite" aria-atomic="true">点击「生成二维码」，然后使用微信扫一扫。</p>
            <div id="wechat-roles" hidden />
            <p id="wechat-result" hidden />
            <p id="wechat-expiry" className="dim" />
            <div className="bar"><Button id="wechat-save" type="button" hidden disabled>保存所选角色</Button><Button id="wechat-roles-retry" type="button" variant="outline" hidden>重新读取角色</Button></div>
          </div>
          <p className="dim">读取角色会登录游戏，可能让同账号的游戏客户端下线。</p>
        </section>
        <section id="account-add-phone" hidden>
          <p id="phone-step" className="sr-only" role="status">登录验证 → 选择区服和角色 → 保存并切换</p>
          <div className="phone-layout">
            <div id="phone-flow">
              <div id="phone-entry">
                <div className="config-subtabs phone-tabs" role="tablist" aria-label="APP 登录方式">
                  <button type="button" id="phone-password-tab" role="tab" aria-selected="true" aria-controls="phone-password-panel">账号密码</button>
                  <button type="button" id="phone-sms-tab" role="tab" aria-selected="false" aria-controls="phone-sms-panel" tabIndex={-1}>短信验证码</button>
                </div>
                <form id="phone-password-panel" className="phone-form" role="tabpanel" aria-labelledby="phone-password-tab" noValidate>
                  <div className="choice-field"><label htmlFor="phone-account">APP 账号或绑定手机号</label><Input id="phone-account" name="username" placeholder="输入益世界账号或手机号" autoComplete="username" aria-describedby="phone-hint" /></div>
                  <div className="choice-field"><label htmlFor="phone-password">APP 登录密码</label><div className="phone-input-action"><Input id="phone-password" name="password" type="password" placeholder="输入 APP 的登录密码" autoComplete="current-password" aria-describedby="phone-password-help phone-hint" /><Button id="phone-password-toggle" type="button" variant="outline" aria-label="显示密码" aria-pressed="false">显示</Button></div><p id="phone-password-help" className="dim">忘记密码可切换短信验证码，或在游戏 APP 中找回。</p></div>
                  <Button id="phone-login" type="submit">登录并读取角色</Button>
                </form>
                <form id="phone-sms-panel" className="phone-form" role="tabpanel" aria-labelledby="phone-sms-tab" noValidate hidden>
                  <div className="choice-field"><label htmlFor="phone-number">APP 绑定手机号</label><Input id="phone-number" name="tel" type="tel" placeholder="输入 11 位大陆手机号" inputMode="tel" autoComplete="tel-national" aria-describedby="phone-sms-help phone-hint" /></div>
                  <div className="choice-field"><label htmlFor="phone-code">短信验证码</label><div className="phone-input-action"><Input id="phone-code" name="code" placeholder="输入收到的验证码" inputMode="numeric" autoComplete="one-time-code" aria-describedby="phone-sms-help phone-hint" /><Button id="phone-send-code" type="button" variant="outline">获取验证码</Button></div><p id="phone-sms-help" className="dim">先获取验证码，再填写短信中的验证码登录。</p></div>
                  <Button id="phone-sms-login" type="submit">验证并读取角色</Button>
                </form>
              </div>
              <p id="phone-hint" className="phone-feedback" role="status" aria-live="polite" aria-atomic="true" />
              <section id="phone-preview" aria-labelledby="phone-preview-title" hidden>
                <h3 id="phone-preview-title" tabIndex={-1}>选择区服和游戏角色</h3>
                <div id="phone-result" />
                <p id="phone-selection" className="dim" role="status">请选择要使用的角色。</p>
                <p id="phone-expiry" className="dim" />
                <div className="bar"><Button id="phone-save" type="button" disabled>保存所选角色</Button><Button id="phone-roles-retry" type="button" variant="outline" hidden>重试读取失败的账号</Button><Button id="phone-back" type="button" variant="outline">返回修改</Button></div>
              </section>
              <section id="phone-success" aria-labelledby="phone-success-title" hidden>
                <h3 id="phone-success-title" tabIndex={-1}>账号已保存</h3>
                <p id="phone-saved-account" />
                <p id="phone-success-next" className="dim">账号已保存，尚未开始挂机。可先在「挂机配置」设置任务，再点击账号卡片或页头的「开始挂机」。</p>
                <Button id="phone-add-another" type="button" variant="outline">添加其他 APP 账号</Button>
              </section>
            </div>
            <aside className="phone-help" aria-label="APP 登录准备">
              <p id="phone-device-status" className="dim" role="status">正在检查本机设备档案…</p>
              <details id="phone-device-details">
                <summary>高级选项 · 导入设备档案</summary>
                <p className="dim">已有 APP 设备档案可在此导入，用于兼容性排查。</p>
                <p className="dim">档案需包含 di 和 deviceCode，oi 可自动补全。保存后会在后续登录中复用。</p>
                <div className="choice-field"><label htmlFor="phone-device-file">导入设备档案 JSON</label><Input id="phone-device-file" type="file" accept=".json,application/json" /></div>
                <p id="phone-device-path" className="dim" />
                <Button id="phone-device-refresh" type="button" variant="outline" size="sm">重新检查</Button>
              </details>
              <p id="phone-device-hint" className="phone-feedback" role="status" aria-live="polite" />
              <p className="dim">密码和验证码仅用于本次验证。读取角色时会登录游戏，可能让同账号的游戏客户端下线。</p>
            </aside>
          </div>
        </section>
        <section id="account-add-capture" hidden>
          <div className="bar"><Button id="cap-start" type="button" hidden>开始读取微信账号</Button><Button id="cap-douyin" type="button" hidden>开始读取抖音账号</Button><Button id="cap-stop" type="button" variant="outline" hidden>停止读取</Button><Button id="cap-recover" type="button" variant="outline" hidden>恢复上次采集残留</Button></div>
          <p id="cap-hint" className="phone-feedback" role="status" aria-live="polite" />
          <div id="cap-box" />
        </section>
      </div>
      <DialogFooter className="account-add-footer"><Button id="account-add-done" type="button" hidden>完成</Button><Button id="account-add-back" type="button" variant="outline" hidden>返回</Button></DialogFooter>
    </dialog>
  </div>)
}

// Client-rendered page; its bundle is loaded when the tab is first opened.

export function guildPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Card>
      <CardHeader>
        <CardTitle>联盟求助</CardTitle>
        <CardAction className="row-span-1 self-center"><Button id="guild-refresh" variant="outline" size="sm">刷新求助</Button></CardAction>
      </CardHeader>
      <CardContent><div id="guild-aid-view" className="progression-view" /></CardContent>
    </Card>
    <Card className="gap-3 max-md:gap-3">
      <CardHeader>
        <CardTitle className="title-with-help">联盟科技<HelpTip title="联盟科技">等级上限随赛季阶段开放。选择一项科技可设置目标等级，确认费用后逐级升级。</HelpTip></CardTitle>
        <CardAction className="row-span-1 self-center"><Button id="guild-tech-refresh" variant="outline" size="sm">刷新科技</Button></CardAction>
      </CardHeader>
      <CardContent><div id="guild-tech-view" aria-live="polite" /></CardContent>
    </Card>
  </div>)
}
