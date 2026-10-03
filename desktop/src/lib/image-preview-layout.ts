export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export function imageDimensions(width: number, height: number): ImageDimensions | undefined {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

/** Reserve natural proportions, without upscaling, within the existing height cap. */
export function imagePreviewStyle(dimensions: ImageDimensions | undefined, maxHeightRem: number): string | undefined {
  if (!dimensions) return undefined;
  const ratio = dimensions.width / dimensions.height;
  return `width: min(100%, ${dimensions.width}px, ${maxHeightRem * ratio}rem); aspect-ratio: ${dimensions.width} / ${dimensions.height};`;
}
