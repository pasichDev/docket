import { finishAnyInterruptedRestore } from "./backup.js";
import { startWebServer, broadcastUpdate, createWebServer } from "./web/server.js";

export { broadcastUpdate, createWebServer, startWebServer };

// Before the first read of the store: see backup.ts. A dashboard that boots on a data
// directory with a half-applied restore would serve, and then write back, a mixture.
await finishAnyInterruptedRestore();
await startWebServer();
