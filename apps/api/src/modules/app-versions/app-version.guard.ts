import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AppVersionsService } from "./app-versions.service";

/** Runs on every request: an Android app older than its minimum version is refused with the download link. */
@Injectable()
export class AppVersionGuard implements CanActivate {
  constructor(private readonly versions: AppVersionsService) {}

  async canActivate(ctx: ExecutionContext) {
    if (ctx.getType() !== "http") return true;
    const headers = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>().headers;
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim().toLowerCase();
    await this.versions.check(one(headers["x-app"]), one(headers["x-app-version"]));
    return true;
  }
}
