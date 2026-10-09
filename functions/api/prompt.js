import { handlePrompt } from '../../studio-api.js';
export const onRequest = c => handlePrompt(c.request, c.env);
