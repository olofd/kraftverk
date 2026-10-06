/**
 * NIU's platform as an integration: scooters read from NIU's cloud with
 * their owner's account. `defineNiuScooter` builds a scooter type from what
 * one model says about itself; the generic scooter (`./scooter.ts`) is the
 * one a model nobody has described falls back to, and a device package
 * builds a model of its own with this (`@kraftverk/device-niu-uqi-gt`).
 */
export { defineNiuScooter, type NiuScooterModel } from './scooter.ts';
export type { ScooterLink, ScooterRaw, ScooterReport, ScooterSlow } from './link.ts';
