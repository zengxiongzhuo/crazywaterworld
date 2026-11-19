import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LockKeyhole, Ship } from "lucide-react"
import { Button } from "./button"
import { Card, CardContent, CardHeader, CardTitle } from "./card"
import { Input } from "./input"

export function consoleLogin() {
  return renderToStaticMarkup(<main className="console-login font-sans">
    <div className="console-login-wrap">
      <div className="console-login-brand"><Ship aria-hidden="true" /><span>疯狂水世界 · 航行控制台</span></div>
      <Card>
        <CardHeader className="gap-3">
          <div className="console-login-icon"><LockKeyhole aria-hidden="true" /></div>
          <CardTitle className="text-xl">登录控制台</CardTitle>
          <p className="text-sm text-muted-foreground">请输入访问密码，继续管理账号与挂机任务。</p>
        </CardHeader>
        <CardContent>
          <form id="console-login-form" className="grid gap-4">
            <div className="grid gap-2">
              <label htmlFor="console-password" className="text-sm font-medium">访问密码</label>
              <Input id="console-password" className="w-full" name="password" type="password" autoComplete="current-password" autoFocus required maxLength={128} placeholder="输入控制台密码" aria-describedby="console-login-error" />
            </div>
            <p id="console-login-error" className="text-sm text-destructive" role="alert" hidden />
            <Button id="console-login-submit" type="submit" className="w-full">进入控制台</Button>
          </form>
        </CardContent>
      </Card>
      <p className="console-login-note">登录后 12 小时内无需重复输入密码。</p>
    </div>
  </main>)
}
