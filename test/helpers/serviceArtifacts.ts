/**
 * Parsers for the two service artefacts the adapters render. Tests assert on the parsed structure
 * (`KeepAlive`, `Restart=`) instead of grepping the renderer source, so a change that keeps the
 * words but breaks the shape still fails.
 */

export type PlistValue = string | number | boolean | PlistValue[] | PlistDictionary;
export interface PlistDictionary {
  [key: string]: PlistValue;
}

type Token = { kind: 'open' | 'close' | 'empty'; name: string; text?: string };

function tokenize(source: string): Token[] {
  const body = source.replace(/<\?xml[^>]*\?>/u, '').replace(/<!DOCTYPE[^>]*>/u, '');
  const tokens: Token[] = [];
  // Element tags with optional attributes (`<plist version="1.0">`) or a self-closing slash.
  const pattern = /<(\/?)([a-z]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/gu;
  let pendingText = '';
  for (const match of body.matchAll(pattern)) {
    if (match[4] !== undefined) {
      pendingText += match[4];
      continue;
    }
    const name = match[2]!;
    if (match[1] === '/') {
      tokens.push({ kind: 'close', name, text: pendingText });
    } else if (match[3] === '/') {
      tokens.push({ kind: 'empty', name });
    } else {
      tokens.push({ kind: 'open', name });
    }
    pendingText = '';
  }
  return tokens;
}

function decode(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

class PlistReader {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  private next(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error('plist ended unexpectedly');
    this.index += 1;
    return token;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private scalar(name: string): string {
    const close = this.next();
    if (close.kind !== 'close' || close.name !== name) {
      throw new Error(`plist <${name}> is not closed`);
    }
    return decode(close.text ?? '');
  }

  value(): PlistValue {
    const token = this.next();
    if (token.kind === 'empty') {
      if (token.name === 'true') return true;
      if (token.name === 'false') return false;
      throw new Error(`unsupported empty plist element <${token.name}/>`);
    }
    if (token.kind !== 'open') throw new Error(`unexpected plist token </${token.name}>`);
    switch (token.name) {
      case 'string':
        return this.scalar('string');
      case 'integer':
        return Number(this.scalar('integer'));
      case 'dict':
        return this.dictionary();
      case 'array':
        return this.array();
      default:
        throw new Error(`unsupported plist element <${token.name}>`);
    }
  }

  private dictionary(): PlistDictionary {
    const result: PlistDictionary = {};
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('plist <dict> is not closed');
      if (token.kind === 'close' && token.name === 'dict') {
        this.index += 1;
        return result;
      }
      const key = this.next();
      if (key.kind !== 'open' || key.name !== 'key') throw new Error('plist <dict> expects <key>');
      result[this.scalar('key')] = this.value();
    }
  }

  private array(): PlistValue[] {
    const result: PlistValue[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('plist <array> is not closed');
      if (token.kind === 'close' && token.name === 'array') {
        this.index += 1;
        return result;
      }
      result.push(this.value());
    }
  }

  root(): PlistDictionary {
    const plist = this.next();
    if (plist.kind !== 'open' || plist.name !== 'plist') throw new Error('not a plist document');
    const value = this.value();
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('plist root must be a <dict>');
    }
    return value;
  }
}

/** Parses an XML property list whose root is a dictionary. */
export function parsePlist(source: string): PlistDictionary {
  return new PlistReader(tokenize(source)).root();
}

/** `[Section]` → key → every value in declaration order (`Environment=` repeats). */
export type SystemdUnit = Record<string, Record<string, string[]>>;

export function parseSystemdUnit(source: string): SystemdUnit {
  const unit: SystemdUnit = {};
  let section: Record<string, string[]> | null = null;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const heading = /^\[([A-Za-z]+)\]$/u.exec(line);
    if (heading) {
      section = unit[heading[1]!] ??= {};
      continue;
    }
    if (section === null) throw new Error(`unit setting outside a section: ${line}`);
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`unit line is not KEY=VALUE: ${line}`);
    const key = line.slice(0, separator);
    (section[key] ??= []).push(line.slice(separator + 1));
  }
  return unit;
}
