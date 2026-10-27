import { handleEdit } from '../../studio-api.js';
export const onRequest = c => handleEdit(c.request, c.env);
