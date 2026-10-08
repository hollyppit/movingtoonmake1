import { handleTts } from '../../studio-api.js';
export const onRequest = c => handleTts(c.request, c.env);
