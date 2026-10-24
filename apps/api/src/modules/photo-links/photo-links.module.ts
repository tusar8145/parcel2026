import { Module } from "@nestjs/common";
import { PhotoLinksController } from "./photo-links.controller";
import { PhotoLinksService } from "./photo-links.service";

@Module({ controllers: [PhotoLinksController], providers: [PhotoLinksService] })
export class PhotoLinksModule {}
