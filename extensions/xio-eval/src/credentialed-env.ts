import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expandHome, parseXioConfig } from "../../../src/cli/config-parser.ts";

import { applyCredentialsToEnv } from "../../../src/cli/credentials.ts";
import { setupProviderEnv, targetApiKeyEnv } from "../../../src/cli/env-setup.ts";
import {
  pinModelInConfig,
  resolvePinnedIdentity,
} from "./eval-identity.ts";

import type { PinnedEvalIdentity } from "./eval-identity.ts";

const PASSTHROUGH_ENV = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "XIO_HOME",
  "XIO_CONFIG",
  "XIO_EVAL_ROOT",
  "XIO_EVAL_PRICE_TABLE",
  "SystemRoot",
  "ComSpec",
  "PROCESSOR_ARCHITECTURE",
]);

export type CredentialedEvalSetup = Readonly<{
  identity: PinnedEvalIdentity;
  configContent: string;
  /** Env for the candidate child — only the selected provider key is disclosed. */
  childEnv: NodeJS.ProcessEnv;
  /** Exact secret value used for post-run artifact scans (never written to artifacts). */
  secretForScan: string;
}>;

export async function prepareCredentialedEvalSetup(options: Readonly<{
  env: NodeJS.ProcessEnv;
  modelRef?: string;
}>): Promise<CredentialedEvalSetup> {
  const configContent = await readUserConfig(options.env);
  const identity = resolvePinnedIdentity(configContent, options.modelRef);
  const pinnedConfig = pinModelInConfig(configContent, identity);
  const secret = await resolveSelectedProviderSecret(options.env, identity, pinnedConfig);
  const childEnv = buildChildEnvAllowlist(options.env, identity.api_key_env, secret);
  return {
    identity,
    configContent: pinnedConfig,
    childEnv,
    secretForScan: secret,
  };
}

export function buildChildEnvAllowlist(
  parent: NodeJS.ProcessEnv,
  apiKeyEnv: string,
  apiKeyValue: string,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (PASSTHROUGH_ENV.has(key) || key.startsWith("npm_") || key.startsWith("NPM_")) {
      child[key] = value;
    }
  }
  child[apiKeyEnv] = apiKeyValue;
  return child;
}

export function assertArtifactsOmitSecret(
  secret: string,
  artifacts: Readonly<Record<string, string>>,
): readonly string[] {
  if (!secret) return [];
  const hits: string[] = [];
  for (const [label, content] of Object.entries(artifacts)) {
    if (content.includes(secret)) {
      hits.push(`secret leaked into ${label}`);
    }
  }
  return hits;
}

async function resolveSelectedProviderSecret(
  env: NodeJS.ProcessEnv,
  identity: PinnedEvalIdentity,
  configContent: string,
): Promise<string> {
  const parsed = parseXioConfig(configContent);
  const provider = parsed.xio.providers[identity.provider];
  if (!provider) {
    throw new Error(`provider ${JSON.stringify(identity.provider)} missing after pin`);
  }
  const scratch: NodeJS.ProcessEnv = { ...env };
  await applyCredentialsToEnv(scratch, parsed.xio.providers);
  setupProviderEnv(parsed.xio.providers, scratch);
  const sourceEnv = provider.apiKeyEnv ?? targetApiKeyEnv(provider);
  const targetEnv = targetApiKeyEnv(provider);
  const value = scratch[identity.api_key_env] ?? scratch[sourceEnv] ?? scratch[targetEnv];
  if (!value || value.length === 0) {
    throw new Error(
      `missing credential for provider ${identity.provider} `
        + `(set ${identity.api_key_env} or run /connect; credentials are not passed on argv)`,
    );
  }
  return value;
}

async function readUserConfig(env: NodeJS.ProcessEnv): Promise<string> {
  const home = env.HOME ?? os.homedir();
  const configured = env.XIO_CONFIG ?? path.join(home, ".xiocode", "config.toml");
  const source = path.resolve(expandHome(configured));
  try {
    return await readFile(source, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    throw new Error(
      code === "ENOENT"
        ? `missing XioCode config: ${source}`
        : `cannot read XioCode config: ${String(error)}`,
    );
  }
}
