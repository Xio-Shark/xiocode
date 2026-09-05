import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expandHome, parseXioConfig } from "../../../src/cli/config-parser.ts";
import { targetApiKeyEnv } from "../../../src/cli/env-setup.ts";
import {
  SecretEnvironment,
  buildChildEnv,
  NETWORK_TLS_ENV_NAMES,
} from "../../../src/runtime/secret-environment.ts";
import {
  pinModelInConfig,
  resolvePinnedIdentity,
} from "./eval-identity.ts";

import type { PinnedEvalIdentity } from "./eval-identity.ts";

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
  const child = buildChildEnv(parent, {
    includeNetworkTls: true,
    extraNames: [...NETWORK_TLS_ENV_NAMES, "XIO_EVAL_ROOT", "XIO_EVAL_PRICE_TABLE"],
    overrides: {
      [apiKeyEnv]: apiKeyValue,
    },
    // Selected key is an intentional override — do not reject it as a known secret.
    rejectKnownSecrets: false,
  });
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
  const store = await SecretEnvironment.create({
    env,
    providers: parsed.xio.providers,
  });
  const sourceEnv = provider.apiKeyEnv ?? targetApiKeyEnv(provider);
  const targetEnv = targetApiKeyEnv(provider);
  const value = store.resolveExplicitReference(identity.api_key_env)
    ?? store.resolveExplicitReference(sourceEnv)
    ?? store.resolveExplicitReference(targetEnv);
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
