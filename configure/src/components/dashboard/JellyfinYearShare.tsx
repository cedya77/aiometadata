import { lazy, Suspense, useEffect, useState } from "react";
import { Download, Loader2, Play, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDashboardArt } from "@/hooks/useDashboardQueries";
import { CARD_HEIGHT, CARD_WIDTH, drawShareCard } from "./yearShareCard";
import type { YearModel } from "./yearModel";

const YearStory = lazy(() => import("./JellyfinYearStory"));

const SOLID_BUTTON = "inline-flex h-11 items-center gap-2 rounded-full bg-[#f1f2f4] px-5 text-sm font-semibold text-[#0c0d0f] transition-opacity hover:opacity-90 disabled:opacity-60";
const GLASS_BUTTON = "inline-flex h-11 items-center gap-2 rounded-full bg-white/[0.08] px-5 text-sm font-semibold text-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] backdrop-blur-xl transition-colors hover:bg-white/[0.12]";

export function YearTakeaway({ model, owner }: { model: YearModel; owner: string }) {
  const load = useDashboardArt();
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<{ file: File; url: string } | null>(null);
  const [story, setStory] = useState(false);
  useEffect(() => () => { if (card) URL.revokeObjectURL(card.url); }, [card]);

  const make = async () => {
    setBusy(true);
    try {
      const blob = await drawShareCard(model, owner, load);
      const name = `${owner}-${model.year}-year-in-review`.replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/-+/g, "-");
      setCard({ file: new File([blob], `${name}.png`, { type: "image/png" }), url: URL.createObjectURL(blob) });
    } catch {
      toast.error("Could not make the share card");
    } finally {
      setBusy(false);
    }
  };
  const canShare = !!card && typeof navigator.canShare === "function" && navigator.canShare({ files: [card.file] });
  const save = () => {
    if (!card) return;
    const link = document.createElement("a");
    link.href = card.url;
    link.download = card.file.name;
    link.click();
  };
  const share = async () => {
    if (!card) return;
    try {
      await navigator.share({ files: [card.file], title: `${model.year} year in review` });
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") toast.error("Could not open the share sheet");
    }
  };

  return (
    <section className="px-4 pt-16 sm:px-6 lg:px-12">
      <div className="flex flex-wrap items-center justify-between gap-6 rounded-[28px] p-6 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] sm:p-10" style={{ background: "linear-gradient(120deg, rgba(37,99,235,0.28), rgba(251,191,36,0.12))" }}>
        <div>
          <p className="text-2xl font-extrabold tracking-[-0.03em] sm:text-[32px]">Take your year with you.</p>
          <p className="mt-1.5 text-[15px] text-foreground/75">A share card for anywhere, or the whole year as a story.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => void make()} disabled={busy} className={SOLID_BUTTON}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Download share card
          </button>
          <button type="button" onClick={() => setStory(true)} className={GLASS_BUTTON}>
            <Play className="size-4" /> Play as a story
          </button>
        </div>
      </div>
      {story && (
        <Suspense fallback={null}>
          <YearStory model={model} owner={owner} onClose={() => setStory(false)} onShare={() => { setStory(false); void make(); }} />
        </Suspense>
      )}
      <Dialog open={!!card} onOpenChange={(open) => { if (!open) setCard(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Your {model.year} share card</DialogTitle>
            <DialogDescription>{CARD_WIDTH} × {CARD_HEIGHT}, sized for a post.</DialogDescription>
          </DialogHeader>
          {card && <img src={card.url} alt={`${owner}'s ${model.year} year in review`} className="w-full rounded-xl" />}
          <DialogFooter className="gap-2 sm:gap-2">
            {canShare && <button type="button" onClick={() => void share()} className={GLASS_BUTTON}><Share2 className="size-4" /> Share</button>}
            <button type="button" onClick={save} className={SOLID_BUTTON}><Download className="size-4" /> Save image</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
