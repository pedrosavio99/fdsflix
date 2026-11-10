/**
 * Player "canvas" do fdsFlix: toca HEVC em qualquer navegador (decodifica no aparelho de quem assiste).
 * Junta o motor (engine.js), a interface (ui.js) e as legendas (subs.js). Veja engine.js para a arquitetura.
 */

import { createEngine, canvasPlayerSupported } from './engine.js';
import { createUI } from './ui.js';

export { canvasPlayerSupported };

/**
 * @param {{
 *   wrap: HTMLElement, video: HTMLVideoElement, url: string, startAt?: number, label?: string,
 *   subs?: object,
 *   onFatal?: (reason: string) => void, onSlow?: (xrt: number) => void,
 *   onAutoplayBlocked?: () => void, onStat?: (s: object) => void
 * }} o
 */
export async function startCanvasPlayer(o) {
  const ui = createUI(o.wrap, o.video, { label: o.label, subs: o.subs });
  let engine;
  try {
    engine = await createEngine(o.video, ui.canvas, o.url, {
      startAt: o.startAt,
      onFatal: o.onFatal,
      onSlow: o.onSlow,
      onStat: o.onStat,
      onAutoplayBlocked: o.onAutoplayBlocked,
      onChange: () => ui.refresh()
    });
  } catch (err) {
    ui.destroy();
    throw err;
  }
  ui.bind(engine);
  return {
    engine,
    ui,
    setSubOffset: (v) => ui.setSubOffset(v),
    setLabel: (t) => ui.setLabel(t),
    toast: (t) => ui.toast(t),
    destroy() {
      try { engine.destroy(); } catch (e) { /* ignore */ }
      ui.destroy();
    }
  };
}
