// sessionMirror — the iOS Add-to-Home-Screen handoff cookies. Covers all three
// duties: keeping the cookies in lockstep with auth events, redeeming them on
// a boot whose localStorage session didn't survive the copy (only cookies do),
// and preferring the clone-session Edge Function path (independent session, no
// token rotation) with refreshSession as the fallback safety net.
import { describe, it, expect, vi } from 'vitest'

import {
  attachSessionMirror,
  readMirror,
  writeMirror,
  MIRROR_COOKIE,
  ACCESS_COOKIE,
  CLONE_FN,
} from './sessionMirror.js'

// Minimal document.cookie fake: assignment parses name=value + Max-Age=0 as
// delete, reads join the jar — enough semantics for the mirror's usage.
function fakeDoc() {
  const jar = new Map()
  return {
    get cookie() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    set cookie(str) {
      const [pair, ...attrs] = str.split(';').map((s) => s.trim())
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      if (attrs.some((a) => a.toLowerCase() === 'max-age=0')) jar.delete(name)
      else jar.set(name, value)
    },
  }
}

// Controllable auth client: tests drive fire() to emit events; getSession /
// refreshSession / verifyOtp resolve whatever the test configured. Pass
// invokeResult to grow a functions.invoke (an Error value makes it throw);
// leaving it out models a core carried by an app whose client has no functions
// API — the portability fallback.
function fakeClient({ session = null, refreshResult, invokeResult, verifyResult } = {}) {
  let handler = null
  const calls = { refreshSession: [], invoke: [], verifyOtp: [] }
  const client = {
    calls,
    fire: (event, s) => handler?.(event, s),
    auth: {
      onAuthStateChange: (cb) => { handler = cb },
      getSession: async () => ({ data: { session } }),
      refreshSession: async (args) => {
        calls.refreshSession.push(args)
        return refreshResult ?? { data: { session: null }, error: new Error('unconfigured') }
      },
      verifyOtp: async (args) => {
        calls.verifyOtp.push(args)
        return verifyResult ?? { data: { session: null }, error: new Error('unconfigured') }
      },
    },
  }
  if (invokeResult !== undefined) {
    client.functions = {
      invoke: async (name, opts) => {
        calls.invoke.push([name, opts])
        if (invokeResult instanceof Error) throw invokeResult
        return invokeResult
      },
    }
  }
  return client
}

describe('cookie read/write', () => {
  it('round-trips a token and clears on null', () => {
    const doc = fakeDoc()
    writeMirror(doc, 'tok+1/2=') // worst-case chars must survive encoding
    expect(readMirror(doc)).toBe('tok+1/2=')
    writeMirror(doc, null)
    expect(readMirror(doc)).toBe(null)
    expect(doc.cookie).not.toContain(MIRROR_COOKIE)
  })

  it('second cookie name is independent of the default', () => {
    const doc = fakeDoc()
    writeMirror(doc, 'rt', MIRROR_COOKIE)
    writeMirror(doc, 'at', ACCESS_COOKIE)
    expect(readMirror(doc)).toBe('rt')
    expect(readMirror(doc, ACCESS_COOKIE)).toBe('at')
    writeMirror(doc, null, ACCESS_COOKIE)
    expect(readMirror(doc, ACCESS_COOKIE)).toBe(null)
    expect(readMirror(doc)).toBe('rt') // untouched
  })

  it('a value past the single-cookie cap is skipped, never truncated', () => {
    const doc = fakeDoc()
    writeMirror(doc, 'x'.repeat(4000), ACCESS_COOKIE)
    expect(readMirror(doc, ACCESS_COOKIE)).toBe(null)
    // and an oversize write clears whatever was there before (no stale token)
    writeMirror(doc, 'small', ACCESS_COOKIE)
    writeMirror(doc, 'y'.repeat(4000), ACCESS_COOKIE)
    expect(readMirror(doc, ACCESS_COOKIE)).toBe(null)
  })
})

describe('event mirroring', () => {
  it('stamps both cookies on any event carrying a session, clears both on SIGNED_OUT', async () => {
    const doc = fakeDoc()
    const client = fakeClient()
    await attachSessionMirror(client, doc)

    client.fire('SIGNED_IN', { refresh_token: 'rt1', access_token: 'at1' })
    expect(readMirror(doc)).toBe('rt1')
    expect(readMirror(doc, ACCESS_COOKIE)).toBe('at1')

    client.fire('TOKEN_REFRESHED', { refresh_token: 'rt2', access_token: 'at2' }) // rotation must follow
    expect(readMirror(doc)).toBe('rt2')
    expect(readMirror(doc, ACCESS_COOKIE)).toBe('at2')

    client.fire('SIGNED_OUT', null)
    expect(readMirror(doc)).toBe(null)
    expect(readMirror(doc, ACCESS_COOKIE)).toBe(null)
  })

  it('a session without an access token clears the stale access cookie', async () => {
    const doc = fakeDoc()
    writeMirror(doc, 'stale-at', ACCESS_COOKIE)
    const client = fakeClient()
    await attachSessionMirror(client, doc)
    client.fire('SIGNED_IN', { refresh_token: 'rt1' })
    expect(readMirror(doc)).toBe('rt1')
    expect(readMirror(doc, ACCESS_COOKIE)).toBe(null)
  })
})

