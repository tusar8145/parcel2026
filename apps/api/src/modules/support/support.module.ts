import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";
import { SupportController, SupportStaffController } from "./support.controller";
import { SupportService } from "./support.service";
import { SupportDeskController } from "./support-desk.controller";
import { SupportDeskService } from "./support-desk.service";

@Module({
  imports: [ParcelsModule],
  controllers: [SupportController, SupportStaffController, SupportDeskController, FilesController],
  providers: [SupportService, SupportDeskService, FilesService],
  exports: [SupportService],
})
export class SupportModule {}
