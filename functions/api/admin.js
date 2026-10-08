import { handleAdmin } from '../../studio-api.js';
export const onRequest = c => handleAdmin(c.request, c.env);
