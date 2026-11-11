import { Module } from "@nestjs/common";
import { AppVersionsController } from "./app-versions.controller";
import { AppVersionsService } from "./app-versions.service";
import { AppVersionGuard } from "./app-version.guard";

/** Forced updates of the Android apps (minimum versions; see app-versions.service.ts). */
@Module({
  controllers: [AppVersionsController],
  providers: [AppVersionsService, AppVersionGuard],
  exports: [AppVersionsService, AppVersionGuard],
})
export class AppVersionsModule {}
