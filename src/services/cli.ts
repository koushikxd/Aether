import { invoke } from "@tauri-apps/api/core";

export interface CliStatus {
  installed: boolean;
  path: string | null;
}

export type SkillStatus = "installed" | "update_available" | "not_installed";

export async function getCliStatus(): Promise<CliStatus> {
  return invoke("get_cli_status");
}

export async function installCli(): Promise<string> {
  return invoke("install_cli");
}

export async function uninstallCli(): Promise<void> {
  return invoke("uninstall_cli");
}

export async function getSkillStatus(): Promise<SkillStatus> {
  return invoke("get_skill_status");
}

export async function installSkill(): Promise<void> {
  return invoke("install_skill");
}
