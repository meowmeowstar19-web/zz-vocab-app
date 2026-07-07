# Auth 状态机迁移(branch: auth-machine)

miracleZZ 的 auth 核心搬入 PW。**只搬逻辑,UI 全部保留 PW 原有组件,只换内脏。**

## 纪律:两边逐字节一致的文件

`src/auth/machine.js` `machine.test.js` `storage.js` `storage.test.js` `useAuth.js`
与 miracleZZ `webapp/src/auth/` 同名文件必须保持 **byte-identical**(useAuth 靠
`src/auth/supabase.js` shim 适配 import 路径)。任何一边修 bug → 直接整文件拷到另一边。

PW 特有(不同步):`scopedStorage.js`(用 progressSync 的合并语义实现 mergeScopes)、
`legacyFlags.js`(旧 flag → auth.snapshot.v1 一次性迁移)、`supabase.js` shim。

## 架构映射

- 13 个散落 flag(app_logged_in/out、bind_flow_active、*_oauth_pending、
  intentional_signout、app_email_auth_pending…)→ 全删,由 `auth.snapshot.v1` + 机器状态取代。
- App.jsx 的 session/authReady/anonAttemptFailed/gateTimedOut/isGuest/scopeFinalized
  → `useAuth()` 的 status/ready/userScope/isRealAccount。
- 占位屏:`!auth.ready`(机器内置 4s watchdog,替代 GATE_MAX_WAIT_MS)。
- WelcomePage:`status===LOGGED_OUT`(+ BINDING surface='welcome' 回程、OTP 回退到 LOGGED_OUT)。
- 登录弹窗 pending/error → 机器 BINDING 状态 + bindError;App 的 reducer 只管
  open/surface/emailMode(纯 UI 关注点)。
- syncOnLogin:砍掉 bind 拒绝机器(bind_flow_active/cloudHasProgress/clearScope/
  app_anon_scope)。bind 保持 uid(linkIdentity/updateUser),"绑到已有账号"由 GoTrue
  identity_already_exists 错误覆盖;游客登录已有账号 → 机器 mergeScopes 先做本地折叠,
  syncOnLogin 永远只操作 u_<uid> 自己的槽位。
- Email 登录不再 signOut 匿名 session(2.x SDK /otp 不看 session,miracleZZ 已验证),
  app_email_auth_pending/app_anon_data_to_migrate 的整套舞蹈作废。

## 行为语义(用户 2026-07-07 确认)

1. **Sign up(bind)到已被占用的邮箱/Google = 拒绝**——结果与旧版一致,机制换了:
   GoTrue 的 identity_already_exists / already-registered 错误 → 弹窗错误面板,
   不再靠"查云端有没有进度"。
2. **Sign in 已有账号 = 原样进入该账号,绝不合并游客数据**(两个 app 完全一致——
   machine 的 enterAuthed 已不发任何登录合并;游客槽位原地留存,与账号无关)。
   唯一存在的 mergeScopes 是 reason='remint':同一游客的匿名 session 技术性死亡后
   重铸新号时继承自己的数据(防丢档,与账号切换无关)。scopedStorage 里的
   `if (reason === 'login') return` 只是防机器回归的保险。
3. **登出后 Guest Mode = 全新存档**(GUEST_CHOSEN 铸新 uid,不继承旧 anon 数据)——
   与旧 PW 正常路径一致,防止已登出账号数据泄进下一个游客。
4. 旧设备 `app_logged_out=1`(含 token 过期误设的)迁移后一次性落 WelcomePage。
5. posthog `bind_account_success` 事件点位取消(原挂在 runSyncOrReject);
   `lang_onboarded_<uid>` 不再写(原本 write-only)。
6. session 意外过期:机器发 notify('session-expired'),PW 暂不渲染横幅(与旧版一致)。

## 上线闸门

分支不合 main。等 miracleZZ 全量测试通过 → 同步核心文件 diff → 手测四流程
(游客→绑定 / 游客→登录合并 / OTP 退出恢复 / OAuth 往返+拒绝)→ 合并。
