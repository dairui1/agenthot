import { READING_TITLES, type ItemReading } from "@aihot/contracts/reading";
import { IconExternal } from "../../components/icons";
import { fullDateTime } from "../../lib/format";

export function ReadingBrief({ reading, sourceName }: { reading: ItemReading; sourceName: string }) {
  return (
    <section aria-label="内容解读" className="mt-8 border-t border-line pt-5">
      <p className="text-[12px] leading-6 text-ink-4">
        依据{sourceName}材料整理，非本站独立复现。
        <span className="block">解读更新：<time dateTime={reading.generatedAt}>{fullDateTime(reading.generatedAt)}（UTC+8）</time></span>
      </p>
      {reading.sections.map(section => (
        <section key={section.key} id={`reading-${section.key}`} className="mt-7 scroll-mt-[calc(var(--bar-h)+1.5rem)]">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[18px] font-semibold leading-7 text-ink">{READING_TITLES[section.key]}</h2>
            <span className="text-[11px] text-ink-4">{section.key === "value" ? "编辑解读" : "来源披露"}</span>
          </div>
          <ul className="mt-3 space-y-3">
            {section.items.map((item, index) => (
              <li key={index} className="flex items-start gap-3 text-[15px] leading-[1.85] text-ink-2">
                <span aria-hidden="true" className="mt-[11px] size-1 shrink-0 rounded-full bg-ink-4" />
                <p className="min-w-0 [overflow-wrap:anywhere]">
                  {item.text}
                  <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" title="核对来源依据" aria-label={`核对第 ${index + 1} 条${READING_TITLES[section.key]}的来源依据`} className="ml-1.5 inline-flex min-h-6 min-w-6 items-center justify-center align-middle text-ink-4 transition-colors hover:text-accent">
                    <IconExternal size={13} />
                  </a>
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {reading.links.length > 0 && (
        <section id="reading-links" className="mt-7 scroll-mt-[calc(var(--bar-h)+1.5rem)]">
          <h2 className="text-[18px] font-semibold leading-7 text-ink">使用入口</h2>
          <ul className="mt-2 divide-y divide-line-soft">
            {reading.links.map(link => (
              <li key={link.url}>
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center justify-between gap-3 py-2 text-[14px] leading-6 text-ink-2 transition-colors hover:text-accent">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{link.label}</span>
                  <IconExternal size={15} className="shrink-0" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
