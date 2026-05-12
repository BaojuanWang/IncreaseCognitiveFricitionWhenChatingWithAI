chrome.runtime.onInstalled.addListener(() => {
  console.log('[CF] background ready');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'CF_API') return;
  console.log('[CF] got message, calling OpenAI');

  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${msg.apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 600,
      messages: [
        { role: 'system', content: msg.system },
        { role: 'user', content: msg.user }
      ]
    })
  })
  .then(r => r.json())
  .then(d => {
    console.log('[CF] OpenAI response:', d);
    sendResponse({ text: d.choices?.[0]?.message?.content || null });
  })
  .catch(e => {
    console.error('[CF] fetch error:', e);
    sendResponse({ text: null });
  });

  return true;
});
