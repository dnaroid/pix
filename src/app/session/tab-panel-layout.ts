export const TAB_PANEL_ROWS = 2;

export function tabPanelRows(tabLineVisible: boolean, terminalRows: number, _tabCount = TAB_PANEL_ROWS): number {
	if (!tabLineVisible) return 0;
	const desiredRows = TAB_PANEL_ROWS;
	return Math.min(desiredRows, Math.max(0, terminalRows - 1));
}
