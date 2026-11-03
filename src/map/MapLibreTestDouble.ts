export type EventListener = (event: any) => void;

export class TestGeoJSONSource {
  data: unknown;
  constructor(data: unknown) { this.data = data; }
  setData(data: unknown) { this.data = data; }
}

export class TestMap {
  static instances: TestMap[] = [];
  handlers = new Map<string, EventListener[]>();
  sources = new Map<string, TestGeoJSONSource>();
  layers: unknown[] = [];
  controls: unknown[] = [];
  removed = false;
  cameraMoves: unknown[] = [];
  constructor(public options: Record<string, unknown>) {
    TestMap.instances.push(this);
    queueMicrotask(() => this.fire('load'));
  }
  addControl(control: unknown) { this.controls.push(control); return this; }
  on(event: string, listener: EventListener) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }
  addSource(id: string, spec: { data: unknown }) { this.sources.set(id, new TestGeoJSONSource(spec.data)); }
  addLayer(layer: unknown) { this.layers.push(layer); }
  getSource(id: string) { return this.sources.get(id); }
  fire(event: string, detail: Record<string, unknown> = {}) {
    for (const listener of this.handlers.get(event) ?? []) listener({ target: this, ...detail });
  }
  flyTo(options: unknown) { this.cameraMoves.push(options); }
  resize() {}
  remove() { this.removed = true; }
}

export class NavigationControl {
  constructor(public options?: unknown) {}
}

export function resetTestMaps() { TestMap.instances = []; }
