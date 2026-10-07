// login-auth-ui public API — the same four names the old src/auth/ui.jsx
// exported, so Phase 3's App.jsx switch is a one-line import change.
export { WelcomePage } from './WelcomePage.jsx'
export { LoginPromptModal } from './LoginPromptModal.jsx'
export { EmailLoginPage } from './EmailLoginPage.jsx'
export { friendlyAuthError, CloseX, BackButton } from './shared.jsx'
export { HandoffVeil, useHandoffPending } from './HandoffVeil.jsx'
// 13岁以下账号（docs/kids-account-plan.md）：宿主用 useIsKid 关掉儿童不该有的功能
export { useIsKid, useAgeBand } from './kidAccount.js'
export { isKidUser } from './kidRules.js'
