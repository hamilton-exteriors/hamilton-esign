export async function postWhatsApp(rw, path, body) {
  const response = await fetch(`https://${rw.RAILWAY_PUBLIC_DOMAIN}/internal/whatsapp/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rw.PLATFORM_INTERNAL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = (await response.text()).slice(0, 200);
  if (!response.ok) {
    throw new Error(`WhatsApp ${path} failed (${response.status})${responseBody ? `: ${responseBody}` : ''}`);
  }
  return response.status;
}

export async function sendIntroOnce(rw, to, body, state) {
  if (state.intro) return;
  await postWhatsApp(rw, 'send-text', { to, body });
  state.intro = true;
}
