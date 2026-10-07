import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCb);
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

/**
 * Hash de contraseña sin dependencias nuevas (scrypt viene en `crypto` de Node, sin bindings
 * nativos como bcrypt — evita fricción de compilación en Windows). Formato almacenado:
 * `<salt hex>:<hash hex>`.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = (await scrypt(plain, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  const derived = (await scrypt(plain, salt, expected.length)) as Buffer;
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}
