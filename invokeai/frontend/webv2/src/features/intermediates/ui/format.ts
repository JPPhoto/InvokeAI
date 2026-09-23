const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Binary units, one decimal from KB up, so a summary card and a confirmation quote the same figure. */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 1) {
    return '0 B';
  }

  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
};

export const formatCount = (count: number): string => new Intl.NumberFormat().format(count);
