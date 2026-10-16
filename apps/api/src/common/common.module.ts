import { Global, Module } from "@nestjs/common";
import { TokenService } from "./auth/token.service";
import { PermissionService } from "./auth/permissions.service";
import { RedisThrottlerStorage } from "./throttler-redis.storage";

@Global()
@Module({ providers: [TokenService, PermissionService, RedisThrottlerStorage], exports: [TokenService, PermissionService, RedisThrottlerStorage] })
export class CommonModule {}
