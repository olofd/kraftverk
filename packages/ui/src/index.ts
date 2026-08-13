/**
 * The pieces every screen is built from, wherever that screen lives.
 *
 * These moved out of the app for one reason: a device package must be able to
 * draw its own screens, and it cannot import from the app that renders it. So
 * the primitives sit here, the app depends on them, and so does every device
 * package — which is what makes "the app is a shell" true rather than a slogan.
 *
 * What is deliberately *not* here: `Screen` and `ConnectionBanner`. They are
 * app chrome — page frame, status dot, offline banner — and they read the app's
 * connection state. A device supplies content; the app supplies the frame
 * around it.
 */

export { AnimatedNumber } from './AnimatedNumber';
export { Card, SectionLabel, type CardProps } from './Card';
export { DeviceCard, type DeviceCardDevice } from './DeviceCard';
export { ModeRow } from './ModeRow';
export { Row, RowSeparator, ToggleRow } from './Row';
export { Toggle, type ToggleProps } from './Toggle';
export { SchemaForm, isComplete } from './SchemaForm';
export { SegmentedControl } from './SegmentedControl';
export { SliderRow } from './SliderRow';

export { haptic } from './haptics';
export {
  fixedRange,
  formatMeasurement,
  freshestAt,
  isStale,
  primaryMeasurement,
  readingFor,
  startsAtZero,
  STALE_AFTER_MS,
} from './measurement';
export {
  chartPath,
  chartScale,
  chartSegments,
  chartY,
  type ChartBox,
  type ChartScale,
  type SeriesPoint,
} from './series';
export {
  formatAgo,
  formatDuration,
  formatFresh,
  formatTemperature,
  formatUptime,
  formatWatts,
  formatWh,
  STATE_LABELS,
  STATE_TINT,
} from './format';
