export const PROJECT_SWITCHER_MIN_TEXT_WIDTH = 96;
export const PROJECT_SWITCHER_MAX_TEXT_WIDTH = 160;

export interface ProjectSwitcherMinimumWidthMetrics {
  horizontalPadding: number;
  gap: number;
  fixedWidths: readonly number[];
  projectNameWidth: number;
}

/**
 * Minimum switcher width is driven by fixed controls plus a bounded project-name
 * slot. The path never participates, so a long workspace path cannot inflate the
 * sidebar minimum while the chevron remains protected from clipping.
 */
export function projectSwitcherMinimumWidth(metrics: ProjectSwitcherMinimumWidthMetrics): number {
  const projectNameWidth = Math.min(
    PROJECT_SWITCHER_MAX_TEXT_WIDTH,
    Math.max(PROJECT_SWITCHER_MIN_TEXT_WIDTH, finite(metrics.projectNameWidth)),
  );
  const fixedWidth = metrics.fixedWidths.reduce((total, width) => total + finite(width), 0);
  const gapCount = metrics.fixedWidths.length;
  return Math.ceil(
    finite(metrics.horizontalPadding)
      + fixedWidth
      + finite(metrics.gap) * gapCount
      + projectNameWidth,
  );
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
