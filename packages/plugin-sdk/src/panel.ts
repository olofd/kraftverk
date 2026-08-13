import type { CapabilityName, RelayState } from './capabilities.ts';
import type { ConfigValues } from './schema.ts';
import type { PluginHealth, SetupActionResult } from './plugin.ts';

/**
 * The contract for a plugin's own screen.
 *
 * Most plugins need no screen at all: the app renders their setup form, health
 * and facts from declarations alone. But some have something to show that no
 * generic renderer could — a live relay with a switch, a forecast chart, a
 * price curve — and that UI belongs to the plugin, not to the app.
 *
 * So a plugin package may ship a panel alongside its server code, and the app
 * picks it up at compile time. Three rules keep this from becoming a hole in
 * the architecture:
 *
 * 1. **A missing panel is invisible.** The generic screen is always sufficient;
 *    a panel adds, never replaces.
 * 2. **Panels are compile-time contributions**, never downloaded. An iOS build
 *    must not fetch and execute UI code, so a panel ships in a release or it
 *    does not exist.
 * 3. **A panel gets data and callbacks, not privileges.** Everything here goes
 *    through the same API the generic screen uses, so a panel cannot reach past
 *    the action gateway any more than a form can.
 *
 * These types deliberately name no React types: the SDK stays dependency-free,
 * and the app supplies the component typing when it builds its registry.
 */
export type PluginPanelProps = {
  pluginId: string;
  /** Live health, including the facts the card shows. */
  health: PluginHealth;
  /** Non-secret configuration, as saved. */
  config: ConfigValues;
  capabilities: readonly CapabilityName[];
  grants: readonly CapabilityName[];

  /** The grid relay's current state, when this plugin owns that resource. */
  relay?: (RelayState & { provider: string }) | null;
  /** True when this plugin is the active provider for its resource. */
  isActiveProvider: boolean;

  /** Runs one of the plugin's declared setup actions. */
  runAction: (actionId: string, input: ConfigValues) => Promise<SetupActionResult>;
  /** Saves configuration; the host validates and restarts the plugin. */
  saveConfig: (values: ConfigValues) => Promise<void>;
  /**
   * Asks the core to switch the grid relay.
   *
   * Goes through the action gateway exactly as the generic control does — the
   * grant, the dwell, the freshness checks and the two-stage verification all
   * still apply. A panel cannot bypass any of it.
   */
  switchRelay?: (on: boolean, reason: string) => Promise<{ outcome: string; detail: string }>;
  /** Re-reads everything after something changes. */
  refresh: () => Promise<void>;
};
