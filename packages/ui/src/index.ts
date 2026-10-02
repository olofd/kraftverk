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
export { EnergyFlow } from './EnergyFlow';
export { energyFlowOf, type Flow, type FlowNode } from './energy';
export { EventList, type ListedEvent } from './EventList';
export { Icon, IconLabel, type IconName } from './Icon';
export { InfoCard, PartCard, ReadingRow } from './PartCard';
export { ToolPanel } from './ToolPanel';
export { PendingMark } from './PendingMark';
export { Row, RowSeparator, toggled, ToggleRow } from './Row';
export { Toggle, type ToggleProps } from './Toggle';
export { SchemaForm, isComplete } from './SchemaForm';
export { Chips } from './Chips';
export { useRadioGroup, useToggleGroup } from './radioGroup';
export { SegmentedControl } from './SegmentedControl';
export { SliderRow } from './SliderRow';
export { RangeSliderRow } from './RangeSliderRow';
export { type Marker } from './SliderMarker';
export { StatTile } from './StatTile';
export { PowerButton } from './PowerButton';

export { haptic } from './haptics';
export { WriteGate, WriteInFlightError, type WriteSnapshot } from './writeGate';
export { useWriteGate } from './useWriteGate';
export {
  fixedRange,
  formatValue,
  isOld,
  observedAt,
  shownAttributes,
  readingFor,
  startsAtZero,
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
  capitalise,
  formatAgo,
  formatDuration,
  formatFresh,
  formatTemperature,
  formatUptime,
  formatWatts,
  formatWh,
} from './format';
