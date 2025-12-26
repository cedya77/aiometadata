import React, { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

type StarRatingProps = {
  value: number;
  onChange: (v: number) => void;
  max?: number;
};

function StarRating({ value, onChange, max = 10 }: StarRatingProps) {
  const [hoverScore, setHoverScore] = React.useState<number | null>(null);

  const display = hoverScore ?? value;

  const handleMove = (e: React.MouseEvent, index: number) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const half = x < rect.width / 2 ? 0.5 : 1;
    const score = index - (half === 0.5 ? 0.5 : 0);
    setHoverScore(score);
  };

  const handleLeave = () => setHoverScore(null);

  const handleClick = (e: React.MouseEvent, index: number) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const half = x < rect.width / 2 ? 0.5 : 1;
    const newScore = index - (half === 0.5 ? 0.5 : 0);
    onChange(newScore);
  };

  const Star = ({ fill }: { fill: 0 | 50 | 100 }) => (
    <div className="relative w-8 h-8 sm:w-10 sm:h-10 flex-shrink-0">
      <div className="transition-transform duration-150 hover:scale-110">
        <svg viewBox="0 0 24 24" className="w-8 h-8 sm:w-10 sm:h-10 text-muted-foreground/40 dark:text-muted-foreground/30">
          <path d="M12 .587l3.668 7.431L24 9.748l-6 5.847L19.335 24 12 19.897 4.665 24 6 15.595 0 9.748l8.332-1.73z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ width: `${fill}%` }}>
          <svg viewBox="0 0 24 24" className="w-8 h-8 sm:w-10 sm:h-10 text-cyan-400 dark:text-cyan-500 drop-shadow-lg">
          <path d="M12 .587l3.668 7.431L24 9.748l-6 5.847L19.335 24 12 19.897 4.665 24 6 15.595 0 9.748l8.332-1.73z" fill="currentColor" />
        </svg>
        </div>
      </div>
    </div>
  );

  const stars = [];
  for (let i = 1; i <= max; i++) {
    let fill: 0 | 50 | 100 = 0;
    if (display >= i) fill = 100;
    else if (display >= i - 0.5) fill = 50;

    stars.push(
      <div
        key={i}
        onMouseMove={(e) => handleMove(e, i)}
        onMouseLeave={handleLeave}
        onClick={(e) => handleClick(e, i)}
        className="inline-flex items-center justify-center px-1 sm:px-1.5 cursor-pointer touch-manipulation flex-shrink-0"
        role="button"
        aria-label={`Rate ${i} star${i > 1 ? "s" : ""}`}
      >
        <Star fill={fill} />
      </div>
    );
  }

  return <div className="flex items-center justify-center gap-1 sm:gap-1.5 flex-nowrap w-full overflow-x-auto scrollbar-hide py-2">{stars}</div>;
}

