import { handleFile } from '../../studio-api.js';
export const onRequest = c => handleFile(c.request, c.env);
