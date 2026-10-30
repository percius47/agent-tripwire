#!/usr/bin/env node
import { Command } from "commander";
import { formatInitReport, runInit } from "./init.js";
import { formatRemoveReport, runRemove } from "./remove.js";

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
    if (report.refused || report.rolledBack.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command("remove")
  .description("Delete hash-matched decoys Tripwire created and clean exclude lines")
  .option("--home", "Also remove home-level decoys")
  .option("--dry-run", "Print the plan without deleting")
  .action(async (opts: { home?: boolean; dryRun?: boolean }) => {
    const report = await runRemove({
      home: opts.home === true,
      dryRun: opts.dryRun === true,
    });
    console.log(formatRemoveReport(report));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
