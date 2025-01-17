import { Injectable } from '@nestjs/common';
import { BaseConfig } from 'src/config/Base';
import * as dotenv from 'dotenv';

@Injectable()
export class ConfigService {
  private config: BaseConfig | null = null;

  get() {
    if (this.config) return this.config;
    dotenv.config();
    this.config = new BaseConfig();
    return this.config;
  }
}
