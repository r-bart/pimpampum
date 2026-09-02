import type { MarkdownPage } from '../types.js';

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Pages Markdown by UTF-16 code units without splitting a surrogate pair: when
 * the window would end between the two halves of one code point, it grows by
 * one unit so the page never carries a lone surrogate.
 */
export function page(body: string, offsetCodeUnits: number, limitCodeUnits: number): MarkdownPage {
  let end = Math.min(offsetCodeUnits + limitCodeUnits, body.length);
  if (
    end > offsetCodeUnits &&
    end < body.length &&
    isHighSurrogate(body.charCodeAt(end - 1)) &&
    isLowSurrogate(body.charCodeAt(end))
  ) {
    end += 1;
  }
  return {
    body: body.slice(offsetCodeUnits, end),
    offsetCodeUnits,
    totalCodeUnits: body.length,
    sizeBytes: Buffer.byteLength(body, 'utf8'),
    hasMore: end < body.length,
  };
}
