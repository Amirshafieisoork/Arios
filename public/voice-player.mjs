// A playback URL belongs only to its mounted player and is cleared on navigation.
// Never persist signed URLs in application data, localStorage or downloaded reports.
export function renderVoiceAudio(draft, { escape, date }) {
  if (draft.source === 'text') return '';
  const audio = draft.audio || {};
  if (audio.available !== true) {
    const expired = audio.expiresAt && Date.parse(audio.expiresAt) <= Date.now();
    return `<p class="voice-audio-note">${expired ? 'مهلت نگه‌داری صوت اصلی پایان یافته است' : 'صوت اصلی این گزارش در دسترس نیست'}</p>`;
  }
  const label = draft.source === 'telegram' ? 'ویس تلگرام' : 'فایل صوتی گزارش';
  return `<section class="voice-audio" data-voice-audio="${escape(draft.id)}" aria-label="صوت اصلی گزارش"><div class="voice-audio-head"><strong>صوت اصلی</strong><div class="actions"><button type="button" class="button secondary small" data-voice-audio-load>پخش صوت</button><button type="button" class="button secondary small" data-voice-audio-stop disabled>توقف</button><a class="text-link voice-audio-download" data-voice-audio-download download hidden>دریافت صوت</a></div></div><audio data-voice-audio-player controls preload="none" crossorigin="anonymous" aria-label="${label}"></audio><small class="voice-audio-status" data-voice-audio-status role="status" aria-live="polite">برای شنیدن، «پخش صوت» را بزنید${audio.expiresAt ? ' · نگه‌داری تا ' + escape(date(audio.expiresAt)) : ''}</small></section>`;
}

export function validateVoiceAudio(value, now = Date.now()) {
  let url;
  try { url = new URL(value?.url); } catch { throw new Error('INVALID_AUDIO_URL'); }
  const expiresAt = Date.parse(value.expiresAt);
  if (url.origin !== 'https://qategfabulrkvdckzmqp.supabase.co' || url.username || url.password || !url.pathname.startsWith('/storage/v1/object/sign/arios-audio/') || !url.searchParams.get('token') || !Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('INVALID_AUDIO_URL');
  return { url: url.href, expiresAt, fileName: typeof value.fileName === 'string' ? value.fileName : 'ARIOS-voice.ogg' };
}

export function audioPlaybackActive(root = document) {
  return Array.from(root.querySelectorAll('[data-voice-audio]')).some(block => {
    const player = block.querySelector('[data-voice-audio-player]');
    return block.dataset.audioLoading === 'true' || Boolean(player && !player.paused && !player.ended);
  });
}

function playbackError(error) {
  if (error?.code === 'AUDIO_EXPIRED' || error?.status === 410) return 'مهلت نگه‌داری این فایل صوتی پایان یافته است';
  if (error?.code === 'AUDIO_NOT_AVAILABLE' || error?.status === 404) return 'نسخهٔ صوتی این گزارش در دسترس نیست';
  if (error?.status === 401) return 'برای شنیدن صوت، دوباره وارد حساب شوید';
  if (error?.status === 403) return 'اجازهٔ شنیدن این صوت را ندارید';
  return 'پخش صوت انجام نشد؛ دکمهٔ «تلاش دوباره» را بزنید';
}

export function wireVoiceAudio(root, { getAudio, onIdle = () => {} }) {
  const disposers = [];
  for (const block of root.querySelectorAll('[data-voice-audio]')) {
    const player = block.querySelector('[data-voice-audio-player]');
    const loadButton = block.querySelector('[data-voice-audio-load]');
    const stopButton = block.querySelector('[data-voice-audio-stop]');
    const download = block.querySelector('[data-voice-audio-download]');
    const status = block.querySelector('[data-voice-audio-status]');
    if (!player || !loadButton || !stopButton || !download || !status) continue;
    let disposed = false, loading = false, expiresAt = 0, pendingSeek = 0;
    const handlers = [];
    const listen = (element, name, fn) => { element.addEventListener(name, fn); handlers.push(() => element.removeEventListener(name, fn)); };
    const message = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
    const clearSource = () => {
      player.removeAttribute('src');
      download.removeAttribute('href');
      download.hidden = true;
      expiresAt = 0;
    };
    const play = async () => {
      try { await player.play(); }
      catch (error) {
        if (disposed) return;
        if (error?.name === 'NotAllowedError') message('صوت آماده است؛ دکمهٔ پخش داخل نوار صوت را بزنید');
        else { message('مرورگر این صوت را پخش نکرد؛ دوباره تلاش کنید یا فایل را دریافت کنید', true); loadButton.textContent = 'تلاش دوباره'; expiresAt = 0; }
      }
    };
    listen(loadButton, 'click', async () => {
      if (loading || disposed) return;
      if (player.getAttribute('src') && expiresAt > Date.now() + 1000 && !player.error) {
        if (player.ended) player.currentTime = 0;
        await play();
        return;
      }
      loading = true;
      const resumeAt = Number(player.currentTime) || 0;
      block.dataset.audioLoading = 'true';
      block.setAttribute('aria-busy', 'true');
      loadButton.disabled = true;
      message('در حال آماده‌سازی صوت…');
      try {
        const result = validateVoiceAudio(await getAudio(block.dataset.voiceAudio));
        if (disposed) return;
        player.src = result.url;
        pendingSeek = resumeAt;
        expiresAt = result.expiresAt;
        download.href = result.url;
        download.download = result.fileName;
        download.hidden = false;
        stopButton.disabled = false;
        loadButton.textContent = 'پخش دوباره';
        player.load();
        message('صوت آمادهٔ پخش است');
        await play();
      } catch (error) {
        if (disposed) return;
        clearSource();
        stopButton.disabled = true;
        loadButton.textContent = 'تلاش دوباره';
        message(playbackError(error), true);
      } finally {
        loading = false;
        block.dataset.audioLoading = 'false';
        block.removeAttribute('aria-busy');
        if (!disposed) { loadButton.disabled = false; onIdle(); }
      }
    });
    listen(stopButton, 'click', () => { player.pause(); player.currentTime = 0; message('پخش متوقف شد'); onIdle(); });
    listen(player, 'play', () => {
      for (const other of root.querySelectorAll('[data-voice-audio-player]')) if (other !== player) other.pause();
      message('در حال پخش صوت');
    });
    listen(player, 'loadedmetadata', () => {
      if (pendingSeek <= 0) return;
      try { player.currentTime = Number.isFinite(player.duration) ? Math.min(pendingSeek, Math.max(0, player.duration - 0.1)) : pendingSeek; } catch {}
      pendingSeek = 0;
    });
    listen(player, 'pause', () => { if (!disposed) onIdle(); });
    listen(player, 'ended', () => { message('پخش صوت تمام شد'); onIdle(); });
    listen(player, 'error', () => {
      if (disposed || !player.getAttribute('src')) return;
      expiresAt = 0;
      loadButton.textContent = 'تلاش دوباره';
      message('صوت پخش نشد؛ برای دریافت دوباره دکمهٔ «تلاش دوباره» را بزنید', true);
      onIdle();
    });
    disposers.push(() => {
      disposed = true;
      handlers.forEach(remove => remove());
      player.pause();
      clearSource();
      player.load();
      block.dataset.audioLoading = 'false';
    });
  }
  return () => disposers.forEach(dispose => dispose());
}
