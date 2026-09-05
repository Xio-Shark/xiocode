#!/usr/bin/env node

import { runImproveCli } from "./improve-cli.ts";

const code = await runImproveCli(process.argv.slice(2));
process.exitCode = code;
