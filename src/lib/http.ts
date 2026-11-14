import type { Request } from "express";

/**
 * Reads a required path parameter.
 *
 * Express 5 types `req.params` values as `string | string[] | undefined`, and
 * `noUncheckedIndexedAccess` makes that explicit. For a route declared with
 * `:id` the value is always a single string, so this narrows once instead of
 * at every use site.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") {
    throw new Error(`Route is missing the "${name}" path parameter`);
  }
  return value;
}
