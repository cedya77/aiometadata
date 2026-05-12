import { useState, useRef, useEffect } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from '@/components/ui/badge';
import { Loader2, Sparkles, Check, AlertCircle } from 'lucide-react';
import { toast } from "sonner";
import { motion, AnimatePresence } from 'framer-motion';

interface AICatalogDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const EXAMPLE_PROMPTS = [
  "Top Pixar movies sorted by rating",
  "Trending horror movies from 2020 onwards",
  "Currently airing anime from MAPPA",
  "Popular Korean dramas on Netflix",
  "Best sci-fi series of the 90s",
  "Give me horror, comedy, and thriller catalogs",
  "Top rated anime movies on MAL",
  "A24 movies sorted by popularity",
];

type DialogState = 'idle' | 'generating' | 'resolving' | 'success' | 'error';

export function AICatalogDialog({ isOpen, onClose }: AICatalogDialogProps) {
  const { config, setConfig, auth } = useConfig();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<DialogState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [createdCatalogs, setCreatedCatalogs] = useState<Array<{ name: string; source: string }>>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [exampleIndex, setExampleIndex] = useState(0);

  const hasBothProviders = !!(config.apiKeys?.openrouter && config.apiKeys?.gemini);
  const defaultProvider = config.apiKeys?.openrouter ? 'openrouter' : 'gemini';
  const [provider, setProvider] = useState<'openrouter' | 'gemini'>(defaultProvider);

  useEffect(() => {
    if (isOpen) {
      setExampleIndex(Math.floor(Math.random() * EXAMPLE_PROMPTS.length));
      setState('idle');
      setError(null);
      setCreatedCatalogs([]);
      setWarnings([]);
      setProvider(defaultProvider);
    }
  }, [isOpen]);

  const providerLabel = provider === 'openrouter' ? 'OpenRouter' : 'Gemini';

  const handleCreate = async () => {
    if (!query.trim()) return;

    setState('generating');
    setError(null);
    setCreatedCatalogs([]);
    setWarnings([]);

    try {
      setState('generating');

      const response = await fetch('/api/ai/create-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userUUID: auth.userUUID,
          password: auth.password,
          query: query.trim(),
          provider,
          availableSources: {
            tmdb: !!config.apiKeys?.tmdb?.trim(),
            tvdb: !!config.apiKeys?.tvdb?.trim(),
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        const msg = data.warnings?.length
          ? `${data.error}. ${data.warnings.join('. ')}`
          : data.error || 'Failed to create catalog';
        throw new Error(msg);
      }

      setState('resolving');
      await new Promise(r => setTimeout(r, 300));

      const catalogs = data.catalogs || [];
      if (catalogs.length === 0) {
        throw new Error('No catalogs were generated');
      }

      setConfig(prev => ({
        ...prev,
        catalogs: [...prev.catalogs, ...catalogs],
      }));

      setCreatedCatalogs(catalogs.map((c: any) => ({ name: c.name, source: c.source })));
      if (data.warnings?.length) setWarnings(data.warnings);
      setState('success');

      const count = catalogs.length;
      toast.success(
        count === 1 ? 'AI Catalog created' : `${count} AI Catalogs created`,
        { description: catalogs.map((c: any) => c.name).join(', ') }
      );
    } catch (err: any) {
      setState('error');
      setError(err.message || 'Something went wrong');
    }
  };

  const handleExampleClick = (example: string) => {
    setQuery(example);
    textareaRef.current?.focus();
  };

  const handleClose = () => {
    setQuery('');
    setState('idle');
    setError(null);
    onClose();
  };

  const visibleExamples = [
    EXAMPLE_PROMPTS[exampleIndex % EXAMPLE_PROMPTS.length],
    EXAMPLE_PROMPTS[(exampleIndex + 1) % EXAMPLE_PROMPTS.length],
    EXAMPLE_PROMPTS[(exampleIndex + 2) % EXAMPLE_PROMPTS.length],
    EXAMPLE_PROMPTS[(exampleIndex + 3) % EXAMPLE_PROMPTS.length],
  ];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-purple-500" />
            AI Catalog Builder
          </DialogTitle>
          <DialogDescription>
            Describe what you want to watch and AI will create the perfect catalog for you.
            You can request up to 5 catalogs at once.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <AnimatePresence mode="wait">
            {state === 'success' ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-3"
              >
                <div className="flex items-center gap-2 text-green-500">
                  <Check className="h-5 w-5" />
                  <span className="font-medium">
                    {createdCatalogs.length === 1 ? 'Catalog created!' : `${createdCatalogs.length} catalogs created!`}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {createdCatalogs.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <Badge variant="secondary" className="text-xs">{c.source.toUpperCase()}</Badge>
                      <span>{c.name}</span>
                    </div>
                  ))}
                </div>
                {warnings.length > 0 && (
                  <div className="text-xs text-muted-foreground mt-2">
                    {warnings.map((w, i) => <p key={i}>{w}</p>)}
                  </div>
                )}
                <div className="flex gap-2 pt-2">
                  <Button size="sm" variant="outline" onClick={() => { setState('idle'); setQuery(''); }}>
                    Create more
                  </Button>
                  <Button size="sm" onClick={handleClose}>
                    Done
                  </Button>
                </div>
              </motion.div>
            ) : (
              <motion.div key="form" initial={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
                <div className="space-y-2">
                  <textarea
                    ref={textareaRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`e.g. "${EXAMPLE_PROMPTS[exampleIndex]}"`}
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                    disabled={state === 'generating' || state === 'resolving'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && query.trim()) {
                        e.preventDefault();
                        handleCreate();
                      }
                    }}
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {visibleExamples.map((example) => (
                      <button
                        key={example}
                        onClick={() => handleExampleClick(example)}
                        disabled={state === 'generating' || state === 'resolving'}
                        className="text-xs px-2 py-1 rounded-md bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>

                {state === 'error' && error && (
                  <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-md p-3">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  {hasBothProviders ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setProvider('openrouter')}
                        className={`text-xs px-2 py-1 rounded-md transition-colors ${provider === 'openrouter' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                        disabled={state === 'generating' || state === 'resolving'}
                      >
                        OpenRouter
                      </button>
                      <button
                        onClick={() => setProvider('gemini')}
                        className={`text-xs px-2 py-1 rounded-md transition-colors ${provider === 'gemini' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                        disabled={state === 'generating' || state === 'resolving'}
                      >
                        Gemini
                      </button>
                    </div>
                  ) : (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      via {providerLabel}
                    </Badge>
                  )}
                  <Button
                    onClick={handleCreate}
                    disabled={!query.trim() || state === 'generating' || state === 'resolving'}
                    size="sm"
                  >
                    {(state === 'generating' || state === 'resolving') ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {state === 'generating' ? 'Generating...' : 'Resolving...'}
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4 mr-2" />
                        Create
                      </>
                    )}
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  );
}
