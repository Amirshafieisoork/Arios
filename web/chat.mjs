export async function requestPublicAnswer(message, history, {fetcher = fetch, signal} = {}) {
  const response = await fetcher('/api/public-assistant', {
    method: 'POST', credentials: 'omit',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({message, history}), signal,
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('پاسخ آریوس دریافت نشد؛ چند لحظه بعد دوباره تلاش کنید.'); }
  if (!data || typeof data !== 'object') throw new Error('پاسخ آریوس قابل دریافت نیست؛ دوباره تلاش کنید.');
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : '';
    throw new Error(message || (response.status === 429 ? 'تعداد پیام‌ها زیاد شده؛ کمی بعد دوباره تلاش کنید.' : 'گفتگو فعلاً در دسترس نیست؛ دوباره تلاش کنید.'));
  }
  const verifiedMode = data.live === true || (data.live === false && data.mode === 'guide');
  if (typeof data.answer !== 'string' || !data.answer.trim() || !verifiedMode) throw new Error('پاسخ کامل دریافت نشد؛ دوباره تلاش کنید.');
  return data;
}

export function initPublicChat() {
  const dialog = document.querySelector('#arios-chat');
  if (!dialog) return {open() {}, ask() {}};
  const form = dialog.querySelector('[data-chat-form]');
  const input = form.querySelector('textarea');
  const send = form.querySelector('[type="submit"]');
  const messagesNode = dialog.querySelector('[data-chat-messages]');
  const welcome = dialog.querySelector('[data-chat-welcome]');
  const pendingNode = dialog.querySelector('[data-chat-pending]');
  const errorNode = dialog.querySelector('[data-chat-error]');
  const errorText = dialog.querySelector('[data-chat-error-text]');
  const retry = dialog.querySelector('[data-chat-retry]');
  const fresh = dialog.querySelector('[data-chat-fresh]');
  const launcher = document.querySelector('[data-chat-launcher]');
  const count = dialog.querySelector('[data-chat-count]');
  const messages = [];
  const messageNodes = new WeakMap();
  let pending = false, failed = null, returnFocus = null;

  function scrollEnd() { requestAnimationFrame(() => { messagesNode.scrollTop = messagesNode.scrollHeight; }); }
  function render() {
    if (!messages.length) messagesNode.querySelectorAll('[data-chat-message]').forEach(node => node.remove());
    welcome.hidden = messages.length > 0;
    for (const entry of messages) {
      let item = messageNodes.get(entry);
      if (!item) {
        item = document.createElement('article');
        item.dataset.chatMessage = '';
        const label = document.createElement('span');
        label.className = 'chat-message-label';
        label.textContent = entry.role === 'user' ? 'شما' : entry.mode === 'guide' ? 'راهنمای خدمات آریوس' : 'آریوس';
        const text = document.createElement('p');
        text.textContent = entry.content;
        item.append(label, text);
        if (entry.mode === 'guide') {
          const badge = document.createElement('span');
          badge.className = 'chat-guide-badge';
          badge.textContent = 'پاسخ از راهنمای خدمات';
          item.insertBefore(badge, text);
          const notice = document.createElement('p');
          notice.className = 'chat-guide-notice';
          notice.textContent = entry.notice || 'سرویس هوشمند اکنون پاسخگو نیست؛ این پاسخ از راهنمای خدمات آریوس است.';
          item.append(notice);
        }
        messageNodes.set(entry, item);
        messagesNode.insertBefore(item, pendingNode);
      }
      item.className = 'chat-message chat-message--' + entry.role + (entry.status === 'failed' ? ' chat-message--failed' : '');
      let status = item.querySelector('[data-message-state]');
      if (entry.status === 'failed' && !status) {
        status = document.createElement('small');
        status.dataset.messageState = '';
        status.textContent = 'پاسخ دریافت نشد';
        item.append(status);
      } else if (entry.status !== 'failed' && status) status.remove();
    }
    pendingNode.hidden = !pending;
    messagesNode.setAttribute('aria-busy', String(pending));
    send.disabled = pending;
    fresh.disabled = pending;
    retry.disabled = pending;
    input.readOnly = pending;
    send.querySelector('span').textContent = pending ? 'در حال دریافت پاسخ' : 'ارسال پیام';
    count.textContent = input.value.length.toLocaleString('fa-IR') + ' / ۲٬۰۰۰';
    scrollEnd();
  }
  function open(prefill = '', updateHash = true) {
    if (!dialog.open) {
      returnFocus = document.activeElement;
      dialog.showModal();
    }
    if (updateHash && location.hash !== '#chat') history.pushState({chat: true}, '', '#chat');
    if (prefill && !pending) input.value = prefill.slice(0, 2000);
    render();
    if (!pending && matchMedia('(min-width: 701px)').matches) input.focus();
  }
  function close(updateHash = true) {
    dialog.close();
    if (updateHash && location.hash === '#chat') history.replaceState(null, '', '#contact');
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
  }
  async function sendMessage(raw, retrying = false) {
    const message = raw.trim();
    if (!message || pending) return;
    if (message.length > 2000) { errorText.textContent = 'پیام را در حداکثر ۲٬۰۰۰ نویسه بنویسید.'; errorNode.hidden = false; return; }
    open();
    const history = retrying ? failed.history : messages.filter(item => item.status === 'sent').slice(-8).map(item => ({role: item.role, content: item.content.slice(0, 2000)}));
    const entry = retrying ? failed.entry : {role: 'user', content: message, status: 'pending'};
    if (!retrying) messages.push(entry);
    entry.status = 'pending';
    pending = true;
    failed = null;
    errorNode.hidden = true;
    input.value = '';
    render();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 75000);
    try {
      const data = await requestPublicAnswer(message, history, {signal: controller.signal});
      entry.status = 'sent';
      messages.push({role: 'assistant', content: data.answer.trim(), status: 'sent', mode: data.live ? 'ai' : 'guide', notice: typeof data.notice === 'string' ? data.notice : ''});
    } catch (error) {
      entry.status = 'failed';
      failed = {message, history, entry};
      errorText.textContent = error.name === 'AbortError' ? 'دریافت پاسخ طول کشید؛ می‌توانید دوباره تلاش کنید.' : error.message || 'ارتباط برقرار نشد؛ اتصال اینترنت را بررسی کنید.';
      errorNode.hidden = false;
      input.value = message;
    } finally {
      clearTimeout(timeout);
      pending = false;
      render();
    }
  }
  document.querySelectorAll('[data-chat-open]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    open(button.dataset.chatPrompt || '');
  }));
  dialog.querySelector('[data-chat-close]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
  dialog.querySelectorAll('[data-chat-question]').forEach(button => button.addEventListener('click', () => void sendMessage(button.dataset.chatQuestion)));
  form.addEventListener('submit', event => { event.preventDefault(); void sendMessage(input.value); });
  input.addEventListener('input', () => { count.textContent = input.value.length.toLocaleString('fa-IR') + ' / ۲٬۰۰۰'; });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); void sendMessage(input.value); }
  });
  retry.addEventListener('click', () => { if (failed) void sendMessage(failed.message, true); });
  fresh.addEventListener('click', () => { messages.splice(0); failed = null; input.value = ''; errorNode.hidden = true; render(); input.focus(); });
  launcher?.setAttribute('aria-controls', 'arios-chat');
  const followHash = () => {
    if (location.hash === '#chat') open('', false);
    else if (dialog.open) close(false);
  };
  window.addEventListener('hashchange', followHash);
  window.addEventListener('popstate', followHash);
  render();
  return {open, ask(message) { open(); return sendMessage(message); }};
}
