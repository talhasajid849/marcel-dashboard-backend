'use strict';

const crypto = require('crypto');

function getConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder = process.env.CLOUDINARY_LICENCE_FOLDER || 'honk-hire/licences';

  return { cloudName, apiKey, apiSecret, folder };
}

function isConfigured() {
  const { cloudName, apiKey, apiSecret } = getConfig();
  return Boolean(cloudName && apiKey && apiSecret);
}

function signParams(params, apiSecret) {
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  return crypto
    .createHash('sha1')
    .update(`${payload}${apiSecret}`)
    .digest('hex');
}

function sanitizePublicId(value) {
  return String(value || `licence-${Date.now()}`)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

async function uploadDataUri(dataUri, options = {}) {
  if (!isConfigured()) {
    throw new Error('Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.');
  }

  if (!String(dataUri || '').startsWith('data:')) {
    throw new Error('Cloudinary upload expected a data URI');
  }

  if (typeof fetch !== 'function' || typeof FormData !== 'function') {
    throw new Error('This Node.js version does not support fetch/FormData. Use Node 18 or newer.');
  }

  const { cloudName, apiKey, apiSecret, folder } = getConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = sanitizePublicId(options.publicId);
  const paramsToSign = {
    folder,
    public_id: publicId,
    timestamp,
  };

  const formData = new FormData();
  formData.append('file', dataUri);
  formData.append('api_key', apiKey);
  formData.append('timestamp', String(timestamp));
  formData.append('folder', folder);
  formData.append('public_id', publicId);
  formData.append('signature', signParams(paramsToSign, apiSecret));

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
    method: 'POST',
    body: formData,
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result?.error?.message || `Cloudinary upload failed with status ${response.status}`);
  }

  return {
    url: result.secure_url || result.url,
    publicId: result.public_id,
    resourceType: result.resource_type,
    bytes: result.bytes,
    format: result.format,
  };
}

module.exports = {
  isConfigured,
  uploadDataUri,
};
