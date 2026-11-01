import path from "node:path";
import { generateSecretLike, generateToken } from "./token.js";
import { getHomeDir } from "./paths.js";

export interface DecoyPlan {
  /** Absolute path of the decoy file to create. */
  path: string;
  /** Relative label for reporting. */
  label: string;
  scope: "project" | "home";
  /** Build file contents; returns the unique token id embedded in the file. */
  render: () => { content: string; tokenId: string };
}

/** Project decoys: sibling files only — never real .env. */
export function projectDecoyPlans(projectRoot: string): DecoyPlan[] {
  return [
    {
      path: path.join(projectRoot, ".env.backup"),
      label: ".env.backup",
      scope: "project",
      render: () => {
        const tokenId = generateToken();
        const secret = generateSecretLike();
        const content = [
          "# Legacy CI credentials (rotated — do not use)",
          `AWS_ACCESS_KEY_ID=${tokenId}`,
          `AWS_SECRET_ACCESS_KEY=${secret}`,
          "",
        ].join("\n");
        return { content, tokenId };
      },
    },
    {
      path: path.join(projectRoot, ".env.local.old"),
      label: ".env.local.old",
      scope: "project",
      render: () => {
        const tokenId = generateToken();
        const secret = generateSecretLike();
        const content = [
          "# Old local overrides",
          `DATABASE_URL=postgres://tripwire:${tokenId}@localhost:5432/app`,
          `API_TOKEN=${secret}`,
          "",
        ].join("\n");
        return { content, tokenId };
      },
    },
    {
      path: path.join(projectRoot, "config", "secrets.legacy.json"),
      label: "config/secrets.legacy.json",
      scope: "project",
      render: () => {
        const tokenId = generateToken();
        const secret = generateSecretLike();
        const content = `${JSON.stringify(
          {
            _comment: "Legacy secrets archive — non-production",
            awsAccessKeyId: tokenId,
            awsSecretAccessKey: secret,
          },
          null,
          2,
        )}\n`;
        return { content, tokenId };
      },
    },
  ];
}

/** Home decoys: sibling .bak files only — never real credentials / .npmrc. */
export function homeDecoyPlans(): DecoyPlan[] {
  const home = getHomeDir();
  return [
    {
      path: path.join(home, ".aws", "credentials.bak"),
      label: "~/.aws/credentials.bak",
      scope: "home",
      render: () => {
        const tokenId = generateToken();
        const secret = generateSecretLike();
        const content = [
          "[legacy-ci]",
          `aws_access_key_id = ${tokenId}`,
          `aws_secret_access_key = ${secret}`,
          "",
        ].join("\n");
        return { content, tokenId };
      },
    },
    {
      path: path.join(home, ".npmrc.bak"),
      label: "~/.npmrc.bak",
      scope: "home",
      render: () => {
        const tokenId = generateToken();
        const content = [
          "; legacy registry auth (rotated)",
          `//registry.npmjs.org/:_authToken=${tokenId}`,
          "",
        ].join("\n");
        return { content, tokenId };
      },
    },
  ];
}

/** Paths that must never be opened for writing by Tripwire. */
export const FORBIDDEN_WRITE_PATHS = (
  projectRoot: string,
  home: string = getHomeDir(),
): string[] => [
  path.join(projectRoot, ".env"),
  path.join(home, ".aws", "credentials"),
  path.join(home, ".npmrc"),
];
