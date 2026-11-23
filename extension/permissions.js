import { endpointUrl } from './llm-config.mjs';

const byId = (id) => document.getElementById(id);
let origin = '';

try {
  const url = endpointUrl(new URLSearchParams(location.search).get('origin') || '');
  origin = url.origin;
} catch {
  origin = '';
}

byId('origin').textContent = origin || 'Invalid or missing origin';
const grant = byId('grant');
const status = (text) => { byId('status').textContent = text || ''; };

if (!origin) {
  grant.disabled = true;
  status('Close this tab and choose a valid http(s) endpoint in Settings → LLM.');
} else {
  const pattern = origin + '/*';
  (async () => {
    try {
      if (await chrome.permissions.contains({ origins: [pattern] })) {
        grant.disabled = true;
        status('Access is already granted for ' + origin + '. You can close this tab.');
      }
    } catch {}
  })();

  grant.addEventListener('click', async () => {
    grant.disabled = true;
    status('Waiting for the browser’s permission prompt…');
    try {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (granted) {
        status('Access granted. Closing this tab…');
        setTimeout(() => window.close(), 900);
      } else {
        grant.disabled = false;
        status('Access was not granted. You can try again or close this tab.');
      }
    } catch (error) {
      grant.disabled = false;
      status('The browser could not show the permission prompt: ' + error.message);
    }
  });
}
