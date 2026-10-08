import { handleProjects } from '../../studio-api.js';
export const onRequest = c => handleProjects(c.request, c.env);
