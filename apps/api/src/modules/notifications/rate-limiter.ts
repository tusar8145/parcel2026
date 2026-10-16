import { Injectable } from "@nestjs/common";
import { RedisService } from "../../common/redis.service";
import type { SmsLimits } from "./notification-settings.service";

export type RateDecision = { action: "send" } | { action: "wait"; waitMs: number; reason: string } | { action: "drop"; reason: string };

/**
 * One atomic check-and-count per SMS (Lua), so parallel workers can't overshoot:
 *  - per recipient: minimum spacing, hourly and daily caps (skipped for critical messages
 *    like codes, which still count towards them),
 *  - global: messages per minute through the gateway.
 * Returns {0} send, {1, waitMs, reasonIndex} wait, {2} drop.
 */
const SCRIPT = `
local now = tonumber(ARGV[1])
local critical = ARGV[2] == '1'
local interval = tonumber(ARGV[3])
local hourCap = tonumber(ARGV[4])
local dayCap = tonumber(ARGV[5])
local globalCap = tonumber(ARGV[6])
if not critical then
  local last = tonumber(redis.call('GET', KEYS[1]) or '0')
  if interval > 0 and last > 0 and now - last < interval then return {1, interval - (now - last), 1} end
  local d = tonumber(redis.call('GET', KEYS[3]) or '0')
  if dayCap > 0 and d >= dayCap then return {2, 0, 3} end
  local h = tonumber(redis.call('GET', KEYS[2]) or '0')
  if hourCap > 0 and h >= hourCap then return {1, tonumber(ARGV[7]), 2} end
end
local g = tonumber(redis.call('GET', KEYS[4]) or '0')
if globalCap > 0 and g >= globalCap then return {1, tonumber(ARGV[8]), 4} end
redis.call('SET', KEYS[1], now, 'PX', math.max(interval, 1000))
if redis.call('INCR', KEYS[2]) == 1 then redis.call('PEXPIRE', KEYS[2], 3700000) end
if redis.call('INCR', KEYS[3]) == 1 then redis.call('PEXPIRE', KEYS[3], 90000000) end
if redis.call('INCR', KEYS[4]) == 1 then redis.call('PEXPIRE', KEYS[4], 120000) end
return {0, 0, 0}
`;

const REASONS = ["", "minimum spacing between messages to this number", "hourly limit for this number", "daily limit for this number", "platform SMS throughput limit"];
const HOUR = 3_600_000;
const DAY = 86_400_000;
const DHAKA_OFFSET = 6 * HOUR;

@Injectable()
export class SmsRateLimiter {
  constructor(private readonly redis: RedisService) {}

  async check(to: string, critical: boolean, limits: SmsLimits, now = Date.now()): Promise<RateDecision> {
    const hour = Math.floor(now / HOUR);
    const day = Math.floor((now + DHAKA_OFFSET) / DAY); // calendar day in Dhaka
    const minute = Math.floor(now / 60_000);
    const keys = [`sms:rl:last:${to}`, `sms:rl:h:${hour}:${to}`, `sms:rl:d:${day}:${to}`, `sms:rl:g:${minute}`];
    const untilNextHour = (hour + 1) * HOUR - now + 1000;
    const untilNextMinute = (minute + 1) * 60_000 - now + Math.floor(Math.random() * 2000);
    const [code, waitMs, reason] = (await this.redis.eval(
      SCRIPT,
      keys.length,
      ...keys,
      now,
      critical ? 1 : 0,
      limits.minIntervalSeconds * 1000,
      limits.perRecipientPerHour,
      limits.perRecipientPerDay,
      limits.globalPerMinute,
      untilNextHour,
      untilNextMinute,
    )) as [number, number, number];
    if (code === 0) return { action: "send" };
    if (code === 2) return { action: "drop", reason: REASONS[reason] };
    return { action: "wait", waitMs: Math.max(250, Number(waitMs)), reason: REASONS[reason] };
  }
}