describe('boot redemption — clone path', () => {
  const cookies = () => {
    const doc = fakeDoc()
    writeMirror(doc, 'rt-mir')
    writeMirror(doc, 'at-mir', ACCESS_COOKIE)
    return doc
  }

  it('happy path: invoke → verifyOtp mints the independent session; refreshSession never runs', async () => {
    const doc = cookies()
    const client = fakeClient({
      invokeResult: { data: { token_hash: 'hash1' }, error: null },
      verifyResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc)
    expect(client.calls.invoke).toEqual([
      [CLONE_FN, { body: { access_token: 'at-mir', refresh_token: 'rt-mir' } }],
    ])
    expect(client.calls.verifyOtp).toEqual([{ type: 'magiclink', token_hash: 'hash1' }])
    expect(client.calls.refreshSession).toEqual([])
    expect(readMirror(doc)).toBe('rt-mir') // live cookies stay (rewrite arrives via events)
  })

  it('invoke error → falls back to refreshSession with the mirrored token', async () => {
    const doc = cookies()
    const client = fakeClient({
      invokeResult: { data: null, error: new Error('cors') },
      refreshResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc)
    expect(client.calls.verifyOtp).toEqual([])
    expect(client.calls.refreshSession).toEqual([{ refresh_token: 'rt-mir' }])
    expect(readMirror(doc)).toBe('rt-mir')
  })

  it('invoke throwing (network down) is swallowed into the same fallback', async () => {
    const doc = cookies()
    const client = fakeClient({
      invokeResult: new Error('fetch failed'),
      refreshResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc)
    expect(client.calls.refreshSession).toEqual([{ refresh_token: 'rt-mir' }])
  })

  it('token_hash arrives but verifyOtp rejects → fallback still runs', async () => {
    const doc = cookies()
    const client = fakeClient({
      invokeResult: { data: { token_hash: 'hash1' }, error: null },
      verifyResult: { data: { session: null }, error: new Error('expired') },
      refreshResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc)
    expect(client.calls.verifyOtp.length).toBe(1)
    expect(client.calls.refreshSession).toEqual([{ refresh_token: 'rt-mir' }])
  })

  it('clone AND fallback both dead → every mirror cookie is cleared', async () => {
    const doc = cookies()
    const client = fakeClient({
      invokeResult: { data: null, error: new Error('500') },
      refreshResult: { data: { session: null }, error: new Error('invalid') },
    })
    await attachSessionMirror(client, doc)
    expect(readMirror(doc)).toBe(null)
    expect(readMirror(doc, ACCESS_COOKIE)).toBe(null)
  })

  it('access cookie only (no refresh token): clone is attempted, no fallback possible', async () => {
    const doc = fakeDoc()
    writeMirror(doc, 'at-only', ACCESS_COOKIE)
    const client = fakeClient({ invokeResult: { data: null, error: new Error('401') } })
    await attachSessionMirror(client, doc)
    expect(client.calls.invoke).toEqual([
      [CLONE_FN, { body: { access_token: 'at-only', refresh_token: undefined } }],
    ])
    expect(client.calls.refreshSession).toEqual([])
    expect(readMirror(doc, ACCESS_COOKIE)).toBe(null) // dead handoff never retries
  })
})

describe('boot redemption — legacy client (portability fallback)', () => {
  it('no persisted session + cookie present → redeems the token', async () => {
    const doc = fakeDoc()
    writeMirror(doc, 'handoff')
    const client = fakeClient({ refreshResult: { data: { session: { user: {} } }, error: null } })
    await attachSessionMirror(client, doc)
    expect(client.calls.refreshSession).toEqual([{ refresh_token: 'handoff' }])
    expect(readMirror(doc)).toBe('handoff') // live token stays (rotation arrives via events)
  })

  it('persisted session present → never touches refreshSession', async () => {
    const doc = fakeDoc()
    writeMirror(doc, 'stale')
    const client = fakeClient({ session: { user: {} } })
    await attachSessionMirror(client, doc)
    expect(client.calls.refreshSession).toEqual([])
  })

  it('no cookie → nothing to redeem', async () => {
    const client = fakeClient()
    await attachSessionMirror(client, fakeDoc())
    expect(client.calls.refreshSession).toEqual([])
  })

  it('rejected token is cleared, so a dead handoff never retries every boot', async () => {
    const doc = fakeDoc()
    writeMirror(doc, 'dead')
    const client = fakeClient({ refreshResult: { data: { session: null }, error: new Error('invalid') } })
    await attachSessionMirror(client, doc)
    expect(readMirror(doc)).toBe(null)
  })

  it('getSession blowing up leaves the app untouched (watchdog territory)', async () => {
    const doc = fakeDoc()
    writeMirror(doc, 'tok')
    const client = fakeClient()
    client.auth.getSession = async () => { throw new Error('network down') }
    await expect(attachSessionMirror(client, doc)).resolves.toBeUndefined()
  })

  it('without a document (SSR/tests) it is a no-op', async () => {
    const client = fakeClient()
    await expect(attachSessionMirror(client, null)).resolves.toBeUndefined()
  })
})
