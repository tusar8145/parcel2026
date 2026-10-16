import { Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { RedisService } from "./redis.service";

// Fixed-window counter with optional block, shared by every API instance.
const SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local blockedTtl = redis.call('PTTL', KEYS[2])
if blockedTtl < 0 and hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  blockedTtl = tonumber(ARGV[3])
end
return {hits, ttl, blockedTtl}
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: RedisService) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    const base = `throttle:${throttlerName}:${key}`;
    const [hits, ttlMs, blockedMs] = (await this.redis.eval(SCRIPT, 2, `${base}:hits`, `${base}:blocked`, ttl, limit, blockDuration || ttl)) as number[];
    return {
      totalHits: hits,
      timeToExpire: Math.ceil(Math.max(ttlMs, 0) / 1000),
      isBlocked: blockedMs > 0,
      timeToBlockExpire: Math.ceil(Math.max(blockedMs, 0) / 1000),
    };
  }
}
