import CryptoJS from "crypto-js";
import { CryptoService } from "./crypto.service";
import { HttpException } from "@nestjs/common";

describe("CryptoService", () => {
  const svc = new CryptoService();

  it("decrypts content that was encrypted with the given key", () => {
    const ciphertext = CryptoJS.AES.encrypt("secret note", "pw123").toString();
    // Same argument order as the fetch controller: (note content, user key)
    expect(svc.decrypt(ciphertext, "pw123")).toBe("secret note");
  });

  it("throws 401 for a wrong key", () => {
    const ciphertext = CryptoJS.AES.encrypt("secret note", "pw123").toString();
    expect(() => svc.decrypt(ciphertext, "wrong")).toThrow(HttpException);
  });

  it("throws 401 for garbage input", () => {
    expect(() => svc.decrypt("not-a-ciphertext", "pw123")).toThrow(
      HttpException,
    );
  });
});
