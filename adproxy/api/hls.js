// Entrega do vídeo do Vidsrc no Edge runtime (não conta Fast Origin Transfer).
// Ligada por vercel.json: /vidsrc/hls -> /api/hls. Toda a lógica está em lib/edgeHls.mjs.
import { handleHls } from '../lib/edgeHls.mjs';

export const config = { runtime: 'edge' };

export default function handler(request) {
  return handleHls(request);
}
