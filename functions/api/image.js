import { handleImage } from '../../studio-api.js';
export const onRequest = c => handleImage(c.request, c.env);
