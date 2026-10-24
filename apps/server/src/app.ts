import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module.ts";
import type { AppOptions } from "./app.module.ts";
import { publicCors } from "./common/cors.ts";
import { hostGuard } from "./common/host.ts";
import { ApiExceptionFilter } from "./common/filter.ts";

export async function createApp(
  options: AppOptions,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(options),
    {
      bodyParser: false,
      logger: options.quiet ? false : ["error", "warn", "log"],
    },
  );
  // First, before anything reads the body: DNS-rebinding pages arrive with their own Host.
  app.use(hostGuard(options.config));
  app.use(publicCors(options.config.webOrigin));
  // The avatar is the biggest body (1 MB of image, base64 encoded); every other body is tiny.
  app.useBodyParser("json", { limit: "1500kb" });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.disable("x-powered-by");
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  return app;
}
