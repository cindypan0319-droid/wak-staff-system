import crypto from "crypto";

export function hashPin(pin: string, salt: string) {
  return crypto.createHash("sha256").update(`${salt}:${pin}`).digest("hex");
}

export function createPinCredentials(pin: string) {
  const pinSalt = crypto.randomBytes(16).toString("hex");

  return {
    pin_salt: pinSalt,
    pin_hash: hashPin(pin, pinSalt),
  };
}

export function generateSingleLoginToken() {
  return crypto.randomBytes(32).toString("hex");
}
