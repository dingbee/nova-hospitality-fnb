/**
 * Installation state classification (PRODUCTIZATION-4, Phases B and P).
 *
 * The installer must never silently overwrite a customer installation. This
 * module turns filesystem/database facts into exactly one required action.
 */
export type InstallState = "fresh" | "existing" | "interrupted" | "foreign";

export type InstallAction = "install" | "upgrade" | "repair" | "abort";

export interface InstallFacts {
  /** Data directory / install marker present. */
  installMarkerPresent: boolean;
  /** Product database exists on the host. */
  databasePresent: boolean;
  /** Migration ledger rows found (0 when the database was never initialised). */
  migrationsApplied: number;
  /** Install id recorded by a previous run, if any. */
  installId?: string | null;
  /** Version recorded by a previous run, if any. */
  installedVersion?: string | null;
  /** A database with the product name exists but carries no NOVA marker. */
  unknownDatabaseOwner?: boolean;
}

export interface InstallDecision {
  state: InstallState;
  action: InstallAction;
  destructive: false;
  message: string;
}

export function classifyInstall(facts: InstallFacts): InstallDecision {
  if (facts.unknownDatabaseOwner) {
    return {
      state: "foreign",
      action: "abort",
      destructive: false,
      message:
        "A database with this name exists but was not created by NOVA Hospitality. Installation stopped; choose another database name or remove the conflict manually.",
    };
  }

  if (!facts.installMarkerPresent && !facts.databasePresent) {
    return { state: "fresh", action: "install", destructive: false, message: "No existing installation found." };
  }

  if (facts.databasePresent && facts.migrationsApplied > 0 && facts.installId) {
    return {
      state: "existing",
      action: "upgrade",
      destructive: false,
      message: `Existing installation ${facts.installId} (version ${facts.installedVersion ?? "unknown"}) detected. Run the upgrade workflow; the database will not be recreated.`,
    };
  }

  return {
    state: "interrupted",
    action: "repair",
    destructive: false,
    message:
      "A partial installation was found (install marker or database present, setup incomplete). Run repair to finish it; existing data is preserved.",
  };
}
