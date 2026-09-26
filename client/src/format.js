export const usd = (n) =>
  Number(n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const shortTime = (iso) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const clock = (iso) =>
  new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const humanFlag = (flag) => flag.toLowerCase().replace(/_/g, ' ');

export const isInFlight = (entry) => ['PENDING', 'PROCESSING'].includes(entry.aiMetadata?.status);
