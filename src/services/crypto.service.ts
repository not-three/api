import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import CryptoJS from "crypto-js";

@Injectable()
export class CryptoService {
  decrypt(content: string, key: string): string {
    try {
      const result = CryptoJS.AES.decrypt(content, key).toString(
        CryptoJS.enc.Utf8,
      );
      if (!result) throw new Error("empty result");
      return result;
    } catch {
      throw new HttpException(
        "The decryption key is invalid",
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
