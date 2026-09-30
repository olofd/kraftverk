import { Image } from 'react-native';

import type { PictureRef } from '@kraftverk/api-client';

import { pictureFor } from '../devices/ui';

/**
 * A device type's picture, from its package (`kraftverk.assets.images`), at a
 * size: the one a device's owner picked (`picture`), else the first. Nothing
 * for a type that ships none: the caller's icon stays.
 *
 * Drawn on its own transparent background, so it belongs to whatever card it
 * sits on, in light and dark alike.
 */
export function DeviceImage({ typeId, picture = 'type:0', size }: { typeId: string | null | undefined; picture?: PictureRef; size: number }) {
  const source = pictureFor(typeId, picture);
  if (!source) return null;
  return <Image source={source} resizeMode="contain" style={{ width: size, height: size }} accessibilityIgnoresInvertColors />;
}
