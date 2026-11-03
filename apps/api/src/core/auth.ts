import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from './env';

export const AUTH_COOKIE = 'edumin_token';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface TokenPayload {
  sub: string; // user id
  sid: string | null; // school id
  tv: number; // token version; bumping it revokes all tokens for the user
}

export const hashPassword = (password: string) => bcrypt.hash(password, 10);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export function signToken(payload: TokenPayload) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  path: '/',
  maxAge: TOKEN_TTL_SECONDS,
};
