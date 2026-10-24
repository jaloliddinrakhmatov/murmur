import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { apiError } from "./errors.ts";

export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "The request isn't valid";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Validates a body, query or parameter with a schema from the shared contract. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform {
  private readonly schema: S;
  constructor(schema: S) {
    this.schema = schema;
  }
  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success)
      throw apiError("bad-request", describeIssue(result.error));
    return result.data;
  }
}
