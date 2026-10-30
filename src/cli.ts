#!/usr/bin/env node
import { Command } from "commander";
import { formatInitReport, runInit } from "./init.js";
import { formatRemoveReport, runRemove } from "./remove.js";
import { formatScanReport, runScan } from "./scan.js";
import { startWatch } from "./watch.js";

const program = new Command();

program
  .name("agent-tripwire")
  .description(
    "Plant non-functional decoy credentials and alert when a coding agent reads them",
  )
  .version("0.1.0");

program
  .command("init")
  .description("Plant project decoys and write the manifest")
  .option("--home", "Also plant home-level decoys (~/.aws, ~/.npmrc area)")
  .action(async (opts: { home?: boolean }) => {
    const report = await runInit({ home: opts.home === true });
    console.log(formatInitReport(report));
    if (report.rolledBack.length > 0 || report.refusedTracked.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command("remove")
  .description("Delete Tripwire-created decoys whose hashes still match")
  .option("--home", "Also remove home-level decoys")
  .option("--dry-run", "Print the plan without deleting or writing")
  .action(async (opts: { home?: boolean; dryRun?: boolean }) => {
    const report = await runRemove({
      home: opts.home === true,
      dryRun: opts.dryRun === true,
    });
    console.log(formatRemoveReport(report));
  });

program
  .command("scan")
  .description(
    "One-shot pass over known logs; exit 1 if any decoy token was found",
  )
  .action(async () => {
    const report = await runScan();
    console.log(formatScanReport(report));
    process.exitCode = report.exitCode;
  });

program
  .command("watch")
  .description(
    "Watch agent logs in the foreground and print alerts on decoy hits",
  )
  .action(async () => {
    const handle = await startWatch({
      onHit: (hit) => {
        // Run 3: stdout only (token label + file). Desktop alerts are Run 4.
        // Never print the full token.
        console.log(hit.alertLine);
      },
    });
    await handle.ready;
    console.log("tripwire: watching (Ctrl+C to stop)");
    const stop = async () => {
      await handle.close();
      process.exit(0);
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
    // Keep the process alive until signal.
    await new Promise(() => undefined);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
