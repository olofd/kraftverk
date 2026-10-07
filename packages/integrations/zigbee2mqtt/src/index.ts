/**
 * Zigbee through Zigbee2MQTT, as a platform (docs/PLAN-ZIGBEE.md). See
 * docs/ADDING-A-DEVICE.md.
 *
 * The one place kraftverk meets Zigbee2MQTT: how it is spoken to over this
 * server's broker (`./protocol/`), the coordinator it drives — a gateway, its
 * devices and groups its members — and the generic types every Zigbee device
 * is offered as, a shelf each, describing itself from what it exposes. A
 * product's own package, built on this, may say more of one: it reads its
 * device through the link (`ZigbeeLink`).
 */

export type { FirmwareCalls, MemberAbout, MemberEvent, ZigbeeLink } from './link.ts';
export { defineZigbeeType, type ZigbeeTypeSpec } from './zigbee-type.ts';
export { playedZigbee2Mqtt, type PlayedZigbee2Mqtt } from './played.ts';
