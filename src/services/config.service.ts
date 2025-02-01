import { Injectable } from "@nestjs/common";
import { BaseConfig } from "src/config/Base";

@Injectable()
export class ConfigService {
  private config: BaseConfig | null = null;

  get() {
    if (this.config) return this.config;
    this.config = new BaseConfig();
    return this.config;
  }
}
