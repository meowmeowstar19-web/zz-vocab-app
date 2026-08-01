/* ---------------------------------------------------------- HandoffVeil */
// The Add-to-Home-Screen first-open cover. A fresh PWA container inherits only
// cookies, so the app boots as a guest for the ~1s it takes sessionMirror to
// redeem the mirrored tokens into a real session — and the user watches a
// guest screen suddenly flip into their account ("did I get logged out?").
// This veil covers exactly that window: the app renders as usual underneath
// (no blank page, no skeleton), with the pop-kit scrim + a spinner on top.
//
// Detection is the check-in-popup guard's, verbatim: a NON-account scope that
// still holds the mirror cookie is that boot in flight — logout and dead
// tokens both clear the cookie, so a true guest never has one. Decided ONCE at
// mount; a cookie appearing later means a login just happened here, not a
// handoff. Pure presentation — this module never touches auth state.
//
// It leaves on whichever comes first:
//   · the account lands (isAccountScope flips; the host tree usually remounts
//     on the scope key at the same moment);
//   · sessionMirror writes its outcome note (HANDOFF_LOG_KEY) — success or
//     failure, the attempt is over and the state we're in is final;
//   · the timeout — a hung network must not spin forever. Release into guest;
//     an unresolved handoff kept its cookies, so the next boot retries.
//
// The detection lives in useHandoffPending so a host can defer its OWN
// boot-time decisions on the same signal (PlushieWord holds the language
// picker with it: the picker's key is device-local, so the empty container
// would ask again even though the account about to land carries the answer).
import { useEffect, useState } from 'react'
import { useAuth } from '../authSetup.js'
import { readMirror, HANDOFF_LOG_KEY } from '../login-auth-core/index.js'
import { MODAL_SCRIM } from '../general-ui/popKit.jsx'

const TIMEOUT_MS = 8000 // generous vs the ~1s real-device handoff, tiny vs "forever"
const POLL_MS = 250 // storage events don't fire in the writing document — poll

const readNote = () => {
  try {
    return localStorage.getItem(HANDOFF_LOG_KEY)
  } catch {
    return null
  }
}

// True from mount until the handoff concludes (account lands / outcome note /
// timeout). False forever on boots that never had a handoff in flight.
export function useHandoffPending() {
  const auth = useAuth()
  const [active, setActive] = useState(() => !auth.isAccountScope && !!readMirror(document))
  const pending = active && !auth.isAccountScope
  useEffect(() => {
    if (!pending) return
    const before = readNote()
    const deadline = Date.now() + TIMEOUT_MS
    const id = setInterval(() => {
      if (readNote() !== before || Date.now() >= deadline) setActive(false)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [pending])
  return pending
}

export function HandoffVeil({ style }) {
  const show = useHandoffPending()
  if (!show) return null
  return (
    <div style={{ ...MODAL_SCRIM, ...style }} role="status" aria-label="Loading">
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          border: '3px solid rgba(255,255,255,0.35)',
          borderTopColor: '#fff',
          animation: 'laHandoffSpin 0.9s linear infinite',
        }}
      />
      <style>{'@keyframes laHandoffSpin { to { transform: rotate(360deg) } }'}</style>
    </div>
  )
}
