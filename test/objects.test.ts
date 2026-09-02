import { describe, expect, it } from 'vitest';
import { asError, isRecord } from '../src/objects.js';

describe('isRecord', () => {
  it('accepts plain objects, prototype-less objects and class instances', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ key: 'value' })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date(0))).toBe(true);
  });

  it('rejects null, arrays, primitives and functions', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord(['value'])).toBe(false);
    expect(isRecord('text')).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(Symbol('s'))).toBe(false);
    expect(isRecord(() => undefined)).toBe(false);
  });

  it('narrows the type so properties can be read', () => {
    const value: unknown = { nested: { count: 1 } };
    if (!isRecord(value)) throw new Error('expected a record');
    expect(isRecord(value.nested) && value.nested.count).toBe(1);
  });
});

describe('asError', () => {
  it('returns an Error instance unchanged, subclasses included', () => {
    class Typed extends Error {}
    const plain = new Error('plain');
    const typed = new Typed('typed');
    expect(asError(plain)).toBe(plain);
    expect(asError(typed)).toBe(typed);
  });

  it('wraps every other value in an Error whose message is its string form', () => {
    expect(asError('text')).toBeInstanceOf(Error);
    expect(asError('text').message).toBe('text');
    expect(asError(42).message).toBe('42');
    expect(asError(undefined).message).toBe('undefined');
    expect(asError(null).message).toBe('null');
    expect(asError({ code: 'x' }).message).toBe('[object Object]');
  });
});