export default function RatingPage(): JSX.Element {
  const [uuid, setUuid] = useState<string>((window as any).RATING_USER || "");
  const [stremioId, setStremioId] = useState<string>((window as any).RATING_ID || "");
  const [type, setType] = useState<string>((window as any).RATING_TYPE || "Series");
  const [title, setTitle] = useState<string>((window as any).RATING_TITLE || "");
  const [poster, setPoster] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [score, setScore] = useState<number>((window as any).RATING_SCORE || 8);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [availableServices, setAvailableServices] = useState<{
    trakt: boolean;
    anilist: boolean;
    mdblist: boolean;
  }>({
    trakt: false,
    anilist: false,
    mdblist: false
  });
  const [selectedServices, setSelectedServices] = useState<{
    trakt: boolean;
    anilist: boolean;
    mdblist: boolean;
  }>({
    trakt: true,
    anilist: true,
    mdblist: true
  });
  const [posterColors, setPosterColors] = useState<{
    color1: string;
    color2: string;
    color3: string;
  } | null>(null);

  // Extract colors from poster image
  useEffect(() => {
    if (!poster) {
      setPosterColors(null);
      return;
    }

    const extractColors = async () => {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          // Sample a smaller area for performance
          canvas.width = 100;
          canvas.height = 100;
          ctx.drawImage(img, 0, 0, 100, 100);

          const imageData = ctx.getImageData(0, 0, 100, 100);
          const data = imageData.data;
          
          // Extract dominant colors using a simple algorithm
          const colorMap = new Map<string, number>();
          
          // Sample every 4th pixel for performance
          for (let i = 0; i < data.length; i += 16) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            
            // Skip transparent pixels
            if (a < 128) continue;
            
            // Quantize colors to reduce noise
            const qr = Math.floor(r / 32) * 32;
            const qg = Math.floor(g / 32) * 32;
            const qb = Math.floor(b / 32) * 32;
            const key = `${qr},${qg},${qb}`;
            
            colorMap.set(key, (colorMap.get(key) || 0) + 1);
          }
          
          // Get top 3 most frequent colors
          const sortedColors = Array.from(colorMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);
          
          if (sortedColors.length >= 3) {
            const colors = sortedColors.map(([key]) => {
              const [r, g, b] = key.split(',').map(Number);
              return { r, g, b };
            });
            
            setPosterColors({
              color1: `rgba(${colors[0].r}, ${colors[0].g}, ${colors[0].b}, 0.15)`,
              color2: `rgba(${colors[1].r}, ${colors[1].g}, ${colors[1].b}, 0.10)`,
              color3: `rgba(${colors[2].r}, ${colors[2].g}, ${colors[2].b}, 0.15)`
            });
          } else {
            // Fallback to teal/cyan if extraction fails
            setPosterColors({
              color1: 'rgba(6, 182, 212, 0.15)', // cyan-500
              color2: 'rgba(20, 184, 166, 0.10)', // teal-500
              color3: 'rgba(6, 182, 212, 0.15)'  // cyan-500
            });
          }
        };
        
        img.onerror = () => {
          // Fallback to teal/cyan on error
          setPosterColors({
            color1: 'rgba(6, 182, 212, 0.15)',
            color2: 'rgba(20, 184, 166, 0.10)',
            color3: 'rgba(6, 182, 212, 0.15)'
          });
        };
        
        img.src = poster;
      } catch (error) {
        // Fallback to teal/cyan on error
        setPosterColors({
          color1: 'rgba(6, 182, 212, 0.15)',
          color2: 'rgba(20, 184, 166, 0.10)',
          color3: 'rgba(6, 182, 212, 0.15)'
        });
      }
    };

    extractColors();
  }, [poster]);

  useEffect(() => {
    if ((window as any).RATING_USER) setUuid((window as any).RATING_USER);
    if ((window as any).RATING_ID) setStremioId((window as any).RATING_ID);
    if ((window as any).RATING_TYPE) setType((window as any).RATING_TYPE);
    if ((window as any).RATING_SCORE) setScore((window as any).RATING_SCORE);
    
    // Get poster and description from injected window variables (like dashboard content tab)
    if ((window as any).RATING_TITLE) {
      setTitle((window as any).RATING_TITLE);
    }
    if ((window as any).RATING_POSTER) {
      setPoster((window as any).RATING_POSTER);
    }
    if ((window as any).RATING_DESCRIPTION) {
      setDescription((window as any).RATING_DESCRIPTION);
    }
    
    // Get available services from injected window variables
    if ((window as any).RATING_AVAILABLE_SERVICES) {
      const services = (window as any).RATING_AVAILABLE_SERVICES;
      setAvailableServices(services);
      // Set selected services to match available ones (all selected by default)
      setSelectedServices({
        trakt: services.trakt,
        anilist: services.anilist,
        mdblist: services.mdblist
      });
    }
    
    setLoading(false);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch(`/stremio/${uuid}/rating`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          ids: { stremio: stremioId }, 
          type, 
          score,
          services: selectedServices
        }),
      });
      const data = await res.json();
      setResult(data?.ok ? "Rating submitted successfully!" : data?.error || "Error submitting rating");
    } catch (err) {
      setResult("Error submitting rating");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-background via-background to-background/95 dark:from-background dark:via-background dark:to-background/98">
        <Card className="w-full max-w-4xl mx-4 border border-border/50 dark:border-border/30 bg-card/60 dark:bg-card/80 backdrop-blur-xl shadow-2xl">
          <CardContent className="p-6 sm:p-12">
            <div className="flex items-center justify-center">
              <div className="text-muted-foreground text-base sm:text-lg">Loading...</div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleClose = () => {
    // Try to close the window (works if opened by script)
    if (window.opener) {
      window.close();
    } else {
      // Fallback: try to go back in history
      if (window.history.length > 1) {
        window.history.back();
      } else {
        // Last resort: redirect to configure page
        window.location.href = '/configure';
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-background/95 dark:from-background dark:via-background dark:to-background/98 flex items-start justify-center p-2 sm:p-4 md:p-6 pt-2 sm:pt-4 pb-4 sm:pb-6">
      <div className="w-full max-w-4xl mt-2 sm:mt-4">
        <Card className="border border-border/50 dark:border-border/30 bg-card/60 dark:bg-card/80 backdrop-blur-xl shadow-2xl overflow-hidden">
          <div className="relative">
            {/* Subtle color gradient overlay using extracted poster colors */}
            {posterColors && (
              <div 
                className="absolute inset-0 blur-2xl"
                style={{
                  background: `linear-gradient(to bottom right, ${posterColors.color1}, ${posterColors.color2}, ${posterColors.color3})`
                }}
              />
            )}
            
            <div className="relative z-10">
              {/* Close Button */}
              <div className="flex justify-end p-3 sm:p-4 md:p-6">
                <Button
                  type="button"
                  onClick={handleClose}
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-full w-8 h-8 sm:w-10 sm:h-10 p-0"
                  aria-label="Close rating page"
                >
                  <svg 
                    xmlns="http://www.w3.org/2000/svg" 
                    className="h-5 w-5 sm:h-6 sm:w-6" 
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor" 
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </Button>
              </div>
              
        <form onSubmit={handleSubmit}>
                <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-4 sm:gap-6 p-3 sm:p-5 md:p-6 lg:p-8">
                  {/* Poster Section */}
                  {poster && (
                    <div className="flex justify-center md:justify-start order-1 md:order-1">
                      <div className="relative group w-full max-w-[180px] sm:max-w-[200px] md:max-w-[240px]">
                        <img
                          src={poster}
                          alt={title || "Poster"}
                          className="relative w-full h-auto rounded-xl object-cover transform transition-transform duration-300 group-hover:scale-[1.02] shadow-sm"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      </div>
                    </div>
                  )}
                  
                  {/* Content Section */}
                  <div className="flex flex-col gap-4 sm:gap-5 order-2 md:order-2">
                    {/* Title */}
                    <div className="space-y-2">
                      <CardTitle className="text-xl sm:text-2xl md:text-3xl lg:text-4xl font-extrabold bg-gradient-to-r from-foreground to-foreground/80 dark:from-foreground dark:to-foreground/70 bg-clip-text text-transparent break-words">
                        {title || "Rate This Title"}
                      </CardTitle>
                      {type && (
                        <div className="inline-block px-2 sm:px-2.5 py-0.5 rounded-full bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary text-xs font-medium">
                          {(type.toLowerCase() === 'series' || type === 'series') ? 'TV Series' : 'Movie'}
                        </div>
                      )}
                    </div>
                    
                    {/* Description */}
                    {description && (
                      <div className="text-xs sm:text-sm md:text-base text-muted-foreground leading-relaxed line-clamp-3 sm:line-clamp-4 pr-1">
                        {description}
                      </div>
                    )}
                    
                    {/* Rating Section */}
                    <div className="flex flex-col gap-4 sm:gap-5 pt-2">
                      <div className="flex flex-col items-center gap-3 sm:gap-4">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          Your Rating
                        </div>
                        <div className="w-full">
                  <StarRating value={score} onChange={setScore} />
                        </div>
                        <div className="flex items-baseline gap-2 mt-1 sm:mt-2">
                          <span className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-cyan-400 to-cyan-500 dark:from-cyan-500 dark:to-cyan-600 bg-clip-text text-transparent">
                            {score}
                          </span>
                          <span className="text-base sm:text-lg text-muted-foreground">/ 10</span>
                        </div>
                      </div>
                      
                      {/* Service Selector */}
                      {(availableServices.trakt || availableServices.anilist || availableServices.mdblist) && (
                        <div className="flex flex-col gap-2 sm:gap-3 pt-2 border-t border-border/50 dark:border-border/30">
                          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            Send to Services
                          </div>
                          <div className="flex flex-col gap-2">
                            {availableServices.trakt && (
                              <div className="flex items-center justify-between p-2.5 sm:p-3 rounded-lg bg-muted/30 dark:bg-muted/20 border border-border/30">
                                <Label htmlFor="trakt-service" className="text-sm font-medium cursor-pointer flex-1 flex items-center gap-2.5">
                                  <img 
                                    src="https://trakt.tv/assets/logos/logomark.square.gradient-b644b16c38ff775861b4b1f58c1230f6a097a2466ab33ae00445a505c33fcb91.svg" 
                                    alt="Trakt" 
                                    className="w-5 h-5 flex-shrink-0"
                                    onError={(e) => {
                                      (e.target as HTMLImageElement).style.display = 'none';
                                    }}
                                  />
                                  Trakt
                                </Label>
                                <Switch
                                  id="trakt-service"
                                  checked={selectedServices.trakt}
                                  onCheckedChange={(checked) => 
                                    setSelectedServices(prev => ({ ...prev, trakt: checked }))
                                  }
                                />
                              </div>
                            )}
                            {availableServices.anilist && (
                              <div className="flex items-center justify-between p-2.5 sm:p-3 rounded-lg bg-muted/30 dark:bg-muted/20 border border-border/30">
                                <Label htmlFor="anilist-service" className="text-sm font-medium cursor-pointer flex-1 flex items-center gap-2.5">
                                  <img 
                                    src="https://anilist.co/img/logo_al.png" 
                                    alt="AniList" 
                                    className="w-5 h-5 flex-shrink-0"
                                    onError={(e) => {
                                      (e.target as HTMLImageElement).style.display = 'none';
                                    }}
                                  />
                                  AniList
                                </Label>
                                <Switch
                                  id="anilist-service"
                                  checked={selectedServices.anilist}
                                  onCheckedChange={(checked) => 
                                    setSelectedServices(prev => ({ ...prev, anilist: checked }))
                                  }
                                />
                              </div>
                            )}
                            {availableServices.mdblist && (
                              <div className="flex items-center justify-between p-2.5 sm:p-3 rounded-lg bg-muted/30 dark:bg-muted/20 border border-border/30">
                                <Label htmlFor="mdblist-service" className="text-sm font-medium cursor-pointer flex-1 flex items-center gap-2.5">
                                  <img 
                                    src="https://mdblist.com/static/mdblist.png" 
                                    alt="MDBList" 
                                    className="w-5 h-5 flex-shrink-0"
                                    onError={(e) => {
                                      (e.target as HTMLImageElement).style.display = 'none';
                                    }}
                                  />
                                  MDBList
                                </Label>
                                <Switch
                                  id="mdblist-service"
                                  checked={selectedServices.mdblist}
                                  onCheckedChange={(checked) => 
                                    setSelectedServices(prev => ({ ...prev, mdblist: checked }))
                                  }
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      
                      {/* Submit Button */}
                      <Button 
                        type="submit" 
                        className="w-full h-11 sm:h-12 text-sm sm:text-base font-semibold bg-gradient-to-r from-cyan-500 to-cyan-600 dark:from-cyan-600 dark:to-cyan-700 hover:from-cyan-600 hover:to-cyan-700 dark:hover:from-cyan-700 dark:hover:to-cyan-800 text-white dark:text-white shadow-lg hover:shadow-xl transition-shadow duration-300 disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation" 
                        disabled={submitting || (!selectedServices.trakt && !selectedServices.anilist && !selectedServices.mdblist)}
                        size="lg"
                      >
                        {submitting ? (
                          <span className="flex items-center gap-2">
                            <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Submitting...
                          </span>
                        ) : (
                          "Send Rating"
                        )}
                      </Button>
                      
                      {/* Result Message */}
                      {result && (
                        <div className={`mt-2 p-2.5 sm:p-3 rounded-lg text-center text-xs sm:text-sm font-medium transition-all duration-300 ${
                          result.includes("Error") || result.includes("Failed") 
                            ? "bg-red-500/10 dark:bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/20 dark:border-red-500/30" 
                            : "bg-green-500/10 dark:bg-green-500/20 text-green-600 dark:text-green-400 border border-green-500/20 dark:border-green-500/30"
                        }`}>
                          {result}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </form>
            </div>
          </div>
      </Card>
      </div>
    </div>
  );
}
