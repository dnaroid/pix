export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export function imageDimensions(width: number, height: number): ImageDimensions | undefined {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

/** Reserve natural proportions without upscaling, using the chat viewport or a fixed cap. */
export function imagePreviewStyle(
  dimensions: ImageDimensions | undefined,
  maxHeightRem?: number,
): string | undefined {
  if (!dimensions) return undefined;
  const ratio = dimensions.width / dimensions.height;
  const heightBoundWidth = maxHeightRem === undefined
    ? `calc(var(--chat-media-max-height, 28rem) * ${ratio})`
    : `${maxHeightRem * ratio}rem`;
  return `width: min(100%, ${dimensions.width}px, ${heightBoundWidth}); aspect-ratio: ${dimensions.width} / ${dimensions.height};`;
}
