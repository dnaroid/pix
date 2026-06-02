import type { ImageContent } from "../../input-editor.js";
import type { ImageClickTarget, RenderedLine, StyledSegment } from "../types.js";

const IMAGE_LABEL_PATTERN = /\[Image(?:\s+\d+)?(?::[^\]]+)?\]/g;

type ImageLabelStyle = Omit<StyledSegment, "start" | "end">;

export function attachImageClickTargets(
	lines: RenderedLine[],
	entryId: string,
	images: readonly ImageContent[] | undefined,
	style?: ImageLabelStyle,
): RenderedLine[] {
	if (!images || images.length === 0) return lines;

	let fallbackIndex = 0;
	for (const line of lines) {
		const targets: ImageClickTarget[] = [];
		const segments: StyledSegment[] = [];
		for (const match of line.text.matchAll(IMAGE_LABEL_PATTERN)) {
			const imageIndex = imageIndexForLabel(match[0], fallbackIndex);
			fallbackIndex = Math.max(fallbackIndex, imageIndex + 1);
			if (imageIndex < 0 || imageIndex >= images.length) continue;
			const start = match.index ?? 0;
			const end = start + match[0].length;
			targets.push({ start, end, entryId, imageIndex });
			if (style) segments.push({ start, end, ...style });
		}
		if (targets.length > 0) line.imageTargets = [...(line.imageTargets ?? []), ...targets];
		if (segments.length > 0) line.segments = [...(line.segments ?? []), ...segments];
	}
	return lines;
}

function imageIndexForLabel(label: string, fallbackIndex: number): number {
	const numbered = /^\[Image\s+(\d+)(?::|\])/u.exec(label);
	if (numbered?.[1]) return Number(numbered[1]) - 1;
	return fallbackIndex;
}
