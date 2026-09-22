export interface DcpStatisticsInput {
  branch?: readonly any[];
  model?: any;
  usage?: any;
  historyStatus?: "full" | "unavailable";
}
export function collectDcpStatistics(input: DcpStatisticsInput): any;
export function collectDcpStatisticsAsync(input: DcpStatisticsInput, options?: { chunkSize?: number }): Promise<any>;
export function formatDcpStatistics(input: DcpStatisticsInput): string;
