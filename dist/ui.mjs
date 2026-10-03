export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function safeImage(value) {
  if (typeof value !== 'string') return 'assets/poster-placeholder.svg';
  if (/^assets\/[a-zA-Z0-9_.-]+$/.test(value)) return value;
  try { const url = new URL(value); if (url.protocol === 'https:') return value; } catch {}
  return 'assets/poster-placeholder.svg';
}
export function ratingText(value, source) {
  return typeof value === 'number' && Number.isFinite(value) ? source === 'imdb' ? `${value.toFixed(1)}/10` : `${value}%` : 'Not rated';
}
export function eventLabel(event) {
  return new Date(event.starts_at).toLocaleString(undefined, { timeZone: event.timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) + ' · ' + event.location;
}
