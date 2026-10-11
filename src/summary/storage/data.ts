/** Bounded inert copy before a trusted codec sees caller-owned data. Not a Proxy sandbox. */
export function copyBoundedCacheData(input: unknown, maximumBytes: number): unknown {
  let nodes = 0; let bytes = 0;
  const fail = (): never => { throw new Error('Invalid or oversized inert cache data'); };
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 32) fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { if (value.length > maximumBytes - bytes) fail(); bytes += Buffer.byteLength(value); if (bytes > maximumBytes) fail(); return value; }
    if (Array.isArray(value)) {
      if (value.length > 100000 || Reflect.ownKeys(value).length !== value.length + 1) fail();
      const result = [];
      for (let i = 0; i < value.length; i++) {
        const property = Object.getOwnPropertyDescriptor(value, String(i));
        if (!property || !('value' in property)) fail();
        result.push(copy(property!.value, depth + 1));
      }
      return result;
    }
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      const keys = Reflect.ownKeys(value); if (keys.length > 100) fail();
      const result: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (typeof key !== 'string') fail();
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !('value' in property)) fail();
        if ((key as string).length > maximumBytes - bytes) fail();
        bytes += Buffer.byteLength(key as string); if (bytes > maximumBytes) fail();
        result[key as string] = copy(property!.value, depth + 1);
      }
      return result;
    }
    return fail();
  }
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maximumBytes) fail();
  return result;
}
