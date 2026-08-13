import type { ComponentType } from 'react';
import type { PluginPanelProps } from '@kraftverk/plugin-sdk';

import TuyaPanel from '@kraftverk/plugin-tuya-local-grid-relay/ui/panel';

/**
 * Plugin-supplied screens, bound at compile time.
 *
 * This file is the *entire* coupling between the app and any particular plugin,
 * and it is deliberately a list of imports rather than a lookup: an app store
 * build must not fetch and execute UI code, so a panel ships in a release or it
 * does not exist. That is the constraint the whole extension design is shaped
 * around.
 *
 * Everything else about a plugin — its settings, its setup wizard, its health,
 * the facts on its card — is rendered from declarations, so a plugin with no
 * entry here is fully usable. A panel adds; it never replaces.
 */
const PANELS: Record<string, ComponentType<PluginPanelProps>> = {
  'com.tuya-local.grid-relay': TuyaPanel,
};

export const panelFor = (pluginId: string): ComponentType<PluginPanelProps> | null =>
  PANELS[pluginId] ?? null;
