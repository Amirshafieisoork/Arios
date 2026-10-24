const PHONE_PATTERN = /(?:\+|00)?\d(?:[\s().-]*\d){9,14}/g;
const digits = value => String(value || '').replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
export function callbackPhoneIn(value) {
  return digits(value).match(PHONE_PATTERN)?.[0]?.trim() || '';
}
export function redactContactNumbers(value) {
  return digits(value).replace(PHONE_PATTERN, 'شماره تماس');
}
export async function requestPublicLead({phone, name = '', message = '', requestId}, {fetcher = fetch, signal} = {}) {
  const response = await fetcher('/api/public-leads', {
    // Retain the signed visitor cookie; the public BFF never forwards workspace credentials.
    method: 'POST', credentials: 'same-origin',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({phone: digits(phone).trim(), name: name.trim(), message: message.trim(), requestId, consent: true}), signal,
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('ثبت درخواست تأیید نشد؛ دوباره تلاش کنید.'); }
  if (!response.ok) {
    const known = {PHONE_INVALID: 'شماره تماس را کامل و درست وارد کنید.', RATE_LIMITED: 'تعداد درخواست‌ها زیاد شده؛ کمی بعد دوباره تلاش کنید.'};
    throw new Error(known[data?.code] || 'درخواست تماس ثبت نشد؛ دوباره تلاش کنید.');
  }
  if (data?.accepted !== true || typeof data.lead?.id !== 'string' || !data.lead.id) throw new Error('ثبت درخواست تأیید نشد؛ دوباره تلاش کنید.');
  return data;
}

export async function requestPublicAnswer(message, history, {fetcher = fetch, signal} = {}) {
  const response = await fetcher('/api/public-assistant', {
    method: 'POST', credentials: 'omit',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({message: redactContactNumbers(message), history: history.map(entry => ({role: entry.role, content: redactContactNumbers(entry.content)}))}), signal,
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
  const callbackCard = dialog.querySelector('[data-callback-card]');
  const callbackForm = dialog.querySelector('[data-callback-form]');
  const callbackPhone = callbackForm.elements.phone;
  const callbackName = callbackForm.elements.name;
  const callbackMessage = callbackForm.elements.message;
  const callbackSubmit = callbackForm.querySelector('[type="submit"]');
  const callbackFields = callbackForm.querySelector('fieldset');
  const callbackStatus = dialog.querySelector('[data-callback-status]');
  const callbackError = dialog.querySelector('[data-callback-error]');
  const messages = [];
  const messageNodes = new WeakMap();
  let pending = false, failed = null, returnFocus = null;
  let callbackPending = false, callbackSaved = false, callbackRequestId = null, callbackFingerprint = '', callbackMessageEdited = false;

  function focusCallback(phone = '', message = '') {
    // An unconfirmed submission may already be saved. Keep its exact payload for
    // the idempotent retry until the visitor deliberately edits a form field.
    if (phone && !callbackSaved && !callbackPending && !callbackRequestId) callbackPhone.value = phone;
    if (message && !callbackMessageEdited && !callbackSaved && !callbackPending && !callbackRequestId) callbackMessage.value = redactContactNumbers(message).replaceAll('شماره تماس', '').trim().slice(0, 500);
    requestAnimationFrame(() => {
      callbackCard.scrollIntoView({block: 'start', behavior: 'smooth'});
      if (!callbackSaved && !callbackPending) callbackPhone.focus({preventScroll: true});
    });
  }
  async function submitCallback() {
    if (callbackPending || callbackSaved || !callbackForm.reportValidity()) return;
    const values = {phone: callbackPhone.value, name: callbackName.value, message: callbackMessage.value};
    const fingerprint = JSON.stringify(values);
    if (!callbackRequestId || callbackFingerprint !== fingerprint) callbackRequestId = crypto.randomUUID();
    callbackFingerprint = fingerprint;
    callbackPending = true;
    callbackFields.disabled = true;
    callbackSubmit.textContent = 'در حال ثبت درخواست…';
    callbackError.hidden = true;
    callbackStatus.textContent = '';
    callbackForm.setAttribute('aria-busy', 'true');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    try {
      await requestPublicLead({...values, requestId: callbackRequestId}, {signal: controller.signal});
      callbackSaved = true;
      callbackStatus.textContent = 'شماره ثبت شد؛ تیم آریوس برای مشاوره با شما تماس می‌گیرد';
      callbackFields.hidden = true;
      callbackPhone.value = callbackName.value = callbackMessage.value = '';
    } catch (error) {
      callbackError.textContent = error.name === 'AbortError' ? 'ثبت درخواست هنوز تأیید نشده؛ دوباره تلاش کنید.' : error.message || 'ارتباط برقرار نشد؛ دوباره تلاش کنید.';
      callbackError.hidden = false;
      callbackSubmit.textContent = 'تلاش دوباره برای ثبت تماس';
    } finally {
      clearTimeout(timeout);
      callbackPending = false;
      callbackFields.disabled = callbackSaved;
      callbackForm.setAttribute('aria-busy', 'false');
    }
  }

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
    if (messages.length || pending) scrollEnd();
    else messagesNode.scrollTop = 0;
  }
  function open(prefill = '', updateHash = true) {
    if (!dialog.open) {
      returnFocus = document.activeElement;
      dialog.showModal();
    }
    if (updateHash && location.hash !== '#chat') history.pushState({chat: true}, '', '#chat');
    if (prefill && !pending) input.value = prefill.slice(0, 2000);
    render();
    if (!pending && matchMedia('(min-width: 701px)').matches) {
      if (!messages.length && !prefill && !callbackSaved && !callbackPending) callbackPhone.focus();
      else input.focus();
    }
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
    const phone = callbackPhoneIn(message);
    if (phone) {
      input.value = '';
      errorNode.hidden = true;
      callbackStatus.textContent = callbackSaved ? 'درخواست تماس شما قبلاً ثبت شده است.' : 'برای درخواست تماس، شماره را در فرم تأیید و ثبت کنید.';
      focusCallback(phone, message);
      return;
    }
    if (!callbackMessageEdited && !callbackSaved && !callbackPending && !callbackRequestId) callbackMessage.value = message.slice(0, 500);
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
  callbackForm.addEventListener('submit', event => { event.preventDefault(); void submitCallback(); });
  callbackForm.addEventListener('input', event => {
    if (callbackPending || callbackSaved) return;
    callbackRequestId = null;
    if (event.target === callbackMessage) callbackMessageEdited = true;
    callbackError.hidden = true;
    callbackSubmit.textContent = 'درخواست تماس برای مشاوره';
  });
  dialog.querySelector('[data-callback-open]').addEventListener('click', () => focusCallback('', input.value));
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
