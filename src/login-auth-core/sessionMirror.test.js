// sessionMirror — the iOS Add-to-Home-Screen handoff cookies. Covers all three
// duties: keeping the cookies in lockstep with auth events, redeeming them on
// a boot whose localStorage session didn't survive the copy (only cookies do),
// and cloning an INDEPENDENT session through the clone-session Edge Function.
//
// The sharpest tests here are the ones asserting refreshSession is NOT called.
// Rotating the mirrored token revokes the whole family and logs out every
// container a day later, so a clone path that merely fails must degrade to "no
// handoff", never to "rotate and hope".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  attachSessionMirror,
  readMirror,
  writeMirror,
  MIRROR_COOKIE,
  ACCESS_COOKIE,
  CLONE_FN,
  HANDOFF_LOG_KEY,
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

// supabase-js shapes an Edge Function's non-2xx as a FunctionsHttpError whose
// .context is the raw Response; a transport failure carries no status at all.
// The body matters as much as the status — only the function's own
// {"error":"unauthorized"} condemns the tokens.
const httpError = (status, body = {}) =>
  Object.assign(new Error(`http ${status}`), { context: { status, json: async () => body } })

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

  // THE regression test. A CORS-blocked invoke (exactly what the 2026-07-24
  // domain rename produced: the deployed function still allowed the dead
  // origin) must NOT spend the mirrored refresh token — that rotation is what
  // revoked the family and logged the phone out of both containers days later.
  it('invoke blocked by CORS → no rotation, cookies survive for the next boot', async () => {
    const doc = cookies()
    const client = fakeClient({
      invokeResult: { data: null, error: new Error('Failed to fetch') }, // no status: transport
      refreshResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc)
    expect(client.calls.verifyOtp).toEqual([])
    expect(client.calls.refreshSession).toEqual([])
    expect(readMirror(doc)).toBe('rt-mir') // retried once the function is fixed
    expect(readMirror(doc, ACCESS_COOKIE)).toBe('at-mir')
  })

  it('invoke throwing (network down) is swallowed the same way', async () => {
    const doc = cookies()
    const client = fakeClient({
      invokeResult: new Error('fetch failed'),
      refreshResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc)
    expect(client.calls.refreshSession).toEqual([])
    expect(readMirror(doc)).toBe('rt-mir')
  })

  it('a 5xx is the function breaking, not the tokens → kept, still no rotation', async () => {
    const doc = cookies()
    const client = fakeClient({
      invokeResult: { data: null, error: httpError(500) },
      refreshResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc)
    expect(client.calls.refreshSession).toEqual([])
    expect(readMirror(doc)).toBe('rt-mir')
  })

  it('token_hash arrives but verifyOtp rejects → retried later, never rotated', async () => {
    const doc = cookies()
    const client = fakeClient({
      invokeResult: { data: { token_hash: 'hash1' }, error: null },
      verifyResult: { data: { session: null }, error: new Error('expired') },
      refreshResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc)
    expect(client.calls.verifyOtp.length).toBe(1)
    expect(client.calls.refreshSession).toEqual([])
    expect(readMirror(doc)).toBe('rt-mir')
  })

  it('a 401 IS the server rejecting the tokens → every mirror cookie is cleared', async () => {
    const doc = cookies()
    const client = fakeClient({ invokeResult: { data: null, error: httpError(401, { error: 'unauthorized' }) } })
    await attachSessionMirror(client, doc)
    expect(client.calls.refreshSession).toEqual([])
    expect(readMirror(doc)).toBe(null)
    expect(readMirror(doc, ACCESS_COOKIE)).toBe(null)
  })

  it('access cookie only (no refresh token): clone is attempted, nothing to rotate anyway', async () => {
    const doc = fakeDoc()
    writeMirror(doc, 'at-only', ACCESS_COOKIE)
    const client = fakeClient({ invokeResult: { data: null, error: httpError(401, { error: 'unauthorized' }) } })
    await attachSessionMirror(client, doc)
    expect(client.calls.invoke).toEqual([
      [CLONE_FN, { body: { access_token: 'at-only', refresh_token: undefined } }],
    ])
    expect(client.calls.refreshSession).toEqual([])
    expect(readMirror(doc, ACCESS_COOKIE)).toBe(null) // dead handoff never retries
  })

  it('allowRefreshFallback opts a rotation-free project back into the exchange', async () => {
    const doc = cookies()
    const client = fakeClient({
      invokeResult: { data: null, error: new Error('Failed to fetch') },
      refreshResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc, { allowRefreshFallback: true })
    expect(client.calls.refreshSession).toEqual([{ refresh_token: 'rt-mir' }])
  })
})

describe('same-origin transport', () => {
  const cookies = () => {
    const doc = fakeDoc()
    writeMirror(doc, 'rt-mir')
    writeMirror(doc, 'at-mir', ACCESS_COOKIE)
    return doc
  }
  const PROXY = { cloneEndpoint: '/api/clone-session', cloneApiKey: 'anon-jwt' }
  const stubFetch = (impl) => {
    const spy = vi.fn(impl)
    vi.stubGlobal('fetch', spy)
    return spy
  }
  afterEach(() => vi.unstubAllGlobals())

  it('is preferred over invoke, and carries the anon key the gateway wants', async () => {
    const doc = cookies()
    const fetchSpy = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ token_hash: 'h1' }) }))
    const client = fakeClient({
      invokeResult: { data: { token_hash: 'from-invoke' }, error: null },
      verifyResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc, PROXY)

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/clone-session')
    expect(init.headers.Authorization).toBe('Bearer anon-jwt')
    expect(JSON.parse(init.body)).toEqual({ access_token: 'at-mir', refresh_token: 'rt-mir' })
    expect(client.calls.invoke).toEqual([]) // never needed the cross-origin call
    expect(client.calls.verifyOtp).toEqual([{ type: 'magiclink', token_hash: 'h1' }])
  })

  it('a host that never shipped the rewrite (404) falls through to invoke', async () => {
    const doc = cookies()
    stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    const client = fakeClient({
      invokeResult: { data: { token_hash: 'h2' }, error: null },
      verifyResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc, PROXY)
    expect(client.calls.invoke.length).toBe(1)
    expect(client.calls.verifyOtp).toEqual([{ type: 'magiclink', token_hash: 'h2' }])
  })

  it('a 401 through the proxy is final — the direct call would only hear the same', async () => {
    const doc = cookies()
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }))
    const client = fakeClient({ invokeResult: { data: { token_hash: 'h3' }, error: null } })
    await attachSessionMirror(client, doc, PROXY)
    expect(client.calls.invoke).toEqual([])
    expect(client.calls.refreshSession).toEqual([])
    expect(readMirror(doc)).toBe(null) // dead tokens dropped
  })

  it('an endpoint that answers with HTML (SPA catch-all) is not mistaken for success', async () => {
    const doc = cookies()
    stubFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } }))
    const client = fakeClient({ invokeResult: { data: null, error: new Error('Failed to fetch') } })
    await attachSessionMirror(client, doc, PROXY)
    expect(client.calls.verifyOtp).toEqual([])
    expect(client.calls.refreshSession).toEqual([])
    expect(readMirror(doc)).toBe('rt-mir') // kept: nothing proved these tokens dead
  })

  it('the proxy alone is enough to clone — a client with no functions API still hands off', async () => {
    const doc = cookies()
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ token_hash: 'h4' }) }))
    const client = fakeClient({ verifyResult: { data: { session: { user: {} } }, error: null } })
    await attachSessionMirror(client, doc, PROXY)
    expect(client.calls.verifyOtp).toEqual([{ type: 'magiclink', token_hash: 'h4' }])
    expect(client.calls.refreshSession).toEqual([]) // and it did NOT fall back to rotating
  })
})

describe('handoff breadcrumb', () => {
  const store = new Map()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('records the outcome and a timestamp — and never a token', async () => {
    const doc = fakeDoc()
    writeMirror(doc, 'rt-secret')
    writeMirror(doc, 'at-secret', ACCESS_COOKIE)
    const client = fakeClient({ invokeResult: { data: null, error: new Error('Failed to fetch') } })
    await attachSessionMirror(client, doc)

    const note = store.get(HANDOFF_LOG_KEY)
    expect(note).toContain('UNREACHABLE')
    expect(note).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(note).not.toContain('rt-secret')
    expect(note).not.toContain('at-secret')
  })

  it('a successful clone is recorded too, so "no note" never reads as "it worked"', async () => {
    const doc = fakeDoc()
    writeMirror(doc, 'rt-mir')
    const client = fakeClient({
      invokeResult: { data: { token_hash: 'h1' }, error: null },
      verifyResult: { data: { session: { user: {} } }, error: null },
    })
    await attachSessionMirror(client, doc)
    expect(store.get(HANDOFF_LOG_KEY)).toContain('clone ok')
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
