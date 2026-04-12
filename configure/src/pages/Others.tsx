import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useConfig } from "@/contexts/ConfigContext";
import { AgeRatingSelect } from "@/components/AgeRatingSelect";
import { SearchToggle } from "@/components/SearchToggle";

const Others = () => {
  const { config, setConfig } = useConfig();

  const setBooleanField = (
    key: "includeAdult" | "blurThumbs" | "showPrefix" | "displayAgeRating",
    value: boolean
  ) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <main className="md:p-12 px-2 py-12">
      <div className="flex flex-col mb-6">
        <h1 className="text-xl font-semibold mb-1">Addon Settings</h1>
        <p className="text-gray-500 text-sm">
          Customize the addon settings to suit your needs.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <SearchToggle />
        <Card className="flex flex-row items-center justify-between p-6">
          <div className="space-y-0.5">
            <h1 className="text-sm font-semibold mb-1">Enable adult content</h1>
            <p className="text-gray-500 text-sm">
              Include adult content in search results.
            </p>
          </div>
          <Switch
            checked={config.includeAdult}
            onCheckedChange={(checked) => setBooleanField("includeAdult", checked)}
          />
        </Card>
        <Card className="flex flex-row items-center justify-between p-6">
          <div className="space-y-0.5">
            <label className="text-sm font-semibold mb-1">Blur thumbnails</label>
            <p className="text-gray-500 text-sm">
              Blur image-heavy artwork in the configure UI.
            </p>
          </div>
          <Switch
            checked={config.blurThumbs}
            onCheckedChange={(checked) => setBooleanField("blurThumbs", checked)}
          />
        </Card>
        <Card className="flex flex-row items-center justify-between p-4 sm:p-6 hover:shadow-lg transition-shadow cursor-pointer">
          <div className="space-y-0.5">
            <h1 className="text-sm font-semibold mb-1">Show provider prefix</h1>
            <p className="text-gray-500 text-sm">
              Prefix catalog names so provider origin is more obvious.
            </p>
          </div>
          <Switch
            checked={config.showPrefix}
            onCheckedChange={(checked) => setBooleanField("showPrefix", checked)}
          />
        </Card>
        <Card className="flex flex-row items-center justify-between p-4 sm:p-6 hover:shadow-lg transition-shadow cursor-pointer">
          <div className="space-y-0.5">
            <h1 className="text-sm font-semibold mb-1">Show age ratings</h1>
            <p className="text-gray-500 text-sm">
              Display age-rating metadata when available.
            </p>
          </div>
          <Switch
            checked={config.displayAgeRating}
            onCheckedChange={(checked) => setBooleanField("displayAgeRating", checked)}
          />
        </Card>
        <Card className="flex flex-row items-center justify-between p-6">
          <div className="space-y-0.5">
            <h1 className="text-sm font-semibold mb-1">Cast count to show</h1>
            <p className="text-gray-500 text-sm">
              Number of cast members to display.
            </p>
          </div>
          <select
            className="border rounded px-2 py-1 text-sm"
            value={config.castCount}
            onChange={(e) => {
              setConfig((prev) => ({
                ...prev,
                castCount: Number(e.target.value),
              }));
            }}
          >
            <option value={0}>0</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={15}>15</option>
          </select>
        </Card>
        <Card className="p-6">
          <AgeRatingSelect />
        </Card>
      </div>
    </main>
  );
};

export default Others;
