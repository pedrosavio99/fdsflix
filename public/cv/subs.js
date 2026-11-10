/**
 * Legendas do player canvas.
 *
 * As <track> continuam sendo carregadas pelo navegador (e escolhidas pelo app: modo "showing"),
 * mas quem DESENHA somos nós: assim a sincronia (±0,5 s) é aplicada na hora, sem baixar a legenda
 * de novo, e o texto acompanha a tela cheia, o tamanho do player e a barra de controles.
 */

export class SubtitleOverlay {
  /** @param {HTMLElement} root  @param {HTMLVideoElement} video */
  constructor(root, video) {
    this.video = video;
    this.el = document.createElement('div');
    this.el.className = 'cvp-subs';
    this.el.setAttribute('aria-live', 'off');
    root.appendChild(this.el);
    this.offset = 0;
    this.prev = [];
    this.prevTrack = null;
  }

  /** Positivo = legenda mais tarde. */
  setOffset(seconds) {
    this.offset = Number(seconds) || 0;
    this._render([]);     // limpa; o próximo update() desenha o que valer nesse instante
    this.prevTrack = null;
  }

  setScale(scale) {
    this.el.style.setProperty('--cvp-sub-scale', String(scale));
  }

  activeTrack() {
    const list = this.video.textTracks;
    for (let i = 0; i < list.length; i++) if (list[i].mode === 'showing') return list[i];
    return null;
  }

  /** @param {number} t  currentTime do vídeo */
  update(t) {
    const track = this.activeTrack();
    const cues = track && track.cues;
    if (!cues || !cues.length) {
      if (this.prev.length) this._render([]);
      this.prevTrack = track;
      return;
    }
    const T = t - this.offset;
    let lo = 0;
    let hi = cues.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].startTime <= T) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const active = [];
    for (let i = idx; i >= 0 && i > idx - 12; i--) if (cues[i].endTime > T) active.push(cues[i]);
    active.reverse();
    let same = track === this.prevTrack && active.length === this.prev.length;
    if (same) for (let i = 0; i < active.length; i++) if (active[i] !== this.prev[i]) { same = false; break; }
    if (same) return;
    this.prevTrack = track;
    this._render(active);
  }

  _render(active) {
    this.prev = active;
    this.el.textContent = '';
    for (const cue of active) {
      const box = document.createElement('div');
      box.className = 'cvp-cue';
      if (typeof cue.align === 'string' && (cue.align === 'start' || cue.align === 'left')) box.style.textAlign = 'left';
      else if (typeof cue.align === 'string' && (cue.align === 'end' || cue.align === 'right')) box.style.textAlign = 'right';
      const span = document.createElement('span');
      let frag = null;
      try { frag = typeof cue.getCueAsHTML === 'function' ? cue.getCueAsHTML() : null; } catch (e) { frag = null; }
      if (frag) span.appendChild(frag); else span.textContent = String(cue.text || '').replace(/<[^>]*>/g, '');
      box.appendChild(span);
      this.el.appendChild(box);
    }
  }

  dispose() {
    this.el.remove();
    this.prev = [];
  }
}
