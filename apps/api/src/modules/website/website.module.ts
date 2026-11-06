import { Global, Module } from "@nestjs/common";
import { WebsiteController } from "./website.controller";
import { WebsiteService } from "./website.service";

/** Website settings; global because sign-up, sign-in, applications and booking all read the switches. */
@Global()
@Module({ controllers: [WebsiteController], providers: [WebsiteService], exports: [WebsiteService] })
export class WebsiteModule {}
