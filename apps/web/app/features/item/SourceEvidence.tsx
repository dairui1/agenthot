import type { ItemProvenance } from "@aihot/contracts/site";
import { IconExternal } from "../../components/icons";

export function SourceEvidence({ provenance }: { provenance: ItemProvenance }) {
  return (
    <section aria-label="分析与证据" className="mt-7 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-3">
        <h2 className="font-semibold">分析与证据</h2>
        <span>{provenance.analysisStatus === "reviewed" ? "已复核" : "分析已完成"}</span>
      </div>
      <p className="mt-2 break-words text-[14px] leading-relaxed text-ink-2">
        <a href={provenance.url} target="_blank" rel="noopener noreferrer" className="font-medium hover:text-accent">{provenance.name}</a>
        {" · "}{provenance.agentId} {provenance.version}
      </p>
      {provenance.dateKind === "captured" && <p className="mt-1 text-[12px] text-ink-3">时间为采集时间，非官方发布日期。</p>}
      <ul className="mt-3 space-y-2">
        {provenance.sources.map((source) => (
          <li key={source.url}>
            <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-start gap-1.5 text-[13px] leading-relaxed text-ink-2 hover:text-accent">
              <span className="min-w-0 break-words">{source.label}</span>
              <IconExternal size={13} className="mt-1 shrink-0" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
