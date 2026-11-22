import { invoke } from "@tauri-apps/api/core";

export interface VaultStatus {
  /** The notes folder has a `.aether/vault/vault.json`. */
  hasVault: boolean;
  /** This device has the vault's key in its keychain. */
  unlocked: boolean;
  /** Private files this device cannot read (no key). 0 when unlocked. */
  lockedCount: number;
  /** Note ids marked private (the roots the user picked). */
  privateRoots: string[];
  /** Every private note id: the roots and all their sub-pages. */
  privateNoteIds: string[];
}

export function getVaultStatus(): Promise<VaultStatus> {
  return invoke("vault_status");
}

/** Creates the vault and its key, saves the key in the keychain, returns it as text. */
export function generateVaultKey(): Promise<string> {
  return invoke("vault_generate_key");
}

/** Checks `key` against the vault, saves it in the keychain, decrypts the private pages. */
export function enterVaultKey(key: string): Promise<VaultStatus> {
  return invoke("vault_enter_key", { key });
}

/** The key from the keychain, as text. */
export function showVaultKey(): Promise<string> {
  return invoke("vault_show_key");
}

/** Marks (`isPrivate: true`) or unmarks note ids as private roots. */
export function setNotesPrivate(
  ids: string[],
  isPrivate: boolean,
): Promise<VaultStatus> {
  return invoke("vault_set_private", { ids, isPrivate });
}
