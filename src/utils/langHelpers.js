import { jaData } from '../data/jaData';
import { phoneticMap } from '../data/phonetics';
import { pinyinMap } from '../data/pinyin';
import { CATEGORY_LABELS } from '../data/categoryLabels';

export { CATEGORY_LABELS };

// ── Language metadata ──
export const LANGUAGES = {
  zh: { code: 'zh', ttsCode: 'zh-CN', flag: '🇨🇳', font: 'inherit' },
  en: { code: 'en', ttsCode: 'en-US', flag: '🇬🇧', font: '"Arial Black", Arial, sans-serif' },
  ja: { code: 'ja', ttsCode: 'ja-JP', flag: '🇯🇵', font: '"Hiragino Sans", "Noto Sans JP", sans-serif' },
};

// ── Get word text in a specific language ──
export function getWordText(word, lang) {
  if (!word) return '';
  if (lang === 'en') return word.en;
  if (lang === 'zh') return word.zh;
  if (lang === 'ja') return word.ja || jaData[word.en]?.ja || '';
  return word.en;
}

// ── Get sentence in a specific language (static data only) ──
// Chinese has no sentences in data → returns '' (caller uses English fallback)
export function getSentence(word, lang) {
  if (!word) return '';
  if (lang === 'en') return word.sentence || '';
  if (lang === 'ja') return word.jaSentence || jaData[word.en]?.sentence || '';
  if (lang === 'zh') return word.sentenceZh || '';
  return '';
}

