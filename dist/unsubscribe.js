'use strict';
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const button = document.querySelector('#unsubscribe');
const result = document.querySelector('#result');
if (!/^[a-f0-9-]{72}$/.test(token) || !window.CINEMA_CONFIG?.url) {
  button.disabled = true;
  result.textContent = 'This link is incomplete. Open the unsubscribe link from your email again.';
}
button.onclick = async () => {
  button.disabled = true;
  try {
    const response = await fetch(`${window.CINEMA_CONFIG.url}/functions/v1/unsubscribe?token=${encodeURIComponent(token)}`, { method: 'POST' });
    if (!response.ok) throw new Error('Could not unsubscribe. Please try again or contact the hosts.');
    result.textContent = 'You are unsubscribed. Existing seat bookings are unchanged.';
    button.hidden = true;
  } catch (error) { result.textContent = error.message; button.disabled = false; }
};
