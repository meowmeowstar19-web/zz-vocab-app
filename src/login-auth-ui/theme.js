// login-auth-ui theme — PW's reskin file (蓝图 §1: 下个 app 换层皮即可用).
// This is the ONLY file in login-auth-ui that differs from miracleZZ: assets
// resolve through PW's R2/CDN helper, the font is PW's Nunito stack, the legal
// docs are PW's own, and STRINGS localizes per the device's native language
// (app_native, with a browser-language guess for first-time visitors — same
// rule the rest of PW uses). Component files stay byte-identical across apps.
import { getFigmaAssetUrl } from '../utils/assetUrl'

export const TOS_URL = '/legal/PlushieWord_Terms_of_Service.html'
export const PRIVACY_URL = '/legal/PlushieWord_Privacy_Policy.html'
export const asset = (name) => getFigmaAssetUrl(name)
export const YELLOW = '#FFDF4E'
export const PW_FONT = { fontFamily: "'Nunito', 'PingFang SC', 'Microsoft YaHei', sans-serif", fontWeight: 400 }

// Mirrors App.jsx's detectBrowserNativeLang — pre-login surfaces must localize
// before the user has ever picked a language.
function currentLang() {
  try {
    const saved = localStorage.getItem('app_native')
    if (saved && TABLES[saved]) return saved
  } catch {}
  try {
    const list = navigator.languages?.length ? navigator.languages : [navigator.language || 'en']
    for (const raw of list) {
      const code = (raw || '').toLowerCase()
      if (code.startsWith('zh')) return 'zh'
      if (code.startsWith('ja')) return 'ja'
      if (code.startsWith('en')) return 'en'
    }
  } catch {}
  return 'en'
}

// Same keys as miracleZZ's STRINGS (the components read them 1:1). en is the
// ZZ canon; zh/ja reuse PW's existing UI_TEXT wording wherever a matching
// string already shipped (verify pane, resend, legal rows).
const TABLES = {
  en: {
    checkingAccount: 'Checking your account…',
    welcomeTitle: 'Welcome :D',
    guestMode: 'Guest Mode',
    loginTitle: 'Log in or sign up',
    welcomeBack: 'Welcome back! Sign in to pick up where you left off.',
    autoCreateNote: "New here? We'll create your account automatically.",
    ok: 'OK',
    tosName: 'Terms of Service',
    privacyName: 'Privacy Policy',
    legalPrefix: 'I have read and agree to the ',
    legalToast: 'Please accept both agreements to continue',
    docLoadFailed: 'Failed to load.',
    tryDifferentAccount: 'Please try a different account.',
    emailInvalid: 'Please enter a valid email address.',
    sendFailed: 'Could not send the code. Please try again.',
    codeInvalidFormat: 'Please enter the 6-digit code.',
    codeExpired: 'That code is invalid or has expired.',
    genericError: 'Something went wrong. Please try again.',
    codeSent: 'Code sent!',
    resendFailed: 'Could not resend the code.',
    verifyTitle: 'Verify your email',
    codeSentTo: (email) => `We sent a 6-digit code to ${email}`,
    checkSpam: "Don't see it? Check your Updates tab or Spam folder.",
    codeLabel: 'Verification code:',
    codePlaceholder: '6 digits',
    emailLabel: 'Email:',
    emailPlaceholder: 'your@email.com',
    emailHint: "We'll send a 6-digit code to your email. New here? We'll create your account automatically.",
    verify: 'Verify',
    sendCode: 'Send code',
    resend: "Didn't get it? Resend",
    useDifferentEmail: 'Use a different email',
  },
  zh: {
    checkingAccount: '正在确认你的账号…',
    welcomeTitle: 'Welcome :D',
    guestMode: '游客模式',
    loginTitle: '登录 / 注册',
    welcomeBack: '欢迎回来呀！登录后继续之前的进度～',
    autoCreateNote: '新朋友？我们会自动为你创建账号。',
    ok: '好的',
    tosName: '《服务条款》',
    privacyName: '《隐私协议》',
    legalPrefix: '我已阅读并同意',
    legalToast: '请先勾选同意以上两份协议才能进入应用',
    docLoadFailed: '加载失败。',
    tryDifferentAccount: '请换一个账号试试。',
    emailInvalid: '邮箱地址格式不正确',
    sendFailed: '发送验证码失败，请稍后再试',
    codeInvalidFormat: '请输入 6 位验证码',
    codeExpired: '验证码无效或已过期',
    genericError: '出错了，请稍后再试。',
    codeSent: '验证码已重新发送，请查收邮箱。',
    resendFailed: '重新发送失败，请稍后再试。',
    verifyTitle: '验证你的邮箱',
    codeSentTo: (email) => `我们发了 6 位验证码到 ${email}`,
    checkSpam: '没看到邮件？请检查"最新动态"分类或垃圾邮件文件夹。',
    codeLabel: '验证码：',
    codePlaceholder: '6 位数字',
    emailLabel: '邮箱地址：',
    emailPlaceholder: 'your@email.com',
    emailHint: '我们会发送一个 6 位验证码到你的邮箱。新朋友？我们会自动为你创建账号。',
    verify: '验证',
    sendCode: '发送验证码',
    resend: '没收到？重新发送',
    useDifferentEmail: '换个邮箱',
  },
  ja: {
    checkingAccount: 'アカウントを確認しています…',
    welcomeTitle: 'Welcome :D',
    guestMode: 'ゲストモード',
    loginTitle: 'ログイン / 新規登録',
    welcomeBack: 'おかえりなさい！ログインして続きから始めましょう。',
    autoCreateNote: 'はじめての方はアカウントを自動作成します。',
    ok: 'OK',
    tosName: '「利用規約」',
    privacyName: '「プライバシーポリシー」',
    legalPrefix: '読んで同意します：',
    legalToast: 'アプリに入るには上の2つの同意事項にチェックしてください',
    docLoadFailed: '読み込みに失敗しました。',
    tryDifferentAccount: '別のアカウントをお試しください。',
    emailInvalid: 'メールアドレスの形式が正しくありません',
    sendFailed: 'コードの送信に失敗しました。後ほど再度お試しください',
    codeInvalidFormat: '6 桁のコードを入力してください',
    codeExpired: 'コードが無効または期限切れです',
    genericError: 'エラーが発生しました。もう一度お試しください。',
    codeSent: 'コードを再送信しました。メールをご確認ください。',
    resendFailed: '再送信に失敗しました。',
    verifyTitle: 'メールアドレスを確認',
    codeSentTo: (email) => `${email} に 6 桁の確認コードを送信しました`,
    checkSpam: 'メールが見つからない場合は、メイン以外のタブや迷惑メールもご確認ください。',
    codeLabel: '確認コード：',
    codePlaceholder: '6 桁',
    emailLabel: 'メールアドレス：',
    emailPlaceholder: 'your@email.com',
    emailHint: 'メールに 6 桁の確認コードをお送りします。はじめての方はアカウントを自動作成します。',
    verify: '確認',
    sendCode: 'コードを送信',
    resend: '届いていない場合は再送信',
    useDifferentEmail: '別のメールアドレスを使う',
  },
}

// Property access resolves at render time, so the surfaces re-localize the
// moment the user changes their native language (they re-render anyway).
export const STRINGS = new Proxy({}, {
  get(_, key) {
    const table = TABLES[currentLang()] || TABLES.en
    return table[key] ?? TABLES.en[key]
  },
})
