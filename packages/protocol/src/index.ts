/**
 * Everything needed to talk to a Sydpower-stack power station.
 *
 * This package is the single source of truth for the protocol: framing, the
 * register map, the write whitelist, the decode, and the polling client. The
 * server imports it, and so does the app when it connects to a station directly
 * over Bluetooth. Neither owns a copy.
 *
 * It deliberately has no dependencies — no zod, no node built-ins, no Bluetooth
 * library — so it bundles into an Expo app as readily as it runs under Bun.
 * Anything stack-specific goes behind `StationTransport`.
 */

export * from './modbus.ts';
export * from './registers.ts';
export * from './diagnostics.ts';
export * from './station.ts';
export * from './types.ts';
export * from './ble.ts';
export * from './client.ts';
