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

    // 13岁以下账号（miracleZZ docs/kids-account-plan.md）。年龄弹窗必须中立：不提示「几岁以下会怎样」。
    ageTitle: 'How old are you?',
    agePlaceholder: 'Age',
    ageNote: "We won't save it.",
    ageContinue: 'Continue',
    kidCreate: 'Create account',
    kidLogin: 'Log in',
    kidNote: 'Just a username and password — no email needed.',
    usernameLabel: 'Username:',
    usernamePlaceholder: 'A cute nickname',
    usernameHint: "Make up a nickname. Don't use your real name, email or phone number.",
    passwordLabel: 'Password:',
    passwordPlaceholder: 'At least 6 characters',
    password2Label: 'Password again:',
    forgotPassword: 'Forgot your password? Ask a parent for help',
    parentHelpTitle: 'Ask a parent for help',
    parentHelpDesc: "A parent can leave their email here. We'll email them to help reset your password.",
    parentEmailLabel: "Parent's email:",
    parentEmailPlaceholder: 'parent@email.com',
    messageLabel: 'Message (optional):',
    send: 'Send',
    parentHelpSent: "Sent! We'll email your parent soon.",
    backToLogin: 'Back to log in',
    kidErrors: {
      username_empty: 'Please type a username.',
      username_at: "Don't use an email address as your username.",
      username_digits: "Too many numbers in a row — don't use a phone number.",
      username_length: 'Usernames are 3–16 letters, numbers or _.',
      username_chars: 'Only letters, numbers and _ please.',
      password_short: 'Passwords need at least 6 characters.',
      password_long: 'That password is too long.',
      password_mismatch: "The two passwords don't match.",
      taken: 'That username is taken — try another one.',
      wrong_login: 'Wrong username or password.',
      rate_limited: 'Too many tries. Please wait a while and try again.',
      parent_email: "Please enter your parent's email.",
      failed: 'Something went wrong. Please try again.',
    },
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

    // 用户名只能是字母 / 数字 / _（kidRules.js），所以中文提示要说清楚「英文昵称」
    ageTitle: '你几岁了？',
    agePlaceholder: '年龄',
    ageNote: '我们不会保存你的年龄。',
    ageContinue: '继续',
    kidCreate: '创建账号',
    kidLogin: '登录',
    kidNote: '只要用户名和密码，不需要邮箱。',
    usernameLabel: '用户名：',
    usernamePlaceholder: '起个英文昵称',
    usernameHint: '用字母、数字或 _ 起个昵称，不要用真名、邮箱或电话号码。',
    passwordLabel: '密码：',
    passwordPlaceholder: '至少 6 位',
    password2Label: '再输一次密码：',
    forgotPassword: '忘记密码？请家长帮忙',
    parentHelpTitle: '请家长帮忙',
    parentHelpDesc: '请家长在这里留下邮箱，我们会发邮件帮忙重置密码。',
    parentEmailLabel: '家长邮箱：',
    parentEmailPlaceholder: 'parent@email.com',
    messageLabel: '留言（选填）：',
    send: '发送',
    parentHelpSent: '已发送！我们会尽快给你的家长发邮件。',
    backToLogin: '返回登录',
    kidErrors: {
      username_empty: '请输入用户名。',
      username_at: '用户名不能用邮箱地址。',
      username_digits: '连续数字太多了，不要用电话号码。',
      username_length: '用户名要 3–16 位，只能用字母、数字或 _。',
      username_chars: '只能用字母、数字和 _。',
      password_short: '密码至少要 6 位。',
      password_long: '密码太长了。',
      password_mismatch: '两次输入的密码不一样。',
      taken: '这个用户名已经有人用了，换一个吧。',
      wrong_login: '用户名或密码不对。',
      rate_limited: '尝试次数太多了，请过一会儿再试。',
      parent_email: '请输入家长的邮箱。',
      failed: '出错了，请稍后再试。',
    },
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

    ageTitle: '何歳ですか？',
    agePlaceholder: '年齢',
    ageNote: '年齢は保存しません。',
    ageContinue: '次へ',
    kidCreate: 'アカウント作成',
    kidLogin: 'ログイン',
    kidNote: 'ユーザー名とパスワードだけ。メールアドレスはいりません。',
    usernameLabel: 'ユーザー名：',
    usernamePlaceholder: 'ローマ字のニックネーム',
    usernameHint: '英字・数字・_ でニックネームを作ってね。本名やメールアドレス、電話番号は使わないでね。',
    passwordLabel: 'パスワード：',
    passwordPlaceholder: '6 文字以上',
    password2Label: 'もう一度パスワード：',
    forgotPassword: 'パスワードを忘れた？おうちの人に相談',
    parentHelpTitle: 'おうちの人に相談する',
    parentHelpDesc: 'おうちの人のメールアドレスを入力してください。パスワードの再設定をメールでお手伝いします。',
    parentEmailLabel: 'おうちの人のメールアドレス：',
    parentEmailPlaceholder: 'parent@email.com',
    messageLabel: 'メッセージ（任意）：',
    send: '送信',
    parentHelpSent: '送信しました！おうちの人にメールでご連絡します。',
    backToLogin: 'ログインに戻る',
    kidErrors: {
      username_empty: 'ユーザー名を入力してね。',
      username_at: 'メールアドレスはユーザー名に使えません。',
      username_digits: '数字が続きすぎています。電話番号は使わないでね。',
      username_length: 'ユーザー名は英字・数字・_ で 3〜16 文字です。',
      username_chars: '英字・数字・_ だけ使えます。',
      password_short: 'パスワードは 6 文字以上にしてね。',
      password_long: 'パスワードが長すぎます。',
      password_mismatch: '2 つのパスワードが一致しません。',
      taken: 'このユーザー名は使われています。別の名前にしてね。',
      wrong_login: 'ユーザー名かパスワードが違います。',
      rate_limited: '試行回数が多すぎます。しばらくしてからもう一度お試しください。',
      parent_email: 'おうちの人のメールアドレスを入力してね。',
      failed: 'エラーが発生しました。もう一度お試しください。',
    },
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

// 13岁以下账号：用户名 → 内部假邮箱的域名（保留顶级域 .invalid，永远发不出信），
// 必须和 supabase/functions/kid-signup/config.ts、迁移 20261007120000_kid_accounts.sql
// 里的域名一致。
export const KID_EMAIL_DOMAIN = 'kids.plushieword.invalid'
export const KID_SIGNUP_FUNCTION = 'kid-signup'
export const PARENT_HELP_TABLE = 'parent_help_requests'
// 设备级年龄答案（不分 scope）。只存 'under13' / '13plus'，不存年龄。
export const AGE_KEY = 'auth.ageBand.v1'
