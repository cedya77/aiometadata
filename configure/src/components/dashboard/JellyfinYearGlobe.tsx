import { useEffect, useRef } from "react";
import { geoCentroid, geoGraticule10, geoOrthographic, geoPath, type GeoPermissibleObjects } from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import world from "world-atlas/countries-110m.json";

const SIZE = 220;
const MAX_DPR = 2;
const SPIN_DEG_PER_S = 7;
const TILT = -18;
const DRAG_DEG_PER_PX = 0.4;
const RANK_FILLS = ["#60a5fa", "#fbbf24"];
const TOP_FILL = "rgba(147,197,253,0.6)";
const SEEN_FILL = "rgba(147,197,253,0.28)";
const LAND_FILL = "rgba(255,255,255,0.08)";
const BORDER = "rgba(12,13,15,0.85)";

type Land = { type: "Feature"; id?: string | number; properties: { name: string }; geometry: GeoPermissibleObjects };

let lands: Land[] | null = null;

function landsOf(): Land[] {
  if (!lands) {
    const topology = world as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
    lands = (feature(topology, topology.objects.countries) as unknown as { features: Land[] }).features;
  }
  return lands;
}

export interface GlobeCountry {
  rank: number;
  shaded: boolean;
}

export default function Globe({ countries, codeOf }: { countries: Map<string, GlobeCountry>; codeOf: (name: string) => string | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    element.width = SIZE * dpr;
    element.height = SIZE * dpr;
    context.scale(dpr, dpr);

    const radius = SIZE / 2 - 6;
    const projection = geoOrthographic().scale(radius).translate([SIZE / 2, SIZE / 2]).clipAngle(90).precision(0.6);
    const path = geoPath(projection, context);
    const graticule = geoGraticule10();
    let focus: [number, number] | null = null;
    const painted = landsOf().map((land) => {
      const found = countries.get(codeOf(land.properties.name) ?? "");
      if (found?.rank === 0) focus = geoCentroid(land as never) as [number, number];
      return { land, fill: !found ? LAND_FILL : found.rank < RANK_FILLS.length ? RANK_FILLS[found.rank] : found.shaded ? TOP_FILL : SEEN_FILL };
    }).sort((a, b) => Number(a.fill !== LAND_FILL) - Number(b.fill !== LAND_FILL));
    const sphere = context.createRadialGradient(SIZE * 0.38, SIZE * 0.32, radius * 0.1, SIZE / 2, SIZE / 2, radius);
    sphere.addColorStop(0, "rgba(96,165,250,0.16)");
    sphere.addColorStop(1, "rgba(12,13,15,0.95)");

    const centre = focus as [number, number] | null;
    let lambda = centre ? -centre[0] : 0;
    const phi = centre ? Math.max(-35, Math.min(35, -centre[1] * 0.6)) + TILT * 0.4 : TILT;
    const draw = () => {
      projection.rotate([lambda, phi]);
      context.clearRect(0, 0, SIZE, SIZE);
      context.beginPath();
      path({ type: "Sphere" });
      context.fillStyle = sphere;
      context.fill();
      context.beginPath();
      path(graticule);
      context.strokeStyle = "rgba(255,255,255,0.05)";
      context.lineWidth = 0.6;
      context.stroke();
      for (const { land, fill } of painted) {
        context.beginPath();
        path(land.geometry);
        context.fillStyle = fill;
        context.fill();
        context.strokeStyle = BORDER;
        context.lineWidth = 0.5;
        context.stroke();
      }
      context.beginPath();
      path({ type: "Sphere" });
      context.strokeStyle = "rgba(147,197,253,0.35)";
      context.lineWidth = 1;
      context.stroke();
    };

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let last = 0;
    let onScreen = false;
    let dragging: { x: number; lambda: number } | null = null;
    const tick = (now: number) => {
      frame = 0;
      if (!onScreen || document.hidden) return;
      if (!dragging) lambda += ((now - (last || now)) / 1000) * SPIN_DEG_PER_S;
      last = now;
      draw();
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (still || frame || !onScreen || document.hidden) return;
      last = 0;
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    draw();

    const watcher = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) start();
      else stop();
    });
    watcher.observe(element);
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    const onDown = (event: PointerEvent) => {
      dragging = { x: event.clientX, lambda };
      element.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      lambda = dragging.lambda + (event.clientX - dragging.x) * DRAG_DEG_PER_PX;
      if (still || !frame) draw();
    };
    const onUp = () => {
      dragging = null;
    };
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);

    return () => {
      stop();
      watcher.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onUp);
    };
  }, [countries, codeOf]);

  return <canvas ref={canvas} role="img" aria-label="A globe shaded by where your titles come from" className="h-[220px] w-[220px] cursor-grab touch-pan-y active:cursor-grabbing" />;
}
