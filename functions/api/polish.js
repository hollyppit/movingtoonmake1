import { handlePolish } from '../../studio-api.js';
export const onRequest = c => handlePolish(c.request, c.env);
