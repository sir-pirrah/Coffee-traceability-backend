import { NextFunction, Request, Response } from "express";
import { AnyZodObject, ZodError } from "zod";
import { ApiError } from "@/utils/ApiError";

// Validates req.body / req.query / req.params against a Zod schema and
// replaces them with the parsed (and type-coerced) result.
export function validate(schema: AnyZodObject) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      req.body = parsed.body ?? req.body;
      req.query = parsed.query ?? req.query;
      req.params = parsed.params ?? req.params;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        throw ApiError.badRequest("Validation failed", err.flatten().fieldErrors);
      }
      throw err;
    }
  };
}
