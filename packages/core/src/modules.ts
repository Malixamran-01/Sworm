import { NodeCallError, type AgentSkill, type KnowledgeSource, type ModuleDto, type ModelInfo, type ToolInfo, type WorkflowInfo } from "@conclave/contract";
import type { ConclaveModule, ModuleInstance, ModuleManifest } from "@conclave/module-sdk";

/** Installed modules. Core never refers to one by product name (MOD-001). */
export class ModuleRegistry {
  private readonly modules = new Map<string, ConclaveModule>();
  private readonly sources = new Map<string, ModuleDto["source"]>();

  constructor(modules: ConclaveModule[] = []) {
    for (const m of modules) this.install(m);
  }

  /** Add a module. Ones the server admin added later are marked "installed" (MOD-002). */
  install(mod: ConclaveModule, source: ModuleDto["source"] = "built-in"): void {
    this.modules.set(mod.manifest.id, mod);
    this.sources.set(mod.manifest.id, source);
  }

  /** Take a module out. Connections to it fail with "not installed" until it is back. */
  remove(id: string): void {
    this.modules.delete(id);
    this.sources.delete(id);
  }

  get(id: string): ConclaveModule {
    const mod = this.modules.get(id);
    if (!mod) throw new NodeCallError("not_found", `Module "${id}" is not installed.`, false);
    return mod;
  }

  has(id: string): boolean {
    return this.modules.has(id);
  }

  list(): ModuleDto[] {
    return [...this.modules.values()].map((m) => toModuleDto(m.manifest, this.sources.get(m.manifest.id)));
  }
}

export function toModuleDto(manifest: ModuleManifest, source: ModuleDto["source"] = "built-in"): ModuleDto {
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    ports: manifest.ports,
    docks: manifest.docks,
    reference: manifest.reference,
    permissions: { egress: [...manifest.permissions.egress], secrets: [...manifest.permissions.secrets] },
    source,
    configFields: manifest.config.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      ...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {}),
      ...(f.help !== undefined ? { help: f.help } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
    })),
  };
}

/**
 * Hosts a module may reach (MOD-010): "{config.key}" is the host of that URL
 * setting, and "{config.key[]}" a comma-separated list of hosts in that setting.
 */
export function allowedHosts(manifest: ModuleManifest, config: Record<string, unknown>): Set<string> {
  const hosts = new Set<string>();
  for (const entry of manifest.permissions.egress) {
    const list = /^\{config\.([A-Za-z0-9_]+)\[\]\}$/.exec(entry);
    if (list) {
      const value = config[list[1]!];
      if (typeof value === "string") for (const h of value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) hosts.add(h);
      continue;
    }
    const placeholder = /^\{config\.([A-Za-z0-9_]+)\}$/.exec(entry);
    if (placeholder) {
      const value = config[placeholder[1]!];
      if (typeof value === "string" && value) {
        try {
          hosts.add(new URL(value).host);
        } catch {
          /* invalid URLs are rejected when the connection is saved */
        }
      }
    } else {
      hosts.add(entry);
    }
  }
  return hosts;
}

export function egressFetch(manifest: ModuleManifest, config: Record<string, unknown>, base: typeof fetch = fetch): typeof fetch {
  const hosts = allowedHosts(manifest, config);
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!hosts.has(url.host)) {
      throw new NodeCallError(
        "invalid_request",
        `Module ${manifest.id} tried to reach ${url.host}, which its manifest does not declare.`,
        false,
      );
    }
    return base(input, init);
  }) as typeof fetch;
}

/** Live module instances, one per connection, rebuilt when the connection changes. */
export class ModuleRuntime {
  private readonly instances = new Map<string, { stamp: string; instance: ModuleInstance }>();
  private readonly modelCache = new Map<string, { at: number; models: ModelInfo[] }>();
  private readonly toolCache = new Map<string, { at: number; tools: ToolInfo[] }>();
  private readonly skillCache = new Map<string, { at: number; skills: AgentSkill[] }>();
  private readonly workflowCache = new Map<string, { at: number; workflows: WorkflowInfo[] }>();
  private readonly sourceCache = new Map<string, { at: number; sources: KnowledgeSource[] }>();

  get(connectionId: string, stamp: string, build: () => ModuleInstance): ModuleInstance {
    const cached = this.instances.get(connectionId);
    if (cached && cached.stamp === stamp) return cached.instance;
    void cached?.instance.close?.();
    const instance = build();
    this.instances.set(connectionId, { stamp, instance });
    this.modelCache.delete(connectionId);
    this.toolCache.delete(connectionId);
    return instance;
  }

  async models(connectionId: string, instance: ModuleInstance): Promise<ModelInfo[]> {
    const cached = this.modelCache.get(connectionId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.models;
    const models = (await instance.ports.model?.listModels()) ?? [];
    this.modelCache.set(connectionId, { at: Date.now(), models });
    return models;
  }

  async tools(connectionId: string, instance: ModuleInstance): Promise<ToolInfo[]> {
    const cached = this.toolCache.get(connectionId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.tools;
    const tools = (await instance.ports.tool?.listTools()) ?? [];
    this.toolCache.set(connectionId, { at: Date.now(), tools });
    return tools;
  }

  async skills(connectionId: string, instance: ModuleInstance): Promise<AgentSkill[]> {
    const cached = this.skillCache.get(connectionId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.skills;
    const skills = (await instance.ports.agent?.listSkills()) ?? [];
    this.skillCache.set(connectionId, { at: Date.now(), skills });
    return skills;
  }

  async workflows(connectionId: string, instance: ModuleInstance): Promise<WorkflowInfo[]> {
    const cached = this.workflowCache.get(connectionId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.workflows;
    const workflows = (await instance.ports.workflow?.listWorkflows()) ?? [];
    this.workflowCache.set(connectionId, { at: Date.now(), workflows });
    return workflows;
  }

  async sources(connectionId: string, instance: ModuleInstance): Promise<KnowledgeSource[]> {
    const cached = this.sourceCache.get(connectionId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.sources;
    const sources = (await instance.ports.knowledge?.listSources()) ?? [];
    this.sourceCache.set(connectionId, { at: Date.now(), sources });
    return sources;
  }

  /** Lists are read again on next use. */
  forgetLists(connectionId: string): void {
    this.sourceCache.delete(connectionId);
    this.modelCache.delete(connectionId);
    this.toolCache.delete(connectionId);
    this.skillCache.delete(connectionId);
    this.workflowCache.delete(connectionId);
  }

  evict(connectionId: string): void {
    this.forgetLists(connectionId);
    this.toolCache.delete(connectionId);
    const cached = this.instances.get(connectionId);
    void cached?.instance.close?.();
    this.instances.delete(connectionId);
    this.modelCache.delete(connectionId);
  }
}
