#!/usr/bin/env node

import { runSetupCli } from "../../extensions/xio-setup/src/setup-cli.ts";

const code = await runSetupCli(process.argv.slice(2));
process.exitCode = code;
