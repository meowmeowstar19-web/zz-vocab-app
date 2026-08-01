# pwa-kit — Add to Home Screen 全链装配清单（跨 app 通用）

「加到主屏幕」不是一个文件，是一条链：安装引导 → 安装检测 → 加桌那一刻的
**登录交接**（iOS 只拷 cookie，localStorage 不拷）→ 交接的服务端 → 可安装性
基建（manifest/SW/标签）→ 出问题时的可观测性（?diag=1）。这些件因为平台原因
必须散在各自的位置（public/ 要在根、Edge Function 按路径部署、index.html 是
入口），**所以 kit 的形态是"一份契约 + 每件收成 config 区/逐字节区"**，不是
一个目录。本文档两仓各留一份（逐字节同拷）；漂移检查：`npm run check:sync`。

## 件清单

| # | 件 | 位置 | 同步纪律 |
| --- | --- | --- | --- |
| 1 | 安装机械层（prompt 停靠协议 / `usePwaInstalled` / `waitForInstallPrompt` / `useInstallPromptReady`） | `src/general-ui/installPrompt.js` | **逐字节拷** |
| 2 | 安装引导弹窗 | ZZ：`general-ui/useInstallPrompt.jsx` + `InstallPill.jsx`；PW：`src/hooks/useInstallPrompt.jsx` | **app 自有件**——各 app 的引导是各自拍板的产品设计（ZZ=英文双浏览器同屏；PW=按语言挑一个浏览器+埋点），永不强行统一；文案/截图走各自 config |
| 3 | 登录交接（客户端） | `src/login-auth-core/sessionMirror.js` | **逐字节拷**（属于 login-auth-core 的 12 文件集） |
| 4 | 登录交接（服务端） | `supabase/functions/clone-session/` | `index.ts` **逐字节拷**；`config.ts`（origins 白名单）每 app 一份 |
| 5 | boot 层 | `public/boot.js` | `APP CONFIG` 块每 app 一份；`PORTABLE BODY` 以下**逐字节拷** |
| 6 | 可安装性基建 | `public/*.webmanifest` / `public/sw.js` / `index.html` 标签 | **app 自有件**（见下方必备项清单）|
| 7 | 同源代理 | `vercel.json` 的 `/api/clone-session` rewrite | 每 app 一份（指向各自 project-ref） |

## 新 app 接入步骤

1. **manifest**（app 自有，必备字段）：`id`、`name/short_name`、
   `start_url: "/?source=pwa"`、`display: "standalone"`、192/512 icons、
   `related_applications: [{platform:"webapp", url:"<线上 manifest 绝对址>", id:"<同 id>"}]`
   （没有它 `getInstalledRelatedApps` 探不到已装态）。
2. **sw.js**（app 自有）：存在 + 有 fetch handler 即满足可安装性。缓存策略随
   app 自定（ZZ 是故意的 5 行零缓存；PW 是 300 行精调 LRU——都别动对方的）。
   ⚠️ SW 必须 bypass `/boot.js`（boot 层要永远新鲜）。
3. **index.html 标签组**：`apple-touch-icon`、`<link rel="manifest">`、
   `apple-mobile-web-app-capable/-title`、`theme-color`，外加
   `<script src="/boot.js"></script>`（必须先于 app module）。
4. **boot.js**：拷 PORTABLE BODY，填自己的 APP CONFIG。新 app 的
   `purgeToken` 一律 **null（不上膛）**——它是一次性全设备清库开关，
   只在需要时才填值。`devPorts` 填非 5173 的 dev 端口。
5. **clone-session**：拷 `index.ts`，写自己的 `config.ts`（origins 含线上域 +
   www + 历史域 + localhost dev 端口）。部署（见下）。
6. **vercel.json**：加 rewrite
   `/api/clone-session → https://<project-ref>.supabase.co/functions/v1/clone-session`，
   并给 `/boot.js` 和 manifest 配 `no-store`。
7. **authSetup 接线**：`attachSessionMirror(client, undefined, { cloneEndpoint:
   '/api/clone-session', cloneApiKey: <anon key> })`。
   **rotation 开着的项目严禁 `allowRefreshFallback: true`**。
8. **安装 UI**：拷 `general-ui/installPrompt.js`，引导弹窗自己设计（或起步先
   拷一个 app 的改文案）。

## 部署（Edge Function 不走 git 自动部署！）

```bash
# anon key 是 JWT 的项目（如 miracleZZ）
supabase functions deploy clone-session --project-ref <ref> --use-api
# anon key 是 sb_publishable_ 的项目（如 PW）必须关网关 JWT 门：
supabase functions deploy clone-session --project-ref <ref> --no-verify-jwt --use-api
```

各仓 `npm run deploy:functions` 已把正确参数钉死。**换域名/改 origins 后必须
重跑**——2026-07-24 就是改了域名没重部署，CORS 静默失败四天，回退轮换把两个
容器的登录全吊销了。

部署后验证三连（把 `<fn-url>` 换成 `https://<ref>.supabase.co/functions/v1/clone-session`）：

```bash
curl -s -X OPTIONS <fn-url> -H "Origin: <线上域>" -D- -o /dev/null | grep -i access-control-allow-origin
curl -s -X POST <fn-url> -H "Content-Type: application/json" -d '{}'                      # → {"error":"no_token"}
curl -s -X POST <fn-url> -H "Content-Type: application/json" -d '{"access_token":"x"}'    # → {"error":"unauthorized"}
```

（verify_jwt 开着的项目，POST 两条要额外带
`-H "Authorization: Bearer <anon key>" -H "apikey: <anon key>"`。）

## 上线后怎么看它活没活

- 手机上开 `<域名>/?diag=1`：`PWA handoff` 行是 sessionMirror 的上一次交接
  留痕（`clone ok` / `clone rejected` / `clone UNREACHABLE …`），
  `display-mode` 行区分主屏图标还是浏览器标签。交接路上所有失败都被故意
  吞掉（坏了也不能坏 app），**这个面板是唯一的可见处**。
- 症状指纹：**两个容器同时掉登录 = 服务端 token 家族被吊销**（十有八九是
  谁又走了轮换回退），本地存储被清只会掉一个。

## 真机验收（自动化不了的部分）

加桌前先在浏览器里保持登录态开一次网站（让新代码盖 la_rt/la_at 章）→ 删旧
图标重加 → 从图标打开应在 ~1s 内自动进账号 → 隔天再开一次验登录保持，
且浏览器本体的登录同样健在（无连坐）。Safari 和 Chrome 各测一遍（实测
iOS 18.7 两者加桌都拷 cookie）。

## 已知边界（拍板过的，别"顺手修"）

- PWA 礼包的 gate 是纯客户端（`?pwa=1` 在生产是活的）——服务器原理上验证
  不了"加没加到主屏幕"，已接受，**别去加服务端门**。
- 已装的老图标不受益于交接（拷贝只发生在添加那一刻）；7 天没开过网站再去
  添加 = 摆渡 cookie 已过期，PWA 里重登一次即可（最坏情况=旧常态）。
- 自动弹出类 UI 要防交接窗口误判：guest 挂载 + `readMirror()` 镜像 cookie
  还在 → 本次不弹（换发在飞，~1s 后整树按账号重挂）。
