/**
 * A minimal shim for `react-native-ble-plx`, which this app treats as optional.
 *
 * Direct Bluetooth from a phone needs that library, but it is a native module:
 * it cannot run in Expo Go, and the app has to build and run for everyone who
 * has not installed it. Metro resolves it to an empty module when it is missing
 * (see `client/metro.config.js`) and `src/link/nativeBle.ts` checks at runtime,
 * so the only thing left to satisfy is the type checker.
 *
 * Declared here rather than depended on. It covers exactly what we call; if you
 * install the real package and need more of its API, extend this or delete it
 * and let the package's own types take over.
 */
declare module 'react-native-ble-plx' {
  export type Subscription = { remove(): void };

  export type Characteristic = {
    uuid: string;
    /** Base64 — the library never hands you bytes. */
    value: string | null;
  };

  export type Device = {
    id: string;
    name: string | null;
    localName: string | null;
    rssi: number | null;
    serviceUUIDs: string[] | null;
    connect(options?: { timeout?: number }): Promise<Device>;
    discoverAllServicesAndCharacteristics(): Promise<Device>;
    cancelConnection(): Promise<Device>;
    isConnected(): Promise<boolean>;
    services(): Promise<{ uuid: string }[]>;
    monitorCharacteristicForService(
      serviceUUID: string,
      characteristicUUID: string,
      listener: (error: Error | null, characteristic: Characteristic | null) => void
    ): Subscription;
    writeCharacteristicWithResponseForService(
      serviceUUID: string,
      characteristicUUID: string,
      base64Value: string
    ): Promise<Characteristic>;
  };

  export class BleManager {
    constructor(options?: Record<string, unknown>);
    state(): Promise<string>;
    onStateChange(listener: (state: string) => void, emitCurrentState?: boolean): Subscription;
    startDeviceScan(
      serviceUUIDs: string[] | null,
      options: { allowDuplicates?: boolean } | null,
      listener: (error: Error | null, device: Device | null) => void
    ): void;
    stopDeviceScan(): void;
    onDeviceDisconnected(deviceId: string, listener: () => void): Subscription;
    destroy(): void;
  }
}
