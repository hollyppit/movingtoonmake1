import { handleConfig } from '../../studio-api.js';
export const onRequest = c => handleConfig(c.request, c.env);
