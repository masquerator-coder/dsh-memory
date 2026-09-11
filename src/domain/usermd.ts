/**
 * user.md view model (design §8). `user.md` is a **view** over atomic facts —
 * one renderable export of the entity card, never an independent data source.
 * This module holds the shared types that let us render a card to Markdown
 * (`usermd-render`), parse an edited Markdown back to structured edits
 * (`usermd-parse`), and diff those edits against the store (`usermd-sync`).
 *
 * @module dsh-memory/domain/usermd
 */

/** A single content item parsed from the edited view. */
export interface UserMdLine {
  /** Canonical predicate group the line belongs to. */
  readonly predicate: string
  /** Human-readable group heading (may be blank for lines outside groups). */
  readonly heading?: string
  /** The line's content (without the leading bullet). */
  readonly content: string
}

/** The parsed result of an edited user.md document. */
export interface ParsedUserMd {
  /** Entity title parsed from the `#` heading, when present. */
  readonly entity?: string
  readonly lines: UserMdLine[]
}

/** One desired write-back action against the underlying facts. */
export type UserEditAction =
  | { readonly kind: 'add'; readonly line: UserMdLine }
  | { readonly kind: 'supersede'; readonly factId: string; readonly line: UserMdLine }
  | { readonly kind: 'archive'; readonly factId: string }
