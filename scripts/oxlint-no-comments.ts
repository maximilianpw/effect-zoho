import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

interface LineColumn {
  readonly line: number
  readonly column: number
}

interface Comment {
  readonly type: 'Line' | 'Block' | 'Shebang'
  readonly value: string
  readonly loc: { readonly start: LineColumn; readonly end: LineColumn }
}

interface RuleContext {
  readonly cwd: string
  readonly filename: string
  readonly options: ReadonlyArray<{ readonly baseline?: string } | undefined>
  readonly sourceCode: { readonly getAllComments: () => ReadonlyArray<Comment> }
  readonly report: (diagnostic: { readonly message: string; readonly loc: { readonly start: LineColumn; readonly end?: LineColumn } }) => void
}

export type CommentBaseline = Readonly<Record<string, number>>

export const ignoreBaselineVariable = 'NO_COMMENTS_IGNORE_BASELINE'

const directive = /^\s*(@ts-expect-error\b|[#@]__PURE__|(?:oxlint|eslint)-(?:disable|enable)\b)|^\/\s*<reference\b/

const isBanned = (comment: Comment): boolean => comment.type !== 'Shebang' && !directive.test(comment.value)

const readBaseline = (path: string): CommentBaseline => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {})

const noComments = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Bans comments, except tool directives and the counts a ratchet baseline still allows.' },
    schema: [{ type: 'object', properties: { baseline: { type: 'string' } }, additionalProperties: false }],
  },
  create(context: RuleContext) {
    return {
      Program() {
        const banned = context.sourceCode.getAllComments().filter(isBanned)
        const baselineFile = context.options[0]?.baseline
        const allowed = baselineFile === undefined || process.env[ignoreBaselineVariable] === '1'
          ? 0
          : readBaseline(join(context.cwd, baselineFile))[relative(context.cwd, context.filename).split(sep).join('/')] ?? 0
        if (banned.length > allowed) {
          const budget = allowed === 0 ? '' : ` This file has ${banned.length}; ${baselineFile} allows ${allowed}.`
          for (const comment of banned) {
            context.report({
              loc: comment.loc,
              message: `Comment. Say it in a name, a type or an error message, or record the decision in docs/adr.${budget}`,
            })
          }
        } else if (banned.length < allowed) {
          context.report({
            loc: { start: { line: 1, column: 0 } },
            message: `${baselineFile} allows ${allowed} comments but this file has ${banned.length}. Run \`bun run comments baseline\` to lower it.`,
          })
        }
      },
    }
  },
}

export default {
  meta: { name: 'local' },
  rules: { 'no-comments': noComments },
}
