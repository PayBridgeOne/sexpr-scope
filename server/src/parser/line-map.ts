import { Position } from "./position";

/**
 * Maps byte/character offsets in a document to line/character coordinates.
 *
 * Pre-computes the offset of every line start once so that individual lookups
 * are O(log n). Newlines are treated as `\n`; a leading `\r` (CRLF) stays part
 * of the preceding line, which matches how LSP clients count columns.
 */
export class LineMap {
  private readonly lineStarts: number[];

  constructor(private readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) {
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid] <= clamped) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return {
      offset: clamped,
      line: low,
      character: clamped - this.lineStarts[low],
    };
  }
}
