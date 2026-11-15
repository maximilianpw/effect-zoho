import { expect, it } from 'vitest'
import * as Books from '../src/books/index.ts'
import type { Operation } from '../src/books/index.ts'

const operations = Object.entries(Books)
  .filter(([name, value]) => /^[A-Z]/.test(name) && typeof value === 'object')
  .flatMap(([module, members]) => Object.entries(members as Record<string, unknown>)
    .filter(([, member]) => typeof member === 'function' && 'definition' in member)
    .map(([name, member]) => ({ module, name, definition: (member as Operation<unknown, undefined>).definition })))

it('exposes every operation in Zoho’s documents exactly once', () => {
  expect(operations).toHaveLength(885)
  expect(new Set(operations.map((operation) => operation.definition.id)).size).toBe(885)
})

it('gives every operation a resolvable path and at least one OAuth scope', () => {
  for (const { definition } of operations) {
    expect(definition.path, definition.id).toMatch(/^(\/(\{\w+\}|[\w.-]+))+$/)
    expect(definition.scopes.length, definition.id).toBeGreaterThan(0)
  }
})
