#!/usr/bin/env node
import { Command } from "commander";
import { EXIT } from "./exit-codes.js";
import { formatInitReport, runInit } from "./init.js";
import { notifyHit } from "./notify.js";
import { formatRemoveReport, runRemove } from "./remove.js";
import { formatScanReport, runScan } from "./scan.js";
import { formatStatusReport, runStatus } from "./status.js";
import { runTestAlert } from "./test-alert.js";
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
      process.exitCode = EXIT.FAIL;
    } else {
      process.exitCode = EXIT.OK;
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
    process.exitCode = EXIT.OK;
  });

program
  .command("scan")
  .description(
    "One-shot pass over known logs; exit 1 if any decoy token was found",
  )
  .option("--no-notify", "Do not send desktop notifications")
  .action(async (opts: { notify?: boolean }) => {
    const notify = opts.notify !== false;
    const report = await runScan(
      notify ? { onHit: (hit) => notifyHit(hit) } : {},
    );
    console.log(formatScanReport(report));
    process.exitCode = report.exitCode;
  });

program
  .command("watch")
  .description(
    "Watch agent logs in the foreground and print alerts on decoy hits",
  )
  .option("--no-notify", "Do not send desktop notifications")
  .action(async (opts: { notify?: boolean }) => {
    const notify = opts.notify !== false;
    const handle = await startWatch({
      onHit: (hit) => {
        // Never print the full token (alertLine uses tw…last4).
        console.log(hit.alertLine);
        if (notify) {
          notifyHit(hit);
        }
      },
    });
    await handle.ready;
    console.log("tripwire: watching (Ctrl+C to stop)");
    const stop = async () => {
      await handle.close();
      process.exit(EXIT.OK);
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

program
  .command("status")
  .description(
    "List planted decoys, adapters, and recent hits (no full tokens)",
  )
  .option("--last <n>", "How many recent hits to show", "10")
  .action(async (opts: { last?: string }) => {
    const n = Number.parseInt(opts.last ?? "10", 10);
    const report = await runStatus({
      lastHits: Number.isFinite(n) && n >= 0 ? n : 10,
    });
    console.log(formatStatusReport(report));
    process.exitCode = EXIT.OK;
  });

program
  .command("test-alert")
  .description(
    "Fire one sample notification and stdout alert (no manifest/hits writes)",
  )
  .option("--no-notify", "Skip the desktop notification; print stdout only")
  .action((opts: { notify?: boolean }) => {
    const report = runTestAlert({ notify: opts.notify !== false });
    console.log(report.alertLine);
    if (report.error) {
      console.warn(`tripwire: ${report.error}`);
    }
    process.exitCode = report.exitCode;
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = EXIT.FAIL;
});
