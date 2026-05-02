#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createLogTapServer, resolveOptions, buildSummary, summaryToMarkdown, writeSummaryFiles } from "../src/server/index.ts";
import { clearProject } from "../src/server/store.ts";
import { addArtifacts } from "../src/server/artifacts.ts";
import { parseBytes } from "../src/shared/bytes.ts";

const argv = process.argv.slice(2);
const command = argv[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

async function main() {
  switch (command) {
    case "start": return runStart();
    case "summary": return runSummary();
    case "tail": return runTail();
    case "clear": return runClear();
    case "artifacts": return runArtifacts();
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function parseStart() {
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      root: { type: "string" },
      "max-project-size": { type: "string" },
      "max-total-size": { type: "string" },
      sourcemaps: { type: "boolean" },
      dist: { type: "string" },
      token: { type: "string" },
      cors: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });
  return { values, positionals };
}

async function runStart() {
  const { values } = parseStart();

  const opts = resolveOptions({
    port: values["port"] ? parseInt(values["port"] as string, 10) : undefined,
    host: values["host"] as string | undefined,
    rootDir: values["root"] as string | undefined,
    maxProjectLogBytes: values["max-project-size"]
      ? parseBytes(values["max-project-size"] as string)
      : undefined,
    maxAllProjectsBytes: values["max-total-size"]
      ? parseBytes(values["max-total-size"] as string)
      : undefined,
    ingestToken: values["token"] as string | undefined,
    corsOrigins: values["cors"] ? (values["cors"] as string).split(",") : ["*"],
    sourcemaps: values["sourcemaps"]
      ? {
          enabled: true,
          watchDirs: values["dist"] ? [values["dist"] as string] : [],
        }
      : undefined,
  });

  const server = createLogTapServer(opts);
  await server.start();

  process.on("SIGINT", () => {
    console.log("\n[LogTap] Shutting down...");
    Promise.resolve(server.stop()).then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    Promise.resolve(server.stop()).then(() => process.exit(0));
  });
}

async function runSummary() {
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      project: { type: "string" },
      since: { type: "string" },
      root: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
  });

  const projectId = (values["project"] as string | undefined) ?? "default.dev";
  const rootDir = (values["root"] as string | undefined) ?? ".agent/logtap";
  const since = values["since"] as string | undefined;
  const asJson = values["json"] as boolean | undefined;

  const summary = buildSummary(rootDir, projectId, since);
  const md = summaryToMarkdown(summary);
  writeSummaryFiles(rootDir, projectId, summary, md);

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(md);
  }
}

async function runTail() {
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      project: { type: "string" },
      root: { type: "string" },
      n: { type: "string" },
      level: { type: "string" },
    },
    strict: false,
  });

  const projectId = (values["project"] as string | undefined) ?? "default.dev";
  const rootDir = (values["root"] as string | undefined) ?? ".agent/logtap";
  const n = Math.min(parseInt((values["n"] as string | undefined) ?? "200", 10), 1000);
  const level = values["level"] as string | undefined;

  const { readEvents } = await import("../src/server/store.ts");
  let events = readEvents(rootDir, projectId).slice(-n);
  if (level) events = events.filter(e => e.level === level);

  for (const e of events) {
    console.log(JSON.stringify(e));
  }
}

async function runClear() {
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      project: { type: "string" },
      root: { type: "string" },
    },
    strict: false,
  });

  const projectId = (values["project"] as string | undefined) ?? "default.dev";
  const rootDir = (values["root"] as string | undefined) ?? ".agent/logtap";

  clearProject(rootDir, projectId);
  console.log(`[LogTap] Cleared logs for project: ${projectId}`);
}

async function runArtifacts() {
  const subcommand = argv[1];
  if (subcommand !== "add") {
    console.error(`Unknown artifacts subcommand: ${subcommand ?? "(none)"}`);
    console.error("Usage: logtap artifacts add <dist-dir> --project <id> --build-sha <sha>");
    process.exit(1);
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: {
      project: { type: "string" },
      "build-sha": { type: "string" },
      root: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const distDir = positionals[0];
  if (!distDir) {
    console.error("Usage: logtap artifacts add <dist-dir> --project <id> --build-sha <sha>");
    process.exit(1);
  }

  const projectId = (values["project"] as string | undefined) ?? "default.dev";
  const buildSha = (values["build-sha"] as string | undefined) ?? "unknown";
  const rootDir = (values["root"] as string | undefined) ?? ".agent/logtap";

  addArtifacts(rootDir, projectId, distDir, buildSha);
  console.log(`[LogTap] Artifacts registered: project=${projectId} build=${buildSha}`);
}

function printHelp() {
  console.log(`
logtap — client-side logging harness

Commands:
  start         Start the LogTap sidecar server
  tail          Print recent log events
  summary       Print project summary
  clear         Clear logs for a project
  artifacts add Register build artifacts for source-map support

Examples:
  logtap start --port 4319 --root .agent/logtap
  logtap start --dist ./dist --sourcemaps
  logtap tail --project billing-ui.dev --level error
  logtap summary --project billing-ui.dev --since 15m
  logtap clear --project billing-ui.dev
  logtap artifacts add ./dist --project billing-ui.dev --build-sha abc123
`.trim());
}

main().catch(err => {
  console.error("[LogTap]", err);
  process.exit(1);
});
