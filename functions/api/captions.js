import { handleCaptions } from '../../studio-api.js';
export const onRequest = c => handleCaptions(c.request, c.env);
