interface BenchBridge {
  saveReport(name: string, json: string, markdown: string): Promise<void>;
  setCpuThrottle(rate: number): Promise<void>;
  displayInfo(): Promise<string>;
  appendRun(json: string): Promise<void>;
  loadRuns(): Promise<string>;
  quit(): void;
}

interface Window {
  bench: BenchBridge;
}
