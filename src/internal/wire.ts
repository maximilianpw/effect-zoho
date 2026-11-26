import * as Schema from 'effect/Schema'
import * as SchemaTransformation from 'effect/SchemaTransformation'

/*
 * Response schemas follow Zoho's OpenAPI documents, which are not exact about
 * types: a field documented as a string can arrive as a number, and a documented
 * list can arrive as one value.
 * Zoho marks an unset value with "" or null, or leaves it out. These codecs treat all
 * three alike: an unset property is removed from its object and an unset item from
 * its list, so a field is either absent or holds a value of its documented type.
 */

const unset = (value: unknown): boolean => value === null || (typeof value === 'string' && value.trim() === '')

const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])

// An identifier sent as a JSON number beyond 2^53 has already lost digits; passing it on would name another record.
const Exact = Scalar.check(Schema.makeFilter((value) =>
  typeof value !== 'number' || !Number.isInteger(value) || Number.isSafeInteger(value) || 'expected an integer small enough to be exact'))

export const Str = Exact.pipe(Schema.decodeTo(
  Schema.String,
  SchemaTransformation.transform({
    decode: (value) => String(value),
    encode: (value) => value,
  }),
))

const decimal = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

const NumberLike = Scalar.check(Schema.makeFilter((value) =>
  (typeof value === 'number' && Number.isFinite(value))
  || (typeof value === 'string' && decimal.test(value.trim()))
  || 'expected a number or numeric string'))

export const Num = NumberLike.pipe(Schema.decodeTo(
  Schema.Number,
  SchemaTransformation.transform({
    decode: (value) => Number(value),
    encode: (value) => value,
  }),
))

const BooleanLike = Scalar.check(Schema.makeFilter((value) =>
  typeof value === 'boolean' || value === 'true' || value === 'false' || 'expected a boolean'))

export const Bool = BooleanLike.pipe(Schema.decodeTo(
  Schema.Boolean,
  SchemaTransformation.transform({
    decode: (value) => value === true || value === 'true',
    encode: (value) => value,
  }),
))

/** A value Zoho documents without a type, or as an object without properties. */
export const Any = Schema.Unknown

export const Arr = <S extends Schema.Top>(item: S) =>
  Schema.Unknown.pipe(Schema.decodeTo(
    Schema.Array(item),
    SchemaTransformation.transform({
      decode: (value): ReadonlyArray<unknown> =>
        Array.isArray(value) ? value.filter((each) => !unset(each)) : unset(value) ? [] : [value],
      encode: (value): unknown => value,
    }),
  ))

const withoutUnset = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, each]) => !unset(each)))
    : value

/** An object whose unset properties are removed before `schema` decodes it. */
export const Obj = <S extends Schema.Top>(schema: S) =>
  Schema.Unknown.pipe(Schema.decodeTo(
    schema,
    SchemaTransformation.transform({
      decode: (value) => withoutUnset(value) as S['Encoded'],
      encode: (value): unknown => value,
    }),
  ))

export const Struct = <Fields extends Schema.Struct.Fields>(fields: Fields) => Obj(Schema.Struct(fields))

/** A response documented with nothing but a result code, which keeps every other field Zoho sends. */
export const StructWithRest = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Obj(Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]))

export const field = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

export const str = Schema.optionalKey(Str)
export const num = Schema.optionalKey(Num)
export const bool = Schema.optionalKey(Bool)
export const any = Schema.optionalKey(Any)
