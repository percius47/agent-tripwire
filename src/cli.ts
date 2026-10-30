#!/usr/bin/env node
import { Command } from "commander";
import { formatInitReport, runInit } from "./init.js";

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
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
