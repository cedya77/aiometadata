import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Step({ n, last, title, hint, children }: { n: number; last?: boolean; title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-4 sm:gap-5">
      <div className="flex w-7 shrink-0 flex-col items-center" aria-hidden="true">
        <div className="flex h-7 w-7 items-center justify-center rounded-full border border-muted-foreground/30 bg-card text-[13px] font-semibold">{n}</div>
        {last ? null : <div className="my-1.5 w-px flex-1 bg-border" />}
      </div>
      <section className={cn('min-w-0 flex-1 space-y-3.5', last ? '' : 'pb-9')}>
        <div className="space-y-0.5 pt-0.5">
          <h3 className="text-[15px] font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        {children}
      </section>
    </div>
  );
}

export function Reporting({ tone, text, detail }: { tone: 'ok' | 'wait'; text: string; detail?: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'ok' ? 'bg-emerald-400' : 'bg-amber-400')} aria-hidden="true" />
      <span className="text-foreground/80">{text}</span>
      {detail ? <><span className="text-muted-foreground/50" aria-hidden="true">·</span><span className="text-muted-foreground">{detail}</span></> : null}
    </p>
  );
}
