import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

export interface AccessTokenPayload {
  sub: string; // userId
  sid?: string; // AuthSession.id — absent only on tokens minted before sessions (Ф12 12.B2)
}

export interface RefreshTokenPayload {
  sub: string; // userId
  jti: string; // RefreshToken.id (DB row) — ties the JWT to a specific DB record
}

export function signAccessToken(userId: string, sessionId?: string): string {
  const payload: AccessTokenPayload = { sub: userId, ...(sessionId && { sid: sessionId }) };
  return jwt.sign(payload, config.JWT_ACCESS_SECRET, {
    expiresIn: config.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function signRefreshToken(userId: string, tokenId: string): string {
  return jwt.sign(
    { sub: userId, jti: tokenId } satisfies RefreshTokenPayload,
    config.JWT_REFRESH_SECRET,
    { expiresIn: config.JWT_REFRESH_TTL as jwt.SignOptions['expiresIn'] },
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.JWT_REFRESH_SECRET) as RefreshTokenPayload;
}
