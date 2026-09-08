import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { DomainError } from "@referly/core";
import type { AppEnv } from "./auth";

/**
 * Every error response carries the request id so a user can quote it and an operator can find
 * the matching log line. Expected errors (domain, validation, auth) are not logged here: the
 * request log line records their status. Unexpected ones go to the error reporter.
 */
export function errorHandler(err: Error, c: Context<AppEnv>) {
  const requestId = c.get("requestId");
  if (err instanceof DomainError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null }, requestId }, err.httpStatus as 400);
  }
  if (err instanceof ZodError) {
    return c.json({ error: { code: "validation", message: "invalid request", details: { issues: err.issues } }, requestId }, 400);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: "http", message: err.message }, requestId }, err.status);
  }
  const deps = c.get("deps");
  void deps?.reporter?.report(err, { origin: "http", requestId, path: c.req.path, method: c.req.method, tenantId: c.get("ctx")?.tenantId });
  return c.json({ error: { code: "internal", message: "internal error" }, requestId }, 500);
}
