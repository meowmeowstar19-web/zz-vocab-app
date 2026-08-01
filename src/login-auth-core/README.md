# login-auth-core — 无头账号内核（跨 app 通用）

第一对可移植件（配套 UI 在 `login-auth-ui/`）。纪律与 general-ui 相同：
**本目录 12 个文件（含测试）两仓逐字节整文件拷，一个 app 名都不出现**；
所有 app 专属内容住在宿主的 `authSetup.js`（唯一接线文件，每 app 一份）。
同步检查：`npm run check:sync`（tools/check-portable-sync.mjs）。

## 模块内文件

| 文件 | 内容 |
| --- | --- |
| `store.js` | 引擎：四态 loading/guest/account/authenticating、单一登录门（signInWithOtp shouldCreateUser + OAuth）、onUpgrade 串行队列、authEpoch、watchdog、notice（account-created / welcome-back / session-expired） |
| `useAuth.js` | `createUseAuth(core)` React 绑定（useSyncExternalStore）；数据跟 `isAccountScope` 走，令牌跟 `isRealAccount` 走 |
| `snapshot.js` | 唯一持久化快照 `auth.snapshot.v1`（hadAccount / explicitLogout / lastUserScope / flow，读时清过期 flow） |
| `scope.js` | scoped storage 原语：`<scope>.<name>` 键、setScope/loadScoped/saveScoped/clearScope。**不含任何合并逻辑** |
| `identity.js` | `createIdentity({nameKey, nameCacheKey, avatarCacheKey})` 工厂 → displayNameOf/cacheIdentity/cachedAvatarOf（boot 窗口不闪 Guest）；`oauthAvatarOf` 纯函数 |
| `sessionMirror.js` | iOS 加主屏幕登录交接：la_rt/la_at 镜像 cookie + clone-session 换发（verdict 三分：OK/REJECTED/UNAVAILABLE），失败**绝不回退轮换**（除非显式 `allowRefreshFallback`） |
| `index.js` | 公共 API barrel |

## 宿主 app 必须自己拥有的（每 app 一份）

1. **`src/authSetup.js`** —— 接线点，做四件事：
   - `createAuthCore({ client, onUpgrade })`：client 是 app 的 supabase 实例；
     **onUpgrade 是唯一数据桥**，必须守六契约（空游客跳过 / 服务器判空 /
     判定钉死在被进入的账号 / 非空账号一分不动 / 全部落地才清 guest /
     幂等可重放；不确定一律 throw 让内核择机重试）。
   - **种子清单（合并 manifest）**：哪些 key 在注册时从 guest 搬进新账号、
     怎么合并，是 app 的产品决策 —— Muku Fuku 在 `src/data/guestSeed.js`
     （声明式表 + 覆盖断言），PlushieWord 在 `src/utils/progressSync.js`。
     **新增持久化玩家资产 key 必须同时进清单**，否则注册静默丢档
     （2026-07-31 补签券事故）。
   - `createIdentity({...})` 绑定 app 自己的 name/头像缓存 key 并 re-export
     （⚠️ 存量用户的数据就在这些 key 下面，永不改值）。
   - `attachSessionMirror(client, undefined, { cloneEndpoint, cloneApiKey })`：
     同源代理路径 + anon key。**rotation 开着的项目严禁传
     `allowRefreshFallback: true`**（回退轮换会连坐吊销全家 token —— 两容器
     隔天一起掉线的事故根源）。
2. **`login-auth-ui/theme.js`** —— UI 换皮（资产/字体/法务/文案表）。
3. **clone-session Edge Function** 及部署 —— 见 `docs/pwa-kit.md`
   （不走 git 自动部署，anon key 非 JWT 的项目必须 `--no-verify-jwt`）。

## app 侧消费规则

- 组件只从 `authSetup.js` 拿 `useAuth` 和 identity 助手，**绝不直接 import
  内核实例化产物**（`loadScoped`/`saveScoped`/`readMirror` 这类无状态原语
  可以直接从 `login-auth-core/index.js` 拿）。
- 自动弹出类 UI（签到日历等）要防"交接窗口误判"：guest 挂载 + `readMirror`
  镜像 cookie 还在 → 本次别弹（换发在飞，~1s 后整树按账号重挂）。
