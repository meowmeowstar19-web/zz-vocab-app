# 13岁以下账号（PW 移植说明）

> 方案真源 = `~/Desktop/miracleZZ/webapp/docs/kids-account-plan.md`（Muku Fuku 先做、10-06 上线）。
> 这里只记 PlushieWord 跟 ZZ 不一样的地方。代码 10-07 移植完。

## 文件

- `src/login-auth-ui/{AgePrompt.jsx, KidLoginPage.jsx, kidAccount.js, kidRules.js(+test)}` +
  `WelcomePage / LoginPromptModal / EmailLoginPage / index.js`：从 ZZ **逐字节**拷，`npm run check:sync` 在盯，
  别在这边手改。
- `src/login-auth-ui/theme.js`（PW 换皮）：三语文案（en 跟 ZZ 一字不差；zh/ja 提示「用字母/数字/_」，
  因为用户名不收中文）、`KID_EMAIL_DOMAIN = 'kids.plushieword.invalid'`、`AGE_KEY`。
- `src/authSetup.js`：导出 `authClient`（kidAccount 用）+ `currentAuthUser`（main.jsx 用）。
- `supabase/functions/kid-signup/`：`index.ts` 逐字节、`config.ts` 是 PW 的域名。
  **部署 `npm run deploy:kid-signup`**（已带 `--no-verify-jwt`：PW 的 anon key 是 sb_publishable_，不是 JWT）。
- `supabase/migrations/20261007120000_kid_accounts.sql`：ZZ 两份迁移合成一份。
  ⚠️ PW 远端的迁移记录不全（0508 / 0529 两份没记），**别用 `supabase db push`**（会重跑老迁移）。
  应用方式：`supabase db query --linked -f <文件>` 然后
  `supabase migration repair --status applied 20261007120000 --linked`。

## 跟 ZZ 不一样的

| | PW |
|---|---|
| 假邮箱域名 | `kids.plushieword.invalid`（theme.js / config.ts / 迁移里三处函数，四处一致） |
| 「用过」（36 个月清理） | 建号 / 登录 / 会话刷新 / `user_progress.updated_at` / `daily_activity.last_ts` 取最晚 |
| 清理时连带删 | `user_progress`、`feedback` 走外键级联；`daily_activity`、`account_flags` 没外键，purge 里手动删 |
| cron | `purge-inactive-kid-accounts` 每周日 04:41 UTC |
| 儿童号隐藏 | Settings 的「意见反馈」（`useIsKid`） |
| PostHog | 儿童号不 identify、不 setPersonProperties、不录屏；设备上次被 13+ 账号 identify 过 → `reset()` 换新匿名 id（App.jsx + main.jsx） |
| 名字 | Settings 顶上显示的是邮箱前缀 = 用户名（孩子自己起的昵称，只给自己看；找回密码要靠它，所以留着） |
| 家长求助处理 | 跟 ZZ 共用 Muku Fuku 中台「家长求助」页，顶上切 PlushieWord（ZZ `tools/kid-help-admin.mjs`，PW 的 key 读 `VocabWorkspace/.env.local`） |
| 核对家长 | 让家长说大概哪天注册的、孩子最近学了 / 自己加了哪些词（中台会列出来） |

隐私政策 §8 / 服务条款 §3 §4 §14 10-07 已同步改。
