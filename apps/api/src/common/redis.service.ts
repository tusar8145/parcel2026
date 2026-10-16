import { Global, Injectable, Module, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { env } from "../config/env";

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor() {
    // BullMQ requires maxRetriesPerRequest: null on connections it uses.
    super(env().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  }

  async onModuleDestroy() {
    await this.quit().catch(() => this.disconnect());
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
