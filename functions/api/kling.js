import { handleKling } from '../../studio-api.js';
export const onRequest = c => handleKling(c.request, c.env);
