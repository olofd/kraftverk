import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { toQR } from 'toqr';

/**
 * A QR code for a phone to scan: dark modules on white, with the quiet zone a
 * scanner needs, whatever the theme — a scanner reads dark on light, and an
 * inverted code is often not read at all.
 *
 * One path for every dark module, so a code of a thousand modules is one shape.
 */
export function QrCode({ value, size = 220, label }: { value: string; size?: number; label: string }) {
  const { path, count } = useMemo(() => {
    const modules = toQR(value);
    const side = Math.round(Math.sqrt(modules.length));
    let d = '';
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) if (modules[y * side + x] === 1) d += `M${x} ${y}h1v1h-1z`;
    }
    return { path: d, count: side };
  }, [value]);
  const quiet = 4;
  const view = count + quiet * 2;
  return (
    <Svg width={size} height={size} viewBox={`${-quiet} ${-quiet} ${view} ${view}`} accessibilityLabel={label} role="img">
      <Rect x={-quiet} y={-quiet} width={view} height={view} fill="#ffffff" />
      <Path d={path} fill="#000000" />
    </Svg>
  );
}
