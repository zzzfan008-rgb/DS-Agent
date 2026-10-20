/**
 * 极简 Prometheus 指标注册表（t2 的 /metrics 骨架）。
 * 不引入 prom-client：M1 只需要计数器/求和，后续换成 prom-client 时保持同名指标即可。
 */
interface Sample {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'summary';
  labels: Record<string, string>;
  value: number;
  count?: number;
}

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(',');
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
}

export class MetricsRegistry {
  private readonly samples = new Map<string, Sample>();

  inc(name: string, help: string, labels: Record<string, string> = {}, value = 1): void {
    this.upsert(name, help, 'counter', labels, value);
  }

  set(name: string, help: string, labels: Record<string, string> = {}, value = 0): void {
    const key = `${name}|${labelKey(labels)}|gauge`;
    this.samples.set(key, { name, help, type: 'gauge', labels, value });
  }

  /** summary 风格：同时记录 sum 与 count，render 时输出两行。 */
  observe(name: string, help: string, labels: Record<string, string> = {}, value = 0): void {
    const key = `${name}|${labelKey(labels)}|summary`;
    const existing = this.samples.get(key);
    if (existing) {
      existing.value += value;
      existing.count = (existing.count ?? 0) + 1;
      return;
    }
    this.samples.set(key, { name, help, type: 'summary', labels, value, count: 1 });
  }

  private upsert(
    name: string,
    help: string,
    type: Sample['type'],
    labels: Record<string, string>,
    value: number,
  ): void {
    const key = `${name}|${labelKey(labels)}|${type}`;
    const existing = this.samples.get(key);
    if (existing) {
      existing.value += value;
      return;
    }
    this.samples.set(key, { name, help, type, labels, value });
  }

  render(): string {
    const lines: string[] = [];
    const grouped = new Map<string, Sample[]>();
    for (const sample of this.samples.values()) {
      const list = grouped.get(sample.name) ?? [];
      list.push(sample);
      grouped.set(sample.name, list);
    }
    for (const name of [...grouped.keys()].sort()) {
      const samples = grouped.get(name)!;
      const first = samples[0]!;
      lines.push(`# HELP ${name} ${first.help}`);
      lines.push(`# TYPE ${name} ${first.type}`);
      for (const sample of samples) {
        if (sample.type === 'summary') {
          lines.push(`${name}_sum${renderLabels(sample.labels)} ${sample.value}`);
          lines.push(`${name}_count${renderLabels(sample.labels)} ${sample.count ?? 0}`);
        } else {
          lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
