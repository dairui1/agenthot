import { defineServerModule } from "@aihot/backend/modules";
import { DraftSchema, materialOf, PROMPT, validateReading, VERSION } from "./content.ts";
import { itemReading } from "./service.ts";

export const reading = defineServerModule({
  name: "reading",
  itemReading,
  understandExtension(input, visible) {
    if (input.bodyStatus !== "ok" || !input.bodyText?.trim()) return null;
    const material = materialOf(input.title, input.url, input.bodyText, input.bodyHtml);
    return { version: VERSION, schema: DraftSchema,
      system: `${PROMPT}\n允许链接：${JSON.stringify(material.links)}`,
      normalize: value => validateReading(value, material, visible) };
  },
});
