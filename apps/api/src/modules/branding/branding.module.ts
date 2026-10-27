import { Global, Module } from "@nestjs/common";
import { BrandingController } from "./branding.controller";
import { BrandingService } from "./branding.service";

/** White label: the company the platform runs for (name, logo, tab icon, contact, About). Used by PDFs and messages too. */
@Global()
@Module({ controllers: [BrandingController], providers: [BrandingService], exports: [BrandingService] })
export class BrandingModule {}
