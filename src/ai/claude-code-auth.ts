/**
 * `graft auth`: sign-in for the claude-code provider, handed to Claude Code's
 * own flow.
 *
 * Graft never sees a credential here. `login` and `token` run `claude auth login`
 * and `claude setup-token` with the terminal handed straight to them, so the
 * browser flow, the stored sign-in and the printed token stay between the user
 * and Claude Code. `status` reads `claude auth status` and repeats only the
 * sign-in method and plan, never the email address or organization.
 */
import {
  childEnv,
  claudeBin,
  claudeCodeStatus,
  describeSignIn,
  notInstalledMessage,
  spawnInteractive,
  type ClaudeCodeStatus,
  type InteractiveRunner,
} from "./llm/claude-code.js";

export type AuthCommand = "login" | "status" | "token";

export interface AuthDeps {
  /** Default: {@link spawnInteractive}. Tests pass a fake. */
  interactive?: InteractiveRunner;
  /** Default: {@link claudeCodeStatus}. */
  status?: () => Promise<ClaudeCodeStatus>;
  env?: NodeJS.ProcessEnv;
  /** Lines for stdout and stderr. Default: console. */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Run one `graft auth` subcommand; resolves to the process exit code. */
export async function runAuth(cmd: AuthCommand, deps: AuthDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const bin = claudeBin(env);
  const interactive = deps.interactive ?? spawnInteractive;
  const status = deps.status ?? (() => claudeCodeStatus({ bin, env }));
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  /** Hand the terminal to `claude <args>`; null when it is not installed. */
  const handOff = async (args: string[]): Promise<number | null> => {
    try {
      return await interactive(bin, args, childEnv(env));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  };

  switch (cmd) {
    case "login": {
      err(`→ running \`${bin} auth login\`: Claude Code's own sign-in. Graft never sees your credentials.`);
      const code = await handOff(["auth", "login"]);
      if (code === null) {
        err(`✗ ${notInstalledMessage(bin)}`);
        return 1;
      }
      if (code !== 0) {
        err(`✗ \`${bin} auth login\` exited with code ${code}`);
        return code;
      }
      out(`✓ Claude Code: ${describeSignIn(await status())}. \`graft build --deep --provider claude-code\` runs on it.`);
      return 0;
    }

    case "status": {
      const s = await status();
      if (!s.installed || s.error) {
        err(`✗ ${s.error ?? notInstalledMessage(bin)}`);
        return 1;
      }
      out(`Claude Code: ${describeSignIn(s)}`);
      if (s.authMethod) out(`  auth method   ${s.authMethod}`);
      if (s.apiProvider) out(`  api provider  ${s.apiProvider}`);
      if (s.subscriptionType) out(`  subscription  ${s.subscriptionType}`);
      if (!s.loggedIn) {
        err("  run `graft auth login` to sign in");
        return 1;
      }
      if (s.apiKeySource) err(`  ⚠ unset ${s.apiKeySource} to run on your Claude subscription instead`);
      return 0;
    }

    case "token": {
      err(
        `→ running \`${bin} setup-token\`: Claude Code creates a long-lived sign-in token for machines ` +
          "that cannot open a browser (CI, a remote box).",
      );
      err("  Graft does not read, store or print it: what follows comes straight from Claude Code.");
      const code = await handOff(["setup-token"]);
      if (code === null) {
        err(`✗ ${notInstalledMessage(bin)}`);
        return 1;
      }
      if (code !== 0) {
        err(`✗ \`${bin} setup-token\` exited with code ${code}`);
        return code;
      }
      err(
        "→ To use it, export it yourself where graft runs (a CI secret, a shell profile):\n" +
          "    export CLAUDE_CODE_OAUTH_TOKEN=<the token above>\n" +
          "  Claude Code reads it from the environment graft starts it in; graft passes that through untouched.",
      );
      return 0;
    }
  }
}
