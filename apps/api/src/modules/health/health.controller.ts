import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import { Public } from "../../common/auth/decorators";
import { PrismaService } from "../../common/prisma.service";
import { RedisService } from "../../common/redis.service";

@ApiTags("health")
@SkipThrottle()
@Public()
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is up. */
  @Get("live")
  live() {
    return { status: "ok" };
  }

  /** Readiness: dependencies are reachable. */
  @Get("ready")
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const check = async (fn: () => Promise<unknown>) => {
      const started = Date.now();
      try {
        await fn();
        return { status: "up", latencyMs: Date.now() - started };
      } catch (error) {
        return { status: "down", error: (error as Error).message };
      }
    };
    const [database, redis] = await Promise.all([check(() => this.prisma.$queryRaw`SELECT 1`), check(() => this.redis.ping())]);
    const ok = database.status === "up" && redis.status === "up";
    reply.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? "ok" : "degraded", checks: { database, redis } };
  }
}
