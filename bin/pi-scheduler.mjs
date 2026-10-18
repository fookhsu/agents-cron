#!/usr/bin/env node
/**
 * CLI entry point. Cron invokes this with a bare `node`, and the CLI itself is
 * TypeScript, so register the stripping loader before importing it: Node will
 * not strip types for files under `node_modules`, where an installed package
 * lives. There is no build and no `dist/`; the published package ships the
 * sources it runs.
 */
import { register } from "node:module";

register("./ts-loader.mjs", import.meta.url);

const { main } = await import("../src/cli.ts");

process.exitCode = await main(process.argv.slice(2));
