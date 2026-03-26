'use client';

import axios from 'axios';

export const AUTH_ERROR_EVENT = 'nocturne:auth-error';

export const api = axios.create({
  baseURL: '/api',
});

// Request interceptor: attach Bearer Token from cookie
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = document.cookie
      .split('; ')
      .find((c) => c.startsWith('api_token='))
      ?.split('=')[1];
    if (token) {
      config.headers = config.headers ?? {};
      config.headers.Authorization = `Bearer ${decodeURIComponent(token)}`;
    }
  }
  return config;
});

// Response interceptor: 401 → clear cookie + re-auth
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      if (typeof window !== 'undefined') {
        document.cookie = 'api_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        window.dispatchEvent(new CustomEvent(AUTH_ERROR_EVENT));
      }
    }
    return Promise.reject(error);
  }
);

export const encodeId = (id) => encodeURIComponent(id);

// ============ Review API ============
export const getGroups = () => api.get('/review/groups').then((r) => r.data);
export const getGroupDiff = (nodeUuid) =>
  api.get(`/review/groups/${encodeId(nodeUuid)}/diff`).then((r) => r.data);
export const rollbackGroup = (nodeUuid) =>
  api.post(`/review/groups/${encodeId(nodeUuid)}/rollback`, {}).then((r) => r.data);
export const approveGroup = (nodeUuid) =>
  api.delete(`/review/groups/${encodeId(nodeUuid)}`).then((r) => r.data);
export const clearAll = () => api.delete('/review').then((r) => r.data);

// ============ Browse API ============
export const getDomains = () => api.get('/browse/domains').then((r) => r.data);

export default api;
