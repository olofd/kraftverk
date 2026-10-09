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

export { AnimatedNumber } from './AnimatedNumber.tsx';
export { Card, SectionLabel, type CardProps } from './Card.tsx';
export { DeviceCard, HEALTH_DOT, type DeviceCardDevice } from './DeviceCard.tsx';
export { EnergyFlow } from './EnergyFlow.tsx';
export { energyFlowOf, type Flow, type FlowNode } from './energy.ts';
export { EventList, type ListedEvent } from './EventList.tsx';
export { Icon, IconLabel, type IconName } from './Icon.tsx';
export { InfoCard, PartCard, ReadingRow } from './PartCard.tsx';
export { ToolPanel } from './ToolPanel.tsx';
export { PendingMark } from './PendingMark.tsx';
export { Row, RowSeparator, toggled, ToggleRow } from './Row.tsx';
export { Toggle, type ToggleProps } from './Toggle.tsx';
export { SchemaForm, isComplete } from './SchemaForm.tsx';
// No extension: each platform's own is picked (MapView.web.tsx on the web, MapView.tsx on a phone).
export { MAP_TAKES_TAPS, MapView } from './map/MapView';
export { MapApiProvider, useMapApi, type MapViewProps } from './map/props.ts';
export { CodeInput } from './CodeInput.tsx';
export { Chips } from './Chips.tsx';
export { ToggleChips } from './ToggleChips.tsx';
export { useRadioGroup, useToggleGroup } from './radio-group.ts';
export { SegmentedControl } from './SegmentedControl.tsx';
export { daysText, TrackSetting } from './TrackSetting.tsx';
export { SliderRow } from './SliderRow.tsx';
export { RangeSliderRow } from './RangeSliderRow.tsx';
export { type Marker } from './SliderMarker.tsx';
export { StatTile } from './StatTile.tsx';
export { PowerButton } from './PowerButton.tsx';

export { haptic } from './haptics.ts';
export { WriteGate, WriteInFlightError, type WriteSnapshot } from './write-gate.ts';
export { useWriteGate } from './useWriteGate.ts';
export { useConfirmed } from './useConfirmed.ts';
export {
  fixedRange,
  formatValue,
  isOld,
  observedAt,
  placeOf,
  shownAttributes,
  startsAtZero,
} from './measurement.ts';
export {
  chartPath,
  chartScale,
  chartSegments,
  chartY,
  type ChartBox,
  type ChartScale,
  type ChartPoint,
} from './series.ts';
export { parseNumberText, useNumberText } from './number-text.ts';
export {
  capitalise,
  formatAgo,
  formatCoordinates,
  formatDuration,
  formatFresh,
  formatTemperature,
  formatUptime,
  formatWatts,
  formatWh,
} from './format.ts';
