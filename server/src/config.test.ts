import { describe, expect, test } from 'bun:test';

import { loadConfig } from './config.ts';

describe('what a server reads from its environment', () => {
  test('nothing about transports: every installed one is available', () => {
    const config = loadConfig({ KRAFTVERK_TRANSPORTS: 'mqtt', STATION_DRIVER: 'sim' }, ['--driver=ble']) as Record<string, unknown>;
    expect(config.transports).toBeUndefined();
    expect(config.simulate).toBeUndefined();
  });

  test('writes to hardware are refused when asked, by flag or environment', () => {
    expect(loadConfig({}, []).readOnly).toBe(false);
    expect(loadConfig({}, ['--read-only']).readOnly).toBe(true);
    expect(loadConfig({ READ_ONLY: '1' }, []).readOnly).toBe(true);
  });

  test('raw frames only by their own name', () => {
    expect(loadConfig({ ALLOW_RAW_MODBUS: '1' }, []).allowRawFrames).toBe(false);
    expect(loadConfig({ ALLOW_RAW_FRAMES: '1' }, []).allowRawFrames).toBe(true);
  });
});
