// login-auth-ui public API — the same four names the old src/auth/ui.jsx
// exported, so Phase 3's App.jsx switch is a one-line import change.
export { WelcomePage } from './WelcomePage.jsx'
export { LoginPromptModal } from './LoginPromptModal.jsx'
export { EmailLoginPage } from './EmailLoginPage.jsx'
export { friendlyAuthError, CloseX, BackButton } from './shared.jsx'
export { HandoffVeil, useHandoffPending } from './HandoffVeil.jsx'
