import { handleUsage } from '../../studio-api.js';
export const onRequest = c => handleUsage(c.request, c.env);
