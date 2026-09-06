import { BadRequestException, Injectable, Logger } from '@nestjs/common';

export type TransformerFn = (...args: any[]) => any;

@Injectable()
export class VersioningService {
  private readonly logger = new Logger(VersioningService.name);
  private readonly registry = new Map<string, Map<number, TransformerFn>>();

  register(namespace: string, versions: Record<number, TransformerFn>): void {
    const map: Map<number, TransformerFn> =
      this.registry.get(namespace) ?? new Map();

    for (const [version, fn] of Object.entries(versions)) {
      map.set(Number(version), fn);
    }

    this.registry.set(namespace, map);
    this.logger.log(
      `Registered "${namespace}" with versions: [${[...map.keys()].sort().join(', ')}]`,
    );
  }

  registerAll(
    prefix: string,
    map: Record<string, Record<number, TransformerFn>>,
  ): void {
    for (const [key, versions] of Object.entries(map)) {
      this.register(`${prefix}.${key}`, versions);
    }
  }

  resolve(req: any, namespace: string): TransformerFn {
    const map = this.registry.get(namespace);

    if (!map || map.size === 0) {
      throw new BadRequestException(
        `No transformers registered for "${namespace}"`,
      );
    }

    const latest = Math.max(...map.keys());
    const header = req?.headers?.['x-api-version'];

    if (!header) {
      return map.get(latest)!;
    }

    const v = Number(header);
    if (!v || !Number.isInteger(v)) {
      throw new BadRequestException(
        `Invalid API version "${header}". Must be an integer.`,
      );
    }

    if (!map.has(v)) {
      const available = [...map.keys()].sort((a, b) => a - b).join(', ');
      throw new BadRequestException(
        `API version ${v} does not exist. Available versions: [${available}]`,
      );
    }

    return map.get(v)!;
  }

  getRegisteredNamespaces(): string[] {
    return [...this.registry.keys()];
  }

  getVersions(namespace: string): number[] {
    const map = this.registry.get(namespace);
    return map ? [...map.keys()].sort((a, b) => a - b) : [];
  }
}
