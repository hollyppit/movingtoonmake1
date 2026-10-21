import { handleOvLayout } from '../../studio-api.js';
export const onRequest = c => handleOvLayout(c.request, c.env);
