// Connects the API to Vercel Blob. This is the only file that needs the Vercel SDK.
import { BlobPreconditionFailedError, del, get, list, put } from '@vercel/blob';
import { ConflictError, createApi } from './api.js';

const storage = {
  async read(path) {
    const result = await get(path, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return { data: JSON.parse(await new Response(result.stream).text()), etag: result.blob.etag };
  },
  async write(path, data, { etag }) {
    try {
      await put(path, JSON.stringify(data), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: Boolean(etag),
        ...(etag ? { ifMatch: etag } : {}),
      });
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new ConflictError();
      throw error;
    }
  },
  async remove(path) {
    await del(path);
  },
  async count(prefix) {
    return (await list({ prefix, limit: 1000 })).blobs.length;
  },
};

export const api = createApi({ storage, allowedOrigins: ['https://spidoosho.github.io'] });
