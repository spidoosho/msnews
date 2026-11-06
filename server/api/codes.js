import { api } from '../lib/vercel.js';

export default { fetch: (request) => api.handle(request, 'codes') };
