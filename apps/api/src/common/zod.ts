import { applyDecorators, ArgumentMetadata, Body, Injectable, PipeTransform, Query } from "@nestjs/common";
import { ApiBody, ApiQuery } from "@nestjs/swagger";
import { z, type ZodType } from "zod";

@Injectable()
export class ZodPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _meta: ArgumentMetadata): z.infer<T> {
    return this.schema.parse(value ?? {}); // ZodError -> 422 in AllExceptionsFilter
  }
}

const jsonSchema = (schema: ZodType) => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;

/** Validated request body that is also documented in OpenAPI. */
export const ZBody = <T extends ZodType>(schema: T) => Body(new ZodPipe(schema));
export const ApiZodBody = (schema: ZodType) => applyDecorators(ApiBody({ schema: jsonSchema(schema) }));

/** Validated query string. */
export const ZQuery = <T extends ZodType>(schema: T) => Query(new ZodPipe(schema));
export function ApiZodQuery(schema: z.ZodObject) {
  const properties = (jsonSchema(schema).properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((jsonSchema(schema).required as string[] | undefined) ?? []);
  return applyDecorators(
    ...Object.entries(properties).map(([name, s]) => ApiQuery({ name, required: required.has(name), schema: s })),
  );
}
