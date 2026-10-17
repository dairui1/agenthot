/** Original editorial interpretation, not a licence to redistribute the source article. */
export const READING_TITLES = { changes: "具体变化", value: "实际价值", limitations: "限制与证据" } as const;
export interface ItemReading {
  version: 1;
  generatedAt: string;
  sections: Array<{
    key: "changes" | "value" | "limitations";
    items: Array<{ text: string; sourceUrl: string }>;
  }>;
  links: Array<{ label: string; url: string }>;
}
