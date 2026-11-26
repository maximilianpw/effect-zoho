import { expect, it } from 'vitest'
import * as Schema from 'effect/Schema'
import * as W from '../src/internal/wire.ts'

const decode = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownResult(schema as unknown as Schema.Codec<unknown>)

it.each([
  [W.Str, 982000000567114, '982000000567114'],
  [W.Str, false, 'false'],
  [W.Str, '', ''],
  [W.Num, '12.50', 12.5],
  [W.Num, 0, 0],
  [W.Bool, 'false', false],
  [W.Bool, true, true],
  [W.Arr(W.Str), ['a', 1], ['a', '1']],
  [W.Arr(W.Str), '2000000007037', ['2000000007037']],
  [W.Arr(W.Str), ['a', null, '', 'b'], ['a', 'b']],
  [W.Arr(W.Str), null, []],
  [
    W.Struct({ name: W.str, rate: W.num, active: W.bool, ids: W.field(W.Arr(W.Str)), kept: W.str }),
    { name: '', rate: ' ', active: null, ids: null, kept: 'x' },
    { kept: 'x' },
  ],
  [W.StructWithRest({ code: W.num }), { code: 0, note: '', extra: 1 }, { code: 0, extra: 1 }],
  [W.Num, '1e3', 1000],
])('decodes %# to the documented type', (schema, input, expected) => {
  const result = decode(schema)(input)
  expect(result._tag === 'Success' ? result.success : result).toEqual(expected)
})

it.each([
  [W.Num, 'twelve'],
  [W.Num, true],
  [W.Num, '0x10'],
  [W.Str, 2 ** 62],
  [W.Bool, 'yes'],
  [W.Str, { nested: true }],
  [W.Str, null],
  [W.Num, ''],
])('refuses %# rather than inventing a value', (schema, input) => {
  expect(decode(schema)(input)._tag).toBe('Failure')
})
