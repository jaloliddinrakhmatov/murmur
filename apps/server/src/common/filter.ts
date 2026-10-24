import { Catch, HttpException, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import type { ErrorCode } from "@murmur/account-api";
import { ApiError } from "./errors.ts";

function fromStatus(status: number): { code: ErrorCode; message: string } {
  switch (status) {
    case 401:
      return { code: "unauthorized", message: "Sign in to continue" };
    case 403:
      return { code: "forbidden", message: "You can't do that" };
    case 404:
      return { code: "not-found", message: "Not found" };
    case 413:
      return { code: "bad-request", message: "The request is too large" };
    default:
      return status >= 400 && status < 500
        ? { code: "bad-request", message: "The request isn't valid" }
        : { code: "server-error", message: "Something went wrong. Try again." };
  }
}

/** Every error leaves as the contract's ErrorBody; internals are never sent to clients. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status: number;
    let body: { code: ErrorCode; message: string };

    if (exception instanceof ApiError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = fromStatus(status);
    } else if (
      typeof exception === "object" &&
      exception !== null &&
      typeof (exception as { status?: unknown }).status === "number" &&
      (exception as { status: number }).status >= 400 &&
      (exception as { status: number }).status < 500
    ) {
      // Body-parser failures: malformed JSON, payload too large.
      status = (exception as { status: number }).status;
      body =
        status === 400
          ? {
              code: "bad-request",
              message: "The request body isn't valid JSON",
            }
          : fromStatus(status);
    } else {
      status = 500;
      body = {
        code: "server-error",
        message: "Something went wrong. Try again.",
      };
      // Only the error's name: messages from the database can contain user data.
      this.logger.error(
        `Unhandled error: ${exception instanceof Error ? exception.name : typeof exception}`,
      );
    }
    res.status(status).json(body);
  }
}
