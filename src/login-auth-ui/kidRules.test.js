import { describe, it, expect } from 'vitest'
import {
  usernameProblem, passwordProblem, normalizeUsername, kidEmailOf, isUnder13, isKidUser,
} from './kidRules.js'

describe('usernameProblem', () => {
  it('accepts 3–16 letters / digits / underscore, any case', () => {
    expect(usernameProblem('mochi')).toBe(null)
    expect(usernameProblem('Mochi_Star99')).toBe(null)
    expect(usernameProblem('  abc  ')).toBe(null) // trimmed
    expect(usernameProblem('a'.repeat(16))).toBe(null)
  })
  it('rejects anything email-shaped first, with its own message', () => {
    expect(usernameProblem('kid@gmail.com')).toBe('username_at')
    expect(usernameProblem('@')).toBe('username_at')
  })
  it('rejects 7+ digits in a row (phone numbers)', () => {
    expect(usernameProblem('5551234567')).toBe('username_digits')
    expect(usernameProblem('star1234567')).toBe('username_digits')
    expect(usernameProblem('star123456')).toBe(null) // 6 in a row is fine
  })
  it('rejects bad length and characters', () => {
    expect(usernameProblem('')).toBe('username_empty')
    expect(usernameProblem('ab')).toBe('username_length')
    expect(usernameProblem('a'.repeat(17))).toBe('username_length')
    expect(usernameProblem('mochi star')).toBe('username_chars')
    expect(usernameProblem('mochi-star')).toBe('username_chars')
    expect(usernameProblem('もち')).toBe('username_length')
    expect(usernameProblem('もちもち')).toBe('username_chars')
  })
})

describe('passwordProblem', () => {
  it('needs 6–72 characters', () => {
    expect(passwordProblem('12345')).toBe('password_short')
    expect(passwordProblem('123456')).toBe(null)
    expect(passwordProblem('x'.repeat(73))).toBe('password_long')
  })
})

describe('kidEmailOf', () => {
  it('maps a username to the internal reserved-TLD address, case-insensitively', () => {
    expect(normalizeUsername(' MochiStar ')).toBe('mochistar')
    expect(kidEmailOf(' MochiStar ', 'kids.example.invalid')).toBe('mochistar@kids.example.invalid')
  })
})

describe('isUnder13', () => {
  it('splits at 13', () => {
    expect(isUnder13(12)).toBe(true)
    expect(isUnder13(13)).toBe(false)
    expect(isUnder13(1)).toBe(true)
    expect(isUnder13(40)).toBe(false)
  })
  it('accepts string values straight from <select>', () => {
    expect(isUnder13('12')).toBe(true)
    expect(isUnder13('13')).toBe(false)
  })
  it('treats garbage as a child', () => {
    expect(isUnder13('')).toBe(true)
    expect(isUnder13(undefined)).toBe(true)
  })
})

describe('isKidUser', () => {
  it('only trusts app_metadata.kid === true', () => {
    expect(isKidUser({ app_metadata: { kid: true } })).toBe(true)
    expect(isKidUser({ app_metadata: { kid: 'true' } })).toBe(false)
    expect(isKidUser({ user_metadata: { kid: true } })).toBe(false) // user-writable, never trusted
    expect(isKidUser(null)).toBe(false)
  })
})
