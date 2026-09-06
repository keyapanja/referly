import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { DomainError } from "@referly/core";

export function errorHandler(err: Error, c: Context) {
  if (err instanceof DomainError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, err.httpStatus as 400);
  }
  if (err instanceof ZodError) {
    return c.json({ error: { code: "validation", message: "invalid request", details: { issues: err.issues } } }, 400);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: "http", message: err.message } }, err.status);
  }
  console.error(err);
  return c.json({ error: { code: "internal", message: "internal error" } }, 500);
}
