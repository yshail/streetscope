/* Shapes of the files written by the Streetscope pipeline (web/data/<site>/twin.json and friends). */

export type XZ = [number, number]

export interface Road {
  id: number; highway: string; cls: 'main' | 'mid' | 'local' | 'walk'; name: string | null
  lanes: number | null; width_m: number; width_source: 'osm_width' | 'lanes' | 'default'
  oneway: boolean; bridge: boolean; pts: XZ[]
}
export interface Building { id: number; height_m: number; height_source: string; kind?: string; name?: string | null; footprint: XZ[] }
export interface Tree { x: number; z: number; height_m: number; crown_r: number; source: string }
export interface Spot { x: number; z: number; name?: string }

export interface Scenario {
  id: string; name: string; why: string; trees_added: Tree[]; footpath_strip_m: number
  walk_shade_pct: (number | null)[]; day_mean_shade_pct: number; baseline_day_mean_shade_pct: number
  shaded_walk_m2_day_mean: number; baseline_shaded_walk_m2_day_mean: number; extra_walk_m2: number
  cost_inr: number; cost_basis: string; assumptions: string; files: { shade: string; walk: string }
}

export interface TrafficLink { id: number; r: number; c: string; n: string | null; lanes: number; pts: XZ[] }
export interface TrafficArea {
  id: number; x: number; z: number; lat: number; lon: number; score: number; load_ratio: number; links: number[]
  roads: string[]; crossings: number; bus_stops: number; signals: number; reasons: string[]; severity: 'low' | 'medium' | 'high'
}
export interface TrafficSolution {
  area_id: number; kind: 'bus_lane' | 'signal_retiming' | 'foot_overbridge' | 'route_diversion' | 'add_lane'; link_id: number
  title: string; what: string; assumption: string; area_load_before: number; area_load_after: number
  area_load_change_pct: number; network_delay_change_pct: number; cost_lakh: number; cost_basis: string; recommended: boolean
}
export interface Traffic {
  method: { kind: string; demand: string; scaling: string; capacity: string; limits: string }
  summary: { links: number; links_over_capacity: number; links_over_80pct: number; p95_ratio: number; max_ratio: number }
  links: TrafficLink[]; areas: TrafficArea[]; solutions: TrafficSolution[]
}

export interface ShadeMeta {
  file: string; walk_file: string; shape: [number, number, number]; cell_m: number; origin: XZ
  hours: number[]; sun: { el: number; az: number }[]; walk_shade_pct: (number | null)[]; date: string; walk_cells: number
}

export interface Twin {
  meta: { name: string; center: { lat: number; lon: number }; radius_m: number; attribution: string; data_level?: number; signals_queried?: boolean }
  roads: Road[]; buildings: Building[]; trees: Tree[]; stops: Spot[]; crossings: Spot[]; ev: Spot[]; signals: Spot[]
  stats: {
    road_ways: number; road_km: Record<string, number>; road_width_sources: Record<string, number>; buildings: number
    building_height_sources: Record<string, number>; trees: number; bus_stops: number; crossings: number; gaps: string[]
    lidar?: { project: string; buildings_measured: number; buildings_total: number; tree_tops_found: number; canopy_cover_pct: number }
    canopy?: { canopy_cover_pct: number; tree_tops_found: number; osm_trees: number; map_error_m?: number }
  }
  shade: ShadeMeta; scenarios: Scenario[]; traffic: Traffic | null
}

export interface SiteRef { id: string; name: string; twin: string }

export interface Site {
  id: string; ref: SiteRef; twin: Twin
  stack: Uint8Array      // shade class per hour per cell: 255 sun, 90 tree shade, 0 building shadow, 1 inside a building
  walk: Uint8Array       // 1 where people walk
  scen: Record<string, { stack: Uint8Array; walk: Uint8Array }>
}

/* What the user can select in the scene */
export type Selection =
  | { kind: 'junction'; id: number }
  | { kind: 'road'; id: number }
  | { kind: 'building'; id: number }
  | { kind: 'tree'; index: number }
  | { kind: 'stop'; index: number }
  | { kind: 'ev'; index: number }
  | null

/* Every number on screen says where it came from */
export type Basis = 'observed' | 'computed' | 'simulated' | 'proposed' | 'assumed' | 'live'
