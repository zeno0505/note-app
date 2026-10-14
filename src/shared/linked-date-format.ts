/** Pure presentation only: immutable verified UTC in, explicit KST out. No I/O. */
export function linkedDateKst(utc: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(utc)) return null;
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== utc.replace(/Z$/, utc.includes('.') ? 'Z' : '.000Z')) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (name: string): string => parts.find(p => p.type === name)!.value;
  return `${get('year')}.${get('month')}.${get('day')} ${get('hour')}:${get('minute')}:${get('second')} KST`;
}
/** Compact dates retain the year unless the caller supplies matching visible year context. */
export function linkedDateCard(utc: string, visibleYear?: string): string | null {
  const formatted = linkedDateKst(utc);
  if (!formatted) return null;
  return formatted.slice(0, 4) === visibleYear ? formatted.slice(5, 10) : formatted.slice(0, 10);
}
