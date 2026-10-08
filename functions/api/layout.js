import { handleLayout } from '../../studio-api.js';
export const onRequest = c => handleLayout(c.request, c.env);
