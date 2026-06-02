import type { ScreenPoint } from "../types.js";

export function samePoint(left: ScreenPoint, right: ScreenPoint): boolean {
	return left.x === right.x && left.y === right.y;
}

export function orderedSelection(anchor: ScreenPoint, current: ScreenPoint): { start: ScreenPoint; end: ScreenPoint } {
	if (anchor.y < current.y || (anchor.y === current.y && anchor.x <= current.x)) {
		return { start: anchor, end: current };
	}
	return { start: current, end: anchor };
}

