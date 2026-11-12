import { useConfig } from '@/contexts/ConfigContext';
import { SkipSourcePicker } from './SkipSourcePicker';

export function SkipMarkersCard() {
  const { config, setConfig } = useConfig();
  return (
    <div id="skip-markers" className="space-y-3 px-4 py-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">Skip intro and credits</p>
        <p className="text-sm text-muted-foreground">Where intro, recap and credits markers come from. Each lookup sends the title and episode to the services asked.</p>
      </div>
      <SkipSourcePicker
        value={config.jellyfinSkipSource ?? 'auto'}
        inherited="auto"
        main
        hasPmdb={Boolean(config.apiKeys?.publicmetadb)}
        onChange={(next) => setConfig((prev) => ({ ...prev, jellyfinSkipSource: next === 'auto' ? undefined : next }))}
      />
    </div>
  );
}
