import * as Schema from 'effect/Schema'
import * as SchemaTransformation from 'effect/SchemaTransformation'

const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])
type Scalar = typeof Scalar.Type

const unset = (value: Scalar): boolean => value === null || (typeof value === 'string' && value.trim() === '')

const Exact = Scalar.check(Schema.makeFilter((value) =>
  typeof value !== 'number' || !Number.isInteger(value) || Number.isSafeInteger(value) || 'expected an integer small enough to be exact'))

export const Str = Exact.pipe(Schema.decodeTo(
  Schema.NullOr(Schema.String),
  SchemaTransformation.transform({
    decode: (value) => (value === null ? null : String(value)),
    encode: (value) => value,
  }),
))

const decimal = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

const NumberLike = Scalar.check(Schema.makeFilter((value) =>
  unset(value)
  || (typeof value === 'number' && Number.isFinite(value))
  || (typeof value === 'string' && decimal.test(value.trim()))
  || 'expected a number or numeric string'))

export const Num = NumberLike.pipe(Schema.decodeTo(
  Schema.NullOr(Schema.Number),
  SchemaTransformation.transform({
    decode: (value) => (unset(value) ? null : Number(value)),
    encode: (value) => value,
  }),
))

const BooleanLike = Scalar.check(Schema.makeFilter((value) =>
  unset(value) || typeof value === 'boolean' || value === 'true' || value === 'false' || 'expected a boolean'))

export const Bool = BooleanLike.pipe(Schema.decodeTo(
  Schema.NullOr(Schema.Boolean),
  SchemaTransformation.transform({
    decode: (value) => (unset(value) ? null : value === true || value === 'true'),
    encode: (value) => value,
  }),
))

export const Any = Schema.Unknown

export const Arr = <S extends Schema.Top>(item: S) =>
  Schema.Unknown.pipe(Schema.decodeTo(
    Schema.Array(item),
    SchemaTransformation.transform({
      decode: (value): ReadonlyArray<unknown> => (Array.isArray(value) ? value : value === null || value === '' ? [] : [value]),
      encode: (value): unknown => value,
    }),
  ))

export const field = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

export const str = Schema.optionalKey(Str)
export const num = Schema.optionalKey(Num)
export const bool = Schema.optionalKey(Bool)
export const any = Schema.optionalKey(Any)
