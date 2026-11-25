// Fake CLI and agent skill install commands (Settings, Integrations). Wired into fake-backend.ts.
type Handler = (args: Record<string, unknown>) => unknown;

export type FakeSkillStatus =
  | "installed"
  | "update_available"
  | "not_installed";

/** What is installed at boot, set as `window.aetherFakeIntegrations`. */
export interface FakeIntegrationsSeed {
  cli?: boolean;
  skill?: FakeSkillStatus;
}

declare global {
  interface Window {
    /** No seed: neither the CLI nor the skill is installed. */
    aetherFakeIntegrations?: FakeIntegrationsSeed;
  }
}

const CLI_PATH = "/opt/homebrew/bin/aether";

export function integrationsHandlers(): Record<string, Handler> {
  let cli = window.aetherFakeIntegrations?.cli ?? false;
  let skill = window.aetherFakeIntegrations?.skill ?? "not_installed";

  return {
    get_cli_status: () => ({ installed: cli, path: cli ? CLI_PATH : null }),
    install_cli: () => {
      cli = true;
      return CLI_PATH;
    },
    uninstall_cli: () => {
      cli = false;
      return null;
    },
    get_skill_status: () => skill,
    install_skill: () => {
      skill = "installed";
      return null;
    },
  };
}
