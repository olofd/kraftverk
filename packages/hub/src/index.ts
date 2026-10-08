/**
 * A kraftverk home, running (README.md): what is installed, its devices held
 * and viewed, adding one, what is near, history, attention, the assistant's
 * world — wired from the shared packages over the ports the place it runs
 * gives it. Pure: the server runs one behind its HTTP API, the app one of its
 * own when it has no server (docs/PLAN-SHARED-CORE.md, phase 5).
 */

export * from './installed/types.ts';
export * from './installed/protocols.ts';
export * from './installed/transports.ts';
export * from './installed/from.ts';
export * from './devices/views.ts';
export * from './devices/nearby.ts';
export * from './nodes/held-readings.ts';
export * from './setup/service.ts';
export * from './history/sampler.ts';
export * from './history/changes.ts';
export * from './attention/attention.ts';
export * from './attention/freshness.ts';
export * from './assistant/world.ts';
export { answerMcp, type McpServerInfo } from './assistant/mcp.ts';
export * from './automations/devices.ts';
export * from './automations/drafts.ts';
export * from './configuration/configuration.ts';
export { exportConfig, homeVocabulary, type ConfigDeps, type ExportOptions, type Exported, type SecretsMode } from './configuration/export.ts';
export { keptPlan, PendingPlans, planImport, startWritten, writeImport, type ImportChoices, type ImportDeps, type ImportMode, type Written } from './configuration/import.ts';
export { restoreFrom, type Restored } from './configuration/restore.ts';
export * from './configuration/seal.ts';
export * from './node/hub.ts';
export { actorOf, familyApi, intentOf } from './api/index.ts';
export * from './follower/follower.ts';
export * from './personal/personal.ts';
export * from './node/lead.ts';
