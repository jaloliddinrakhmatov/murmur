import { Logger } from "@nestjs/common";
import { createApp } from "./app.ts";
import { loadConfig } from "./config/env.ts";

const config = loadConfig();
const app = await createApp({ config });
// Loopback only: the server is not reachable from other machines until hosting is approved.
await app.listen(config.port, config.host);
new Logger("Murmur").log(`listening on http://${config.host}:${config.port}`);
