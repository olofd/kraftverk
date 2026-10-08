/*
  A home's configuration (docs/CONFIG.md): an export, an import's plan with
  what it needs, its answers and what it applied, and the copy kept beside
  the database.
*/

/** A problem in a configuration file: what, the path to it, and its line and column when there is text (docs/CONFIG.md). */
export type ConfigProblem = { message: string; path: (string | number)[]; line: number | null; column: number | null };
/** What an import does to one device or automation: added, brought back (a device you removed, with its history), changed — and how — left as it is, or removed. */
export type ImportItem = { key: string; name: string; action: 'add' | 'restore' | 'change' | 'same' | 'remove'; changes: string[] };
/**
 * What importing a file would do, nothing yet done (`POST /config/plan`):
 * its problems, each with its line — none, and it can be applied — what
 * becomes of each device, link, automation and home value, and what it still
 * needs to be applied: a passphrase for its sealed secrets, a secret it does
 * not carry, a device of yours for a role naming one you do not have, and a
 * yes to what it would set acting on its own or remove.
 */
export type ImportPlan = {
  /** What `POST /config/apply` names it by, for 15 minutes; null when its problems stop it. */
  id: string | null;
  /** The version of the file, before it was brought to this one. */
  from: number | null;
  problems: ConfigProblem[];
  devices: ImportItem[];
  links: { kind: string; from: string; to: string; action: 'add' | 'same' | 'remove' }[];
  automations: ImportItem[];
  /** What the file changes of the family itself — its name, kind, language — each in words; empty when nothing. */
  family: string[];
  /** Its homes, by key: added, changed — where it is, its clock — or the same. One the file does not name is left as it is: leaving a home is a person's to do. */
  homes: ImportItem[];
  /** Its labels, by key: added, renamed, or the same. One the file does not name is left. */
  labels: ImportItem[];
  /** Its zones, by key: added, moved or renamed, or the same. One the file does not name is left. */
  zones: ImportItem[];
  /** Its own modes, by key: added, renamed, or the same. One the file does not name is left. */
  modes: ImportItem[];
  /** Its people, by their ids: added to the family, a newer copy of who they are, their role and what it calls them. One the file does not name stays. */
  people: ImportItem[];
  /** Each home's values the file changes, by the home's key. */
  policy: { home: string; name: string; label: string; before: number | null; after: number }[];
  needs: {
    /** It carries secrets sealed with a passphrase, and none was given — or the one given does not open them. */
    passphrase: 'missing' | 'wrong' | null;
    /** A secret a way to reach a device needs, which the file does not carry and the device does not have: given as `secrets["device.field"]`. */
    secrets: { device: string; deviceName: string; field: string; title: string }[];
    /** A role naming a device you do not have: one of yours, as `rebind["automation.role"] = "device-key.part"`. */
    rebind: { automation: string; role: string; label: string; wanted: string; candidates: { use: string; name: string }[] }[];
    /** What applying it asks a yes to: an automation set acting on its own, devices and automations removed. */
    confirm: string[];
  };
  notes: string[];
};
/** What applying a plan did. */
export type ImportApplied = {
  /** `restored`: devices you had removed, brought back with their history. */
  devices: { added: string[]; restored: string[]; changed: string[]; removed: string[] };
  automations: { added: string[]; changed: string[]; removed: string[] };
  links: { added: number; removed: number };
  /** Whether the family's name, kind or language was set from the file. */
  family: boolean;
  homes: { added: string[]; changed: string[] };
  labels: { added: string[]; changed: string[] };
  zones: { added: string[]; changed: string[] };
  modes: { added: string[]; changed: string[] };
  people: { added: string[]; changed: string[] };
  /** Each value set, as "home-key.name". */
  policy: string[];
  /** What was done otherwise than the file says — restoring, an automation kept turned off, a device left out — each in words. */
  notes: string[];
};
/** `POST /config/export`: everything, or the devices and automations chosen by key; secrets left out, sealed with a passphrase, or plain where allowed. */
export type ConfigExportRequest = {
  devices?: string[];
  automations?: string[];
  secrets: 'none' | 'sealed' | 'plain';
  passphrase?: string;
  /** Your account's password, which a server with accounts asks for before any secret leaves: a borrowed session is not enough. */
  yourPassword?: string;
};
/** An export: the file, and what could not go in (also in its heading). */
export type ConfigExported = { text: string; notes: string[] };
/** `POST /config/apply`: a plan, with the answers it asked for. */
export type ImportAnswers = {
  plan: string;
  /** Only these, by key; everything the plan has when not given. */
  include?: { devices?: string[]; automations?: string[] };
  /** A secret the file did not carry: "device.field" → its value. */
  secrets?: Record<string, string>;
  /** A role naming a device you do not have: "automation.role" → "device-key.part". */
  rebind?: Record<string, string>;
  confirmation?: string;
};
/** What the server's last restore from the configuration kept beside its database did. */
export type ConfigRestored = { at: string; from: string; applied: ImportApplied | null; problems: string[] };
/** `GET /config/snapshot`: the configuration kept beside the database — where, when it was last written, and what restoring it last did. */
export type ConfigSnapshotView = { path: string | null; writtenAt: string | null; restored: ConfigRestored | null };
