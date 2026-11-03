import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

let app: FastifyInstance | null = null;

export async function getApp() {
  if (!app) {
    app = await buildApp({ logger: false });
    await app.ready();
  }
  return app;
}

export async function login(email: string, password = 'Password@123', schoolSlug: string | null = 'alpha') {
  const a = await getApp();
  const res = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, schoolSlug } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.body}`);
  return res.json().data.token as string;
}

/** Tiny client bound to a token. */
export function client(token: string) {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const a = await getApp();
    const res = await a.inject({ method, url: `/api${url}`, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
    let body: any = null;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, data: body?.data, headers: res.headers };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    put: (url: string, payload?: unknown) => call('PUT', url, payload ?? {}),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload ?? {}),
    del: (url: string) => call('DELETE', url),
  };
}
