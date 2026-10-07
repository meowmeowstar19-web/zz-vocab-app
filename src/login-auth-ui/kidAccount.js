// 13岁以下账号的状态与网络（docs/kids-account-plan.md），两仓逐字节同步。
//
//  - 设备年龄：登录前问一次出生年月，只把「是否13岁以下」写进设备级 localStorage
//    （不分 scope、不存生日），之后这台设备不再问、不能改。存不进去（隐私模式）
//    就只在内存里锁到本次页面关闭。
//  - 用户名账号 = Supabase 邮箱+密码账号，邮箱是 theme.js 的内部假地址。注册走
//    Edge Function（服务端建已验证账号 + app_metadata.kid），登录直接
//    signInWithPassword —— SIGNED_IN 由 core 自己的监听接住，走 enterAccount →
//    onUpgrade，游客存档照常并入；core 一行不改。
//  - 「请家长帮忙」：往 parent_help_requests 插一行（匿名只能插、不能读）。
import { useSyncExternalStore } from 'react'
import { authClient, useAuth } from '../authSetup.js'
import { AGE_KEY, KID_EMAIL_DOMAIN, KID_SIGNUP_FUNCTION, PARENT_HELP_TABLE } from './theme.js'
import { isKidUser, isUnder13, kidEmailOf, normalizeUsername } from './kidRules.js'

/* ------------------------------------------------------------ device age */
const BANDS = ['under13', '13plus']
let memo = null // 存不进 localStorage 时，答案也要锁住本次页面
const listeners = new Set()

export function readAgeBand() {
  if (memo) return memo
  try {
    const v = localStorage.getItem(AGE_KEY)
    return BANDS.includes(v) ? v : null
  } catch {
    return null
  }
}

// 只在还没答过时生效（设备级锁定：答过就不能改）
export function answerAge(age) {
  const prior = readAgeBand()
  if (prior) return prior
  const band = isUnder13(age) ? 'under13' : '13plus'
  memo = band
  try { localStorage.setItem(AGE_KEY, band) } catch { /* 隐私模式：内存锁兜底 */ }
  listeners.forEach((l) => l())
  return band
}

const subscribe = (cb) => {
  listeners.add(cb)
  // 别的标签页答了，这边也跟上
  const onStorage = (e) => { if (e.key === AGE_KEY) cb() }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

// null = 还没问过；'under13' | '13plus'
export const useAgeBand = () => useSyncExternalStore(subscribe, readAgeBand, () => null)

// 这个玩家要不要按儿童对待：有账号看账号的 app_metadata.kid（服务端写、客户端
// 改不了）；没账号（游客 / 开机窗口）看本设备的年龄答案。
export function useIsKid() {
  const auth = useAuth()
  const band = useAgeBand()
  if (auth.user) return isKidUser(auth.user)
  return band === 'under13'
}

/* ---------------------------------------------------------------- network */
const kidError = (code) => Object.assign(new Error(code), { code })

// 函数回非 2xx 时 supabase-js 给的是 FunctionsHttpError，错误码在响应体里
async function functionErrorCode(error) {
  try {
    const body = await error?.context?.json?.()
    if (body?.error) return body.error
  } catch { /* 读不到响应体 → 按通用失败 */ }
  return error?.context?.status === 429 ? 'rate_limited' : 'failed'
}

export async function kidSignIn(username, password) {
  const { error } = await authClient.auth.signInWithPassword({
    email: kidEmailOf(username, KID_EMAIL_DOMAIN),
    password,
  })
  if (!error) return
  if (error.status === 429 || /rate limit/i.test(error.message || '')) throw kidError('rate_limited')
  if (/invalid login credentials|invalid_credentials/i.test(`${error.code} ${error.message}`)) throw kidError('wrong_login')
  throw kidError('failed')
}

// 注册成功后直接登录（服务端建的是已验证账号，不发验证信）
export async function kidSignUp(username, password) {
  const { data, error } = await authClient.functions.invoke(KID_SIGNUP_FUNCTION, {
    body: { username: normalizeUsername(username), password },
  })
  const code = error ? await functionErrorCode(error) : data?.ok ? null : data?.error || 'failed'
  if (code) throw kidError(code)
  await kidSignIn(username, password)
}

export async function sendParentHelp({ username, parentEmail, message }) {
  const { error } = await authClient.from(PARENT_HELP_TABLE).insert({
    username: normalizeUsername(username),
    parent_email: String(parentEmail ?? '').trim(),
    message: String(message ?? '').trim() || null,
  })
  if (!error) return
  throw kidError(/rate_limited/.test(error.message || '') ? 'rate_limited' : 'failed')
}
