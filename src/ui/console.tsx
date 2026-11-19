import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "./card"
import { Input } from "./input"
import { HelpTip } from "./help-tip"

export function action(id: string, label: string, variant: React.ComponentProps<typeof Button>["variant"] = "outline", disabled = false) {
  return renderToStaticMarkup(<Button id={id} variant={variant} disabled={disabled}>{label}</Button>)
}

export function stagePanel() {
  return renderToStaticMarkup(
    <div className="grid gap-3">
    <Card>
      <CardHeader>
        <CardTitle className="title-with-help">主线 / 闯关<HelpTip title="主线 / 闯关">点击开始后连续挑战，每场间隔5秒，同一关连续战败达到本页设置后停止，通关清零。这里的手动参数独立于挂机配置，不会开启每轮挂机。</HelpTip><span id="stage-view" className="heading-status" role="status" aria-live="polite">未同步</span></CardTitle>
      </CardHeader>
      <CardContent>
        <div className="bar">
          <div id="stage-lineup-control" className="bar"><span>挑战阵容</span></div>
          <label htmlFor="stage-failures">失败停止次数</label>
          <Input id="stage-failures" aria-label="主线手动挑战失败停止次数" className="w-20" type="number" min="1" defaultValue="3" />
          <Button id="stage-start" disabled>开始连续挑战</Button>
          <Button id="stage-stop" variant="outline" disabled>停止挑战</Button>
        </div>

      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle className="title-with-help">试炼副本<HelpTip title="试炼副本">“挑战一次”只挑战下一关；“开始连续挑战”由你手动开始，达到本页设置的失败停止次数后停止。手动参数与挂机配置独立，扫荡次数另计。</HelpTip></CardTitle><CardAction className="row-span-1 self-center"><Button id="trial-refresh" variant="outline" size="sm">刷新试炼进度</Button></CardAction></CardHeader>
      <CardContent>
        <div id="trial-view" className="progression-view" aria-live="polite" />
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle>海盗首杀手动推进</CardTitle></CardHeader><CardContent>
      <p className="dim">手动开始本次连续推进，达到失败停止次数或条件不足时停止；不会开启挂机自动讨伐。舰队和目标沿用海盗配置，汽油按实际库存检查。</p>
      <div className="bar"><a href="#config-group-pirate-hunt">设置舰队与目标</a><label htmlFor="pirate-manual-failures">失败停止次数</label><Input id="pirate-manual-failures" aria-label="海盗手动推进失败停止次数" className="w-20" type="number" min="1" max="100" defaultValue="1" /><Button id="pirate-advance-start" disabled>开始首杀推进</Button><Button id="pirate-advance-stop" variant="outline" disabled>停止首杀推进</Button></div>
      <p id="pirate-advance-state" role="status">尚未开启</p>
    </CardContent></Card>
    </div>
  )
}
export * from "./layout"
export * from "./pages"
export * from "./console-login"
export * from "./settings"
