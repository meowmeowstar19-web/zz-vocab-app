// 13岁以下账号的纯规则（docs/kids-account-plan.md）—— 无 React、无网络、无存储，
// 两仓逐字节同步。服务端 supabase/functions/kid-signup/index.ts 有一份同样的
// 用户名规则（Deno 拿不到这个文件）：改这里必须同步改那边，错误码也要对得上。

// 用户名：3–16 位字母 / 数字 / 下划线，不区分大小写（一律存小写）。
export const USERNAME_MIN = 3
export const USERNAME_MAX = 16
// 沿用 supabase/config.toml 的 minimum_password_length；72 = bcrypt 上限。
export const PASSWORD_MIN = 6
export const PASSWORD_MAX = 72

export const normalizeUsername = (raw) => String(raw ?? '').trim().toLowerCase()

// 返回错误码（null = 合格）。顺序有讲究：先拦「像邮箱 / 像电话」——这两种
// 是在收集个人信息，提示要说清楚为什么，不能只报「格式不对」。
export function usernameProblem(raw) {
  const u = normalizeUsername(raw)
  if (!u) return 'username_empty'
  if (u.includes('@')) return 'username_at'
  if (/\d{7,}/.test(u)) return 'username_digits'
  if (u.length < USERNAME_MIN || u.length > USERNAME_MAX) return 'username_length'
  if (!/^[a-z0-9_]+$/.test(u)) return 'username_chars'
  return null
}

export function passwordProblem(pw) {
  const p = String(pw ?? '')
  if (p.length < PASSWORD_MIN) return 'password_short'
  if (p.length > PASSWORD_MAX) return 'password_long'
  return null
}

// 用户名 → 内部假邮箱。玩家永远看不到这一层；域名用保留顶级域 .invalid，
// 永远发不出信（每个 app 的域名在 theme.js 里）。
export const kidEmailOf = (username, domain) => `${normalizeUsername(username)}@${domain}`

// 只问年龄（周岁），不问生日。拿不到数字一律按孩子算。
export function isUnder13(age) {
  const n = Number(age)
  return !Number.isFinite(n) || n < 13
}

// 儿童号以服务端写的 app_metadata 为准（只有 service role 能写，客户端改不了）。
export const isKidUser = (user) => user?.app_metadata?.kid === true
