import { Module } from "@nestjs/common";
import { FileSharesController } from "./file-shares.controller";
import { FileSharesService } from "./file-shares.service";

@Module({ controllers: [FileSharesController], providers: [FileSharesService] })
export class FileSharesModule {}
