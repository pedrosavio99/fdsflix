// Ligada por vercel.json: /live/hls -> /api/live. Toda a lógica está em lib/liveHls.mjs.
import { handleLive } from '../lib/liveHls.mjs';

export const config = { runtime: 'edge' };

export default function handler(request) {
  return handleLive(request, { route: '/live/hls' });
}
