import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import CryptoJS from "crypto-js";

@Injectable()
export class CryptoService {
  decrypt(key: string, data: string): string {
    try {
      return CryptoJS.AES.decrypt(data, key).toString(CryptoJS.enc.Utf8);
    } catch {
      throw new HttpException(
        "The decryption key is invalid",
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
