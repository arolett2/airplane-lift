/** Placeholder for contract stubs that a module owner has not implemented yet. */
export function notImplemented<F extends (...args: never[]) => unknown>(what: string): F {
  return (() => {
    throw new Error(`Not implemented yet: ${what}`);
  }) as unknown as F;
}
