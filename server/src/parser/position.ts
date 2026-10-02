/**
 * Source positions and ranges used throughout the static model.
 *
 * Offsets are zero-based UTF-16 code-unit indices into the document text.
 * `line` / `character` are zero-based and match the Language Server Protocol
 * definition of a Position, so they can be handed to LSP without translation.
 */

export interface Position {
  readonly offset: number;
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export function rangeContainsOffset(range: Range, offset: number): boolean {
  return offset >= range.start.offset && offset < range.end.offset;
}
