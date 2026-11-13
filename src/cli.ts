#!/usr/bin/env node
import { Command } from "commander";
import { EXIT } from "./exit-codes.js";
import { resolveProjectRoot } from "./git-exclude.js";
import { formatIncidentsCli } from "./hook/run.js";
import { formatInitReport, runInit } from "./init.js";
import { notifyHit } from "./notify.js";
import { loadIncidents } from "./project-state.js";
import { formatRemoveReport, runRemove } from "./remove.js";
import { formatScanReport, runScan } from "./scan.js";
import { formatStatusReport, runStatus } from "./status.js";
import { runTestAlert } from "./test-alert.js";
import { startWatch } from "./watch.js";
import {
  activePause,
  confirmHumanPause,
  DEFAULT_PAUSE,
  parseDuration,
  pauseProject,
  resumeProject,
} from "./pause.js";

const program = new Command();

program
  .name("agent-tripwire")
  .description(
    "Plant decoy credentials and block/alert when Cursor or Claude Code touch them",
  )
  .version("0.2.1");

program
  .command("init")
  .description(
    "Plant project decoys, write project hooks (.cursor / .claude), and create .tripwire/",
  )
  .option("--home", "Also plant home-level decoys (~/.aws, ~/.npmrc area)")
  .action(async (opts: { home?: boolean }) => {
    const report = await runInit({ home: opts.home === true });
    console.log(formatInitReport(report));
    if (report.hookPathWarning) {
      console.error(`\n${report.hookPathWarning}`);
    }
    if (report.rolledBack.length > 0 || report.refusedTracked.length > 0) {
      process.exitCode = EXIT.FAIL;
    } else {
      process.exitCode = EXIT.OK;
    }
  });

program
  .command("remove")
  .description(
    "Remove decoys, strip project hooks, restore backups, and delete .tripwire/",
  )
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
  .command("pause")
  .description(
    "Snooze blocking in this project for a while (max 24h). Reads are still logged; resumes on its own.",
  )
  .option("--for <duration>", "How long, e.g. 15m, 2h, 1h30m", DEFAULT_PAUSE)
  .action(async (opts: { for?: string }) => {
    const { projectRoot } = resolveProjectRoot(process.cwd());
    const dur = opts.for ?? DEFAULT_PAUSE;
    if (parseDuration(dur) === null) {
      console.error(`Invalid duration "${dur}". Use e.g. 15m, 2h, 1h30m.`);
      process.exitCode = EXIT.FAIL;
      return;
    }
    const confirm = await confirmHumanPause();
    if (!confirm.ok) {
      console.error(confirm.reason);
      process.exitCode = EXIT.FAIL;
      return;
    }
    try {
      const state = await pauseProject(projectRoot, dur);
      console.log(
        `Tripwire paused in ${projectRoot} until ${new Date(state.until).toLocaleString()}. Nothing is blocked until then, but access is still logged. Run \`agent-tripwire resume\` to turn it back on now.`,
      );
      process.exitCode = EXIT.OK;
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = EXIT.FAIL;
    }
  });

program
  .command("resume")
  .description("End a pause now and turn blocking back on")
  .action(async () => {
    const { projectRoot } = resolveProjectRoot(process.cwd());
    const was = await activePause(projectRoot);
    await resumeProject(projectRoot);
    console.log(
      was
        ? `Tripwire resumed in ${projectRoot}. Blocking is back on.`
        : `Tripwire was not paused in ${projectRoot}. Blocking is on.`,
    );
    process.exitCode = EXIT.OK;
  });

program
  .command("incidents")
  .description("Show .tripwire/incidents.log (latest first)")
  .option("--severity <level>", "Filter by severity (high|medium|low|info)")
  .option("--limit <n>", "Max rows", "50")
  .action(async (opts: { severity?: string; limit?: string }) => {
    const { projectRoot } = resolveProjectRoot(process.cwd());
    const n = Number.parseInt(opts.limit ?? "50", 10);
    const incidents = await loadIncidents(projectRoot);
    console.log(
      formatIncidentsCli(incidents, {
        ...(opts.severity !== undefined ? { severity: opts.severity } : {}),
        limit: Number.isFinite(n) && n >= 0 ? n : 50,
      }),
    );
    process.exitCode = EXIT.OK;
  });

program
  .command("scan")
  .description(
    "One-shot pass over known logs; exit 1 if any decoy token is still present",
  )
  .option("--no-notify", "Do not send desktop notifications")
  .option(
    "--new-only",
    "Exit 1 only for hits not already recorded in hits.jsonl",
  )
  .action(async (opts: { notify?: boolean; newOnly?: boolean }) => {
    const notify = opts.notify !== false;
    const report = await runScan({
      newOnly: opts.newOnly === true,
      ...(notify ? { onHit: (hit) => notifyHit(hit) } : {}),
    });
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
