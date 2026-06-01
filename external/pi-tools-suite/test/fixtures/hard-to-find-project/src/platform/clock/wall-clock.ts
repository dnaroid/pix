export interface WallClock {
  iso(): string;
  daysAgo(days: number): string;
}

export function systemClock(): WallClock {
  return {
    iso: () => new Date().toISOString(),
    daysAgo(days: number) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - days);
      return date.toISOString();
    },
  };
}
