import { renderStatsWidget } from "./format.js";
import { readStore } from "./storage.js";

/**
 * The standalone widget entry point (`npm run stats`, and shell prompts that call
 * `node dist/stats.js`). Rendering lives in format.ts so this and the `docket stats` CLI
 * command can't drift — they already had, once.
 */
async function main() {
  process.stdout.write(renderStatsWidget(await readStore()) + "\n");
}

main().catch((err) => {
  console.error("docket stats failed:", err);
  process.exit(1);
});