// ── Katakana → Hiragana auto-conversion ──
function katakanaToHiragana(str) {
  if (!str) return '';
  return str.replace(/[\u30A1-\u30F6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

// ── Get phonetic / reading (returns null if needs API fetch) ──
export function getPhonetic(word, targetLang) {
  if (!word) return '';
  if (targetLang === 'en') {
    if (word.ipa) return word.ipa;
    const local = phoneticMap[word.en];
    return local || null; // null → trigger API fetch
  }
  if (targetLang === 'ja') {
    if (word.jaReading) return word.jaReading;
    const entry = jaData[word.en];
    if (!entry) return '';
    // Use explicit reading if available; otherwise auto-convert katakana → hiragana
    if (entry.reading) return entry.reading;
    return katakanaToHiragana(entry.ja);
  }
  if (targetLang === 'zh') {
    if (word.pinyin) return word.pinyin;
    return pinyinMap[word.zh] || '';
  }
  return '';
}

// ── Check if a word has valid data for both languages ──
export function isWordAvailable(word, nativeLang, targetLang) {
  return !!(getWordText(word, nativeLang) && getWordText(word, targetLang));
}

// ── MyMemory API language pair string ──
export function getTranslationPair(fromLang, toLang) {
  const codeMap = { en: 'en', zh: 'zh-CN', ja: 'ja' };
  return `${codeMap[fromLang]}|${codeMap[toLang]}`;
}

// ── TTS code ──
export function getTtsCode(lang) {
  return LANGUAGES[lang]?.ttsCode || 'en-US';
}

// ── Font family for a language ──
export function getFontFamily(lang) {
  return LANGUAGES[lang]?.font || 'inherit';
}

// ── Language name in another language ──
const LANG_NAMES = {
  zh: { zh: '中文', en: 'Chinese', ja: '中国語' },
  en: { zh: '英语', en: 'English', ja: '英語' },
  ja: { zh: '日语', en: 'Japanese', ja: '日本語' },
};

export function getLangName(langCode, inLang) {
  return LANG_NAMES[langCode]?.[inLang] || LANG_NAMES[langCode]?.en || langCode;
}

// ── Localized UI strings ──
export const UI_TEXT = {
  zh: {
    // Tabs
    learn: '学习', wordlist: '单词本', settings: '设置',
    // Learning page
    allDone: '太棒了！', reviewDone: '复习完毕！',
    reviewAll: '所有单词都已复习完！',
    allLearned: '已全部学完！',
    restart: '重新开始', backToList: '返回单词本',
    translating: '翻译加载中…',
    allWords: '所有单词',
    // Word list
    learning: '学习中', review: '去复习',
    timeOrder: '时间顺序', randomOrder: '随机顺序', reverseRandom: '反向随机',
    mastered: '已斩单词',
    vocabIllustrated: '词汇图鉴', wordsTab: '单词', phrasesTab: '短语',
    noMastered: '还没有已斩单词', noLearned: '还没有学过的单词',
    masteredTip: '点击「斩」来斩杀单词吧！', learnedTip: '去学习页面开始吧',
    close: '关闭',
    // Settings
    myNativeLang: '我的母语', learningLang: '我要学的语言',
    switchConfirm: '确定切换？',
    switchNativeTitle: '切换母语？',
    switchTargetTitle: '切换学习语言？',
    switchDesc: '各语言组合的学习记录独立保存，随时可以切换回来。',
    cancel: '取消', confirm: '确定切换',
    // Category
    allLevels: '全部难度', levelPrefix: '难度',
    ok: '确认', skip: '斩',
    dKnow: '认识', dDontKnow: '不认识',
    categoryDone: '本节完成！', autoSwitching: '正在切换到其他分类…',
    reviewAgain: '重新复习', learnNew: '学习新的',
    reviewEmptyCategory: '本分类还没有学过的单词哦',
    reviewRoundsDone: '本分类已复习完毕啦',
    reviewSwitchingToAll: '即将跳转至「全部」分类…',
    logout: '退出登录', logoutConfirm: '确定要退出登录吗？',
    passwordRow: '登录密码', passwordSet: '已设置', passwordNotSet: '未设置',
    setPasswordRow: '设置密码', changePasswordRow: '修改密码',
    setPasswordTitle: '设置登录密码', changePasswordTitle: '修改登录密码',
    currentPasswordLabel: '当前密码', newPasswordLabel: '新密码', confirmPasswordLabel: '确认新密码',
    currentPasswordPlaceholder: '请输入当前密码',
    passwordTooShort: '密码至少 6 位', passwordMismatch: '两次密码不一致',
    passwordComplexity: '密码需包含大小写字母和数字',
    currentPasswordWrong: '当前密码不正确',
    currentPasswordRequired: '请先输入当前密码',
    nextStep: '下一步',
    passwordSetSuccess: '密码已设置！下次可以用邮箱密码登录', passwordChangeSuccess: '密码已更新！',
    passwordPlaceholder: '至少6位且包含大小写字母和数字',
    passwordSetFailed: '设置失败',
    // Email login page
    emailLabel: '邮箱地址：', loginPasswordLabel: '密码：', confirmPasswordSignupLabel: '确认密码：',
    emailPlaceholder: 'your@email.com', passwordDots: '••••••••',
    fillEmailAndPassword: '请填写邮箱和密码',
    signupBtn: '注册', loginBtn: '登录',
    noAccountYet: '还没有账号？', hasAccountAlready: '已有账号？',
    operationFailed: '操作失败，请稍后重试',
    signupSuccess: '注册成功！请前往邮箱点击验证链接，然后回来登录。',
    verifyCodeTitle: '验证你的邮箱',
    verifyCodeSubtitle: '我们发了 6 位验证码到 {email}',
    verifyCodeHint: '没看到邮件？请检查"最新动态"分类或垃圾邮件文件夹。',
    verifyCodeLabel: '验证码：',
    verifyCodePlaceholder: '6 位数字',
    verifyBtn: '验证',
    resendCode: '没收到？重新发送',
    codeIncomplete: '请输入 6 位验证码',
    codeInvalid: '验证码无效或已过期',
    codeResent: '验证码已重新发送，请查收邮箱。',
    changeEmail: '换个邮箱',
    emailAlreadyTaken: '该邮箱已注册。如果之前用其他方式登录过，请用下方按钮；登录后可在设置里绑定密码。',
    emailNotRegistered: '该邮箱还没有注册，请点击下方"去注册"创建账号。',
    switchedToSignup: '该邮箱还没有账号，已为你切换到注册模式。请再次输入密码完成注册。',
    emailOauthOnly: '该邮箱已通过 {provider} 登录注册，请用 {provider} 登录。登录后可在「设置」里绑定密码。',
    wrongPassword: '密码错误，请重试。',
    authOrOauthError: '邮箱或密码错误。可能原因：未注册、密码错误，或之前用了其他方式登录。',
    emailUnconfirmed: '请先到邮箱点击验证链接完成注册，然后再登录。',
    // Add to home screen
    installToHome: '添加到桌面',
    installAlready: '已添加到桌面',
    installIosTitle: '添加到桌面',
    installIosTip: '点击 Safari 底部的分享按钮，选择「查看更多」，下滑找到「添加到主屏幕」。',
    installIosChromeTip: '点击 Chrome 右上角的分享按钮，选择「查看更多」，下滑找到「添加到主屏幕」。',
    installAndroidTip: '点 Chrome 右上角的「⋮」菜单 → 选择「安装应用」或「添加到主屏幕」即可。\n\n如果菜单里没有「安装」选项（说明 Chrome 还在准备）：刷新一下页面再点这里试试。\n\n如果之前装过又删了，菜单里只有「打开 PlushieWord」：去系统设置 → 应用 → PlushieWord → 卸载，再回来重试。',
    installDesktopTip: '看到这个提示，多半是你之前装过 PlushieWord 但卸载得不够干净。请这样清掉残留：在地址栏输入 chrome://apps，找到 PlushieWord，右键选择「从 Chrome 中删除」，回来再点一次「添加到桌面」即可。\n\n如果你确认从来没装过：直接点击地址栏右侧的「安装」小图标，或者打开右上角的「⋮」菜单，选择「投放、保存和分享」，再点击「安装 PlushieWord...」。\n\n要是地址栏看不到安装图标、菜单里也没有安装选项，说明 Chrome 还在准备中，刷新一下页面再点这里就行。',
    installSafariDesktopTip: '请点击 Safari 窗口右上角的分享按钮，在弹出的菜单里选择「添加到程序坞」。',
    installUnsupported: '当前浏览器不支持一键添加。请用手机自带的「分享 / 添加到主屏幕」功能。',
    iKnow: '知道了',
    copied: '已复制！',
    // Profile
    memberDays: '累计登录第 {n} 天',
    guestSubtitle: '测试模式',
    avatarUploadFailed: '头像上传失败，请重试',
  },
  en: {
    learn: 'Learn', wordlist: 'Words', settings: 'Settings',
    allDone: 'Great job!', reviewDone: 'Review complete!',
    reviewAll: 'All words reviewed!',
    allLearned: ' all learned!',
    restart: 'Start Over', backToList: 'Back to List',
    translating: 'Translating…',
    allWords: 'All words',
    learning: 'Learning', review: 'Review',
    timeOrder: 'By Time', randomOrder: 'Random', reverseRandom: 'Reverse',
    mastered: 'Mastered',
    vocabIllustrated: 'Gallery', wordsTab: 'Words', phrasesTab: 'Phrases',
    noMastered: 'No mastered words yet', noLearned: 'No learned words yet',
    masteredTip: 'Tap "Got it" to master words!', learnedTip: 'Start learning now',
    close: 'Close',
    myNativeLang: 'My Native Language', learningLang: 'Language to Learn',
    switchConfirm: 'Confirm switch?',
    switchNativeTitle: 'Switch native language?',
    switchTargetTitle: 'Switch learning language?',
    switchDesc: 'Progress is saved independently for each language combination.',
    cancel: 'Cancel', confirm: 'Switch',
    allLevels: 'All Levels', levelPrefix: 'Level',
    ok: 'OK', skip: 'Got it',
    dKnow: 'Know', dDontKnow: "Don't know",
    categoryDone: 'Section complete!', autoSwitching: 'Switching to other words…',
    reviewAgain: 'Review Again', learnNew: 'Learn New',
    reviewEmptyCategory: "You haven't learned any words in this category yet",
    reviewRoundsDone: 'This category is fully reviewed',
    reviewSwitchingToAll: 'Switching to "All"…',
    logout: 'Log out', logoutConfirm: 'Are you sure you want to log out?',
    passwordRow: 'Password', passwordSet: 'Set', passwordNotSet: 'Not set',
    setPasswordRow: 'Set password', changePasswordRow: 'Change password',
    setPasswordTitle: 'Set password', changePasswordTitle: 'Change password',
    currentPasswordLabel: 'Current password', newPasswordLabel: 'New password', confirmPasswordLabel: 'Confirm new password',
    currentPasswordPlaceholder: 'Enter current password',
    passwordTooShort: 'Password must be at least 6 characters', passwordMismatch: 'Passwords do not match',
    passwordComplexity: 'Password must include upper & lower case letters and a digit',
    currentPasswordWrong: 'Current password is incorrect',
    currentPasswordRequired: 'Please enter your current password first',
    nextStep: 'Next',
    passwordSetSuccess: 'Password set! You can now log in with email and password.', passwordChangeSuccess: 'Password updated!',
    passwordPlaceholder: 'At least 6 chars, with upper, lower & digit',
    passwordSetFailed: 'Failed to set password',
    // Email login page
    emailLabel: 'Email:', loginPasswordLabel: 'Password:', confirmPasswordSignupLabel: 'Confirm password:',
    emailPlaceholder: 'your@email.com', passwordDots: '••••••••',
    fillEmailAndPassword: 'Please enter your email and password',
    signupBtn: 'Sign up', loginBtn: 'Log in',
    noAccountYet: "Don't have an account? ", hasAccountAlready: 'Already have an account? ',
    operationFailed: 'Something went wrong, please try again',
    signupSuccess: 'Signed up! Check your inbox and click the verification link, then come back to log in.',
    verifyCodeTitle: 'Verify your email',
    verifyCodeSubtitle: 'We sent a 6-digit code to {email}',
    verifyCodeHint: "Don't see it? Check your Updates tab or Spam folder.",
    verifyCodeLabel: 'Verification code:',
    verifyCodePlaceholder: '6 digits',
    verifyBtn: 'Verify',
    resendCode: "Didn't get it? Resend",
    codeIncomplete: 'Please enter the 6-digit code',
    codeInvalid: 'Code is invalid or has expired',
    codeResent: 'Code resent. Check your inbox.',
    changeEmail: 'Use a different email',
    emailAlreadyTaken: 'This email is already registered. If you previously signed in another way, use the buttons below; you can set a password later in Settings.',
    emailNotRegistered: 'This email is not registered. Tap "Sign up" below to create an account.',
    switchedToSignup: "This email isn't registered yet — switched to sign up. Please re-enter your password to create the account.",
    emailOauthOnly: 'This email is registered via {provider}. Please log in with {provider}. You can set a password later in Settings.',
    wrongPassword: 'Wrong password, please try again.',
    authOrOauthError: 'Email or password is incorrect. The account may not exist, the password may be wrong, or you may have signed in another way.',
    emailUnconfirmed: 'Please click the verification link in your email first, then log in.',
    // Add to home screen
    installToHome: 'Add to Home Screen',
    installAlready: 'Already added',
    installIosTitle: 'Add to Home Screen',
    installIosTip: 'Tap the Share button at the bottom of Safari, choose "View More", and scroll down to find "Add to Home Screen".',
    installIosChromeTip: 'Tap the Share button at the top-right of Chrome, choose "View More", and scroll down to find "Add to Home Screen".',
    installAndroidTip: 'Tap the "⋮" menu in Chrome\'s top-right → "Install app" or "Add to Home screen".\n\nIf there\'s no "Install" option (Chrome is still warming up): refresh the page and tap this button again.\n\nIf you previously installed and deleted it and the menu only shows "Open PlushieWord": Settings → Apps → PlushieWord → Uninstall, then try again.',
    installDesktopTip: 'You\'re seeing this dialog most likely because you previously installed PlushieWord but didn\'t fully uninstall it. To clear the leftover, type chrome://apps in the address bar, right-click PlushieWord, choose "Remove from Chrome", then come back and tap "Add to Home Screen" again.\n\nIf you\'ve never installed it before, click the install icon at the right side of the address bar, or open the "⋮" menu, choose "Cast, save, and share", then click "Install PlushieWord...".\n\nIf neither the install icon nor the menu option is showing up, Chrome is still warming up. Refresh the page and tap this button again.',
    installSafariDesktopTip: 'Click the Share button at the top-right of the Safari window and choose "Add to Dock" from the menu.',
    installUnsupported: 'This browser doesn\'t support one-tap install. Please use your browser\'s Share / Add to Home Screen menu.',
    iKnow: 'Got it',
    copied: 'Copied!',
    // Profile
    memberDays: 'Day {n} of total visits',
    guestSubtitle: 'Test mode',
    avatarUploadFailed: 'Avatar upload failed, please retry',
  },
  ja: {
    learn: '学習', wordlist: '単語帳', settings: '設定',
    allDone: 'すごい！', reviewDone: '復習完了！',
    reviewAll: '全ての単語を復習しました！',
    allLearned: '全て学習済み！',
    restart: 'やり直す', backToList: '単語帳に戻る',
    translating: '翻訳中…',
    allWords: '全ての単語',
    learning: '学習中の単語', review: '復習する',
    timeOrder: '時間順', randomOrder: 'ランダム', reverseRandom: '逆ランダム',
    mastered: '習得済み',
    vocabIllustrated: '図鑑', wordsTab: '単語', phrasesTab: 'フレーズ',
    noMastered: '習得済みの単語はまだありません', noLearned: 'まだ学習した単語はありません',
    masteredTip: '「覚えた」で単語を習得しよう！', learnedTip: '学習を始めよう',
    close: '閉じる',
    myNativeLang: '母語', learningLang: '学びたい言語',
    switchConfirm: '切り替えますか？',
    switchNativeTitle: '母語を切り替えますか？',
    switchTargetTitle: '学習言語を切り替えますか？',
    switchDesc: '各言語の学習記録は独立して保存されます。',
    cancel: 'キャンセル', confirm: '切り替える',
    allLevels: '全レベル', levelPrefix: '難易度',
    ok: '確認', skip: '覚えた',
    dKnow: '知ってる', dDontKnow: '知らない',
    categoryDone: 'セクション完了！', autoSwitching: '他のカテゴリーに切り替えています…',
    reviewAgain: 'もう一度復習', learnNew: '新しく学ぶ',
    reviewEmptyCategory: 'このカテゴリーにはまだ学習した単語がありません',
    reviewRoundsDone: 'このカテゴリーの復習が完了しました',
    reviewSwitchingToAll: '「すべて」カテゴリーに切り替えます…',
    logout: 'ログアウト', logoutConfirm: 'ログアウトしますか？',
    passwordRow: 'パスワード', passwordSet: '設定済み', passwordNotSet: '未設定',
    setPasswordRow: 'パスワードを設定', changePasswordRow: 'パスワードを変更',
    setPasswordTitle: 'パスワードを設定', changePasswordTitle: 'パスワードを変更',
    currentPasswordLabel: '現在のパスワード', newPasswordLabel: '新しいパスワード', confirmPasswordLabel: '新しいパスワード（確認）',
    currentPasswordPlaceholder: '現在のパスワードを入力',
    passwordTooShort: 'パスワードは6文字以上必要です', passwordMismatch: 'パスワードが一致しません',
    passwordComplexity: 'パスワードは大文字・小文字・数字を含む必要があります',
    currentPasswordWrong: '現在のパスワードが正しくありません',
    currentPasswordRequired: '先に現在のパスワードを入力してください',
    nextStep: '次へ',
    passwordSetSuccess: 'パスワードを設定しました！次回からメール+パスワードでログインできます', passwordChangeSuccess: 'パスワードを更新しました！',
    passwordPlaceholder: '6文字以上、大文字・小文字・数字を含む',
    passwordSetFailed: '設定に失敗しました',
    // Email login page
    emailLabel: 'メールアドレス：', loginPasswordLabel: 'パスワード：', confirmPasswordSignupLabel: 'パスワード（確認）：',
    emailPlaceholder: 'your@email.com', passwordDots: '••••••••',
    fillEmailAndPassword: 'メールアドレスとパスワードを入力してください',
    signupBtn: '新規登録', loginBtn: 'ログイン',
    noAccountYet: 'アカウントをお持ちでない方は ', hasAccountAlready: 'アカウントをお持ちの方は ',
    operationFailed: '操作に失敗しました。後ほど再度お試しください',
    signupSuccess: '登録が完了しました！メールの認証リンクをクリックしてからログインしてください。',
    verifyCodeTitle: 'メールアドレスを確認',
    verifyCodeSubtitle: '{email} に 6 桁の確認コードを送信しました',
    verifyCodeHint: 'メールが見つからない場合は、メイン以外のタブや迷惑メールもご確認ください。',
    verifyCodeLabel: '確認コード：',
    verifyCodePlaceholder: '6 桁',
    verifyBtn: '確認',
    resendCode: '届いていない場合は再送信',
    codeIncomplete: '6 桁のコードを入力してください',
    codeInvalid: 'コードが無効または期限切れです',
    codeResent: 'コードを再送信しました。メールをご確認ください。',
    changeEmail: '別のメールアドレスを使う',
    emailAlreadyTaken: 'このメールアドレスは登録済みです。以前他の方法でログインしたことがある場合は、下のボタンをご利用ください。ログイン後、設定からパスワードを設定できます。',
    emailNotRegistered: 'このメールアドレスは未登録です。下の「新規登録」をタップしてアカウントを作成してください。',
    switchedToSignup: 'このメールアドレスは未登録です。新規登録モードに切り替えました。パスワードをもう一度入力して登録を完了してください。',
    emailOauthOnly: 'このメールアドレスは {provider} で登録されています。{provider} でログインしてください。ログイン後、設定からパスワードを設定できます。',
    wrongPassword: 'パスワードが間違っています。もう一度お試しください。',
    authOrOauthError: 'メールアドレスまたはパスワードが間違っています。未登録、パスワードの誤り、または他の方法でログインした可能性があります。',
    emailUnconfirmed: 'メールの認証リンクをクリックしてからログインしてください。',
    // Add to home screen
    installToHome: 'ホームに追加',
    installAlready: '追加済み',
    installIosTitle: 'ホームに追加',
    installIosTip: 'Safari 下部の共有ボタンをタップし、「もっと見る」を選んで、下にスクロールして「ホーム画面に追加」を選んでください。',
    installIosChromeTip: 'Chrome 右上の共有ボタンをタップし、「もっと見る」を選んで、下にスクロールして「ホーム画面に追加」を選んでください。',
    installAndroidTip: 'Chrome 右上の「⋮」メニュー →「アプリをインストール」または「ホーム画面に追加」を選択してください。\n\n「インストール」が表示されない場合（Chrome の準備中）：ページを再読み込みしてから、もう一度このボタンをタップしてください。\n\n以前インストール後に削除した場合：設定 → アプリ → PlushieWord → アンインストールしてから、もう一度お試しください。',
    installDesktopTip: 'この案内が出るのは、以前 PlushieWord をインストールしたものの完全には削除されていない可能性が高いです。アドレスバーに chrome://apps と入力し、PlushieWord を右クリックして「Chrome から削除」を選び、戻ってからもう一度「ホームに追加」をタップしてください。\n\n一度もインストールしたことがない場合は、アドレスバー右側の「インストール」アイコンをクリックするか、右上の「⋮」メニューから「キャスト、保存、共有」を選び、「PlushieWord をインストール...」をクリックしてください。\n\nインストールアイコンが見当たらず、メニューにもインストール項目がない場合は、Chrome がまだ準備中です。ページを再読み込みしてからもう一度タップしてください。',
    installSafariDesktopTip: 'Safari ウィンドウの右上にある共有ボタンをクリックし、表示されたメニューから「Dock に追加」を選んでください。',
    installUnsupported: 'このブラウザはワンタップ追加に対応していません。ブラウザの「共有 / ホーム画面に追加」をご利用ください。',
    iKnow: 'OK',
    copied: 'コピーしました！',
    // Profile
    memberDays: '累計ログイン {n} 日目',
    guestSubtitle: 'テストモード',
    avatarUploadFailed: 'アイコンのアップロードに失敗しました',
  },
};

// CATEGORY_LABELS is imported from src/data/categoryLabels.js (auto-generated)
// and re-exported at the top of this file for backwards compatibility.
