import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";
import { env } from "@/config/env";
import { Role } from "@/constants/roles";

export interface AccessTokenPayload extends JwtPayload {
  sub: string; // user id
  role: Role;
  cooperativeId: string | null;
  // True while the holder is still on an administrator-issued temporary
  // password. Carried in the token rather than read from the database so the
  // check on every protected request costs nothing; the only transition is
  // true -> false, and the change-password endpoint hands back fresh tokens, so
  // a stale claim can never keep someone locked out after they have complied.
  mustChangePassword?: boolean;
}

export function signAccessToken(payload: Omit<AccessTokenPayload, "iat" | "exp">): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  } as SignOptions);
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload;
}
