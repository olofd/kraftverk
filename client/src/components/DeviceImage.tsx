import { Image } from 'react-native';

import { imageFor } from '../devices/ui';

/**
 * A device type's picture, from its package (`kraftverk.assets.image`), at a
 * size. Nothing for a type that ships none: the caller's icon stays.
 *
 * Drawn on its own transparent background, so it belongs to whatever card it
 * sits on, in light and dark alike.
 */
export function DeviceImage({ typeId, size }: { typeId: string | null | undefined; size: number }) {
  const source = imageFor(typeId);
  if (!source) return null;
  return <Image source={source} resizeMode="contain" style={{ width: size, height: size }} accessibilityIgnoresInvertColors />;
}
